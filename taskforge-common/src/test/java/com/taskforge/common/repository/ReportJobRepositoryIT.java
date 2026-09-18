package com.taskforge.common.repository;

import com.taskforge.common.EmulatorSupport;
import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Runs against LocalStack (Testcontainers) or the emulator named by AWS_ENDPOINT_OVERRIDE. */
class ReportJobRepositoryIT {

    private static final Instant T0 = Instant.parse("2026-09-18T12:00:00Z");

    private static ReportJobRepository repository;
    private static DynamoDbClient dynamoDb;
    private static TaskForgeProperties properties;

    @BeforeAll
    static void createTable() {
        properties = EmulatorSupport.uniqueProperties("repo-it");
        dynamoDb = EmulatorSupport.awsConfig().dynamoDbClient();
        repository = new ReportJobRepository(dynamoDb, properties);
        repository.init();
        // A second init must be harmless: the table exists and TTL is already enabled.
        repository.init();
    }

    private static ReportJob job(String key) {
        return ReportJob.create(ReportType.SALES_SUMMARY, Map.of("region", "North"), "cid-" + UUID.randomUUID(),
                key, 3, T0.plusSeconds(86_400).getEpochSecond(), T0);
    }

    @Test
    void roundTripsEveryField() {
        ReportJob job = job("rt-" + UUID.randomUUID());
        repository.create(job);
        job.markQueued(T0.plusSeconds(1));
        repository.update(job);
        job.markProcessing("worker-x", T0.plusSeconds(2));
        repository.update(job);
        job.markRetryScheduled("timeout", T0.plusSeconds(9), T0.plusSeconds(3));
        repository.update(job);

        ReportJob stored = repository.findById(job.getId()).orElseThrow();
        assertThat(stored.getStatus()).isEqualTo(ReportStatus.RETRY_SCHEDULED);
        assertThat(stored.getVersion()).isEqualTo(3);
        assertThat(stored.getAttemptCount()).isEqualTo(1);
        assertThat(stored.getParameters()).containsExactlyEntriesOf(Map.of("region", "North"));
        assertThat(stored.getErrorMessage()).isEqualTo("timeout");
        assertThat(stored.getNextAttemptAt()).isEqualTo(T0.plusSeconds(9));
        assertThat(stored.getIdempotencyKey()).isEqualTo(job.getIdempotencyKey());
        assertThat(stored.getCorrelationId()).isEqualTo(job.getCorrelationId());
        assertThat(stored.getLockedBy()).isNull();
        assertThat(stored.getCreatedAt()).isEqualTo(T0);
        assertThat(stored.getTtl()).isEqualTo(job.getTtl());
    }

    @Test
    void secondSubmissionWithTheSameKeyIsRejectedWithTheOriginalId() {
        String key = "dup-" + UUID.randomUUID();
        ReportJob first = job(key);
        repository.create(first);

        assertThatThrownBy(() -> repository.create(job(key)))
                .isInstanceOf(DuplicateReportException.class)
                .satisfies(e -> assertThat(((DuplicateReportException) e).getExistingId()).isEqualTo(first.getId()));
        assertThat(repository.findJobIdByIdempotencyKey(key)).contains(first.getId());
    }

    @Test
    void manyConcurrentCreatesWithOneKeyProduceExactlyOneJob() throws Exception {
        String key = "race-" + UUID.randomUUID();
        int threads = 20;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Optional<String>>> results = new ArrayList<>();
        try {
            for (int i = 0; i < threads; i++) {
                results.add(pool.submit(() -> {
                    ReportJob job = job(key);
                    start.await();
                    try {
                        repository.create(job);
                        return Optional.of(job.getId());
                    } catch (DuplicateReportException e) {
                        return Optional.<String>empty();
                    }
                }));
            }
            start.countDown();
            List<String> created = new ArrayList<>();
            for (Future<Optional<String>> f : results) {
                f.get(30, TimeUnit.SECONDS).ifPresent(created::add);
            }
            assertThat(created).as("exactly one submission may win the key").hasSize(1);
            assertThat(repository.findJobIdByIdempotencyKey(key)).contains(created.get(0));
            Set<String> jobsWithKey = repository.findAll(1_000).stream()
                    .filter(j -> key.equals(j.getIdempotencyKey())).map(ReportJob::getId).collect(Collectors.toSet());
            assertThat(jobsWithKey).containsExactly(created.get(0));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void staleWritersCannotOverwriteNewerState() {
        ReportJob job = job(null);
        repository.create(job);
        job.markQueued(T0);
        repository.update(job);

        ReportJob workerA = repository.findById(job.getId()).orElseThrow();
        ReportJob workerB = repository.findById(job.getId()).orElseThrow();

        workerA.markProcessing("a", T0);
        repository.update(workerA);
        workerA.markCompleted("reports/a.csv", 5, T0);
        repository.update(workerA);

        workerB.markProcessing("b", T0);
        assertThatThrownBy(() -> repository.update(workerB)).isInstanceOf(StaleJobException.class);

        ReportJob stored = repository.findById(job.getId()).orElseThrow();
        assertThat(stored.getStatus()).isEqualTo(ReportStatus.COMPLETED);
        assertThat(stored.getFileKey()).isEqualTo("reports/a.csv");
    }

    @Test
    void deletingAJobFreesItsKey() {
        String key = "free-" + UUID.randomUUID();
        ReportJob job = job(key);
        repository.create(job);
        repository.delete(job.getId(), key);
        assertThat(repository.findById(job.getId())).isEmpty();
        assertThat(repository.findJobIdByIdempotencyKey(key)).isEmpty();
        repository.create(job(key));
    }

    @Test
    void listsNewestFirstWithoutKeyMarkersAndHonoursTheLimit() {
        List<ReportJob> mine = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            ReportJob job = ReportJob.create(ReportType.USER_ACTIVITY, Map.of(), "list-cid", "list-" + UUID.randomUUID(),
                    3, T0.getEpochSecond(), T0.plusSeconds(i));
            repository.create(job);
            mine.add(job);
        }
        List<ReportJob> all = repository.findAll(10_000);
        assertThat(all).allSatisfy(j -> assertThat(j.getId()).doesNotStartWith(ReportJobRepository.KEY_PREFIX));
        List<Instant> mineOrdered = all.stream().filter(j -> "list-cid".equals(j.getCorrelationId()))
                .map(ReportJob::getCreatedAt).toList();
        List<Instant> expected = new ArrayList<>(mineOrdered);
        expected.sort(Collections.reverseOrder());
        assertThat(mineOrdered).hasSize(5).isEqualTo(expected);
        assertThat(repository.findAll(2)).hasSize(2);

        List<ReportJob> accepted = repository.findByStatus(ReportStatus.ACCEPTED, 10_000);
        assertThat(accepted).extracting(ReportJob::getId).containsAll(mine.stream().map(ReportJob::getId).toList());
    }

    @Test
    void keyMarkerIdsAreNeverResolvedAsJobs() {
        assertThat(repository.findById(ReportJobRepository.KEY_PREFIX + "anything")).isEmpty();
    }
}
