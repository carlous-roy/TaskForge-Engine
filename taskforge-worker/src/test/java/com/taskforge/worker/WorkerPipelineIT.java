package com.taskforge.worker;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportGenerationException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.testsupport.AwsEmulator;
import com.taskforge.worker.report.SalesSummaryGenerator;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetObjectTaggingRequest;
import software.amazon.awssdk.services.s3.model.Tag;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * The whole worker against the emulator: poller, processor, dead-letter consumer, DynamoDB, SQS
 * and S3. Backoff is capped at one second so the retry path runs in seconds.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "taskforge.retry.backoff.base=1s",
        "taskforge.retry.backoff.cap=1s",
        "taskforge.sqs.wait-time=1s",
        "taskforge.sqs.visibility-timeout=20s",
        "taskforge.worker.idle-wait=100ms",
        "taskforge.worker.dead-letter.poll-interval=500ms",
        "taskforge.worker.id=worker-it"
})
class WorkerPipelineIT {

    @DynamicPropertySource
    static void emulator(DynamicPropertyRegistry registry) {
        AwsEmulator.get().springProperties().forEach((k, v) -> registry.add(k, () -> v));
        registry.add("taskforge.dynamodb.table", () -> AwsEmulator.uniqueName("worker-it"));
        registry.add("taskforge.sqs.queue", () -> AwsEmulator.uniqueName("worker-it"));
        registry.add("taskforge.sqs.dlq", () -> AwsEmulator.uniqueName("worker-it-dlq"));
        registry.add("taskforge.s3.bucket", () -> AwsEmulator.uniqueName("worker-it"));
    }

    @Autowired ReportJobRepository repository;
    @Autowired QueueService queueService;
    @Autowired S3Client s3;
    @Autowired TaskForgeProperties properties;
    @MockitoSpyBean SalesSummaryGenerator salesGenerator;

    @AfterEach
    void resetSpy() {
        Mockito.reset(salesGenerator);
    }

    private ReportJob submit(ReportType type, Map<String, String> parameters) {
        Instant now = Instant.now();
        ReportJob job = ReportJob.create(type, parameters, "it-" + UUID.randomUUID().toString().substring(0, 8), null,
                properties.getRetry().getMaxAttempts(), now.plusSeconds(3600).getEpochSecond(), now);
        repository.create(job);
        queueService.enqueue(job.getId(), job.getCorrelationId());
        job.markQueued(now);
        repository.update(job);
        return job;
    }

    private ReportJob awaitJob(String id, Predicate<ReportJob> condition, Duration timeout) {
        return Awaitility.await().atMost(timeout).pollInterval(Duration.ofMillis(250))
                .until(() -> repository.findById(id).orElseThrow(), condition::test);
    }

    @Test
    void goodJobCompletesWithATaggedObjectInS3() {
        ReportJob job = submit(ReportType.INVENTORY_SNAPSHOT, Map.of("warehouse", "WH-WEST"));

        ReportJob done = awaitJob(job.getId(), j -> j.getStatus() == ReportStatus.COMPLETED, Duration.ofSeconds(30));

        assertThat(done.getAttemptCount()).isEqualTo(1);
        assertThat(done.getFileKey()).isEqualTo("reports/inventory_snapshot/" + job.getId() + ".csv");
        assertThat(done.getExecutionTimeMs()).isGreaterThanOrEqualTo(0);
        var tags = s3.getObjectTagging(GetObjectTaggingRequest.builder()
                .bucket(properties.getS3().getBucket()).key(done.getFileKey()).build()).tagSet();
        assertThat(tags).extracting(Tag::key, Tag::value)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("correlation-id", job.getCorrelationId()));
        Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> queueService.queueDepth() == 0);
    }

    @Test
    void transientFailuresAreRetriedWithBackoffThenDeadLettered() {
        doThrow(new ReportGenerationException("simulated outage", true)).when(salesGenerator).generate(any());
        ReportJob job = submit(ReportType.SALES_SUMMARY, Map.of("region", "East"));

        ReportJob retrying = awaitJob(job.getId(), j -> j.getStatus() == ReportStatus.RETRY_SCHEDULED, Duration.ofSeconds(30));
        assertThat(retrying.getAttemptCount()).isEqualTo(1);
        assertThat(retrying.getErrorMessage()).isEqualTo("Attempt 1 failed: simulated outage");
        assertThat(retrying.getNextAttemptAt()).isNotNull();

        ReportJob dead = awaitJob(job.getId(),
                j -> j.getStatus() == ReportStatus.FAILED && j.getDeadLetteredAt() != null, Duration.ofSeconds(60));
        assertThat(dead.getAttemptCount()).isEqualTo(3);
        assertThat(dead.getErrorMessage()).contains("Attempt 3 of 3 failed: simulated outage").contains("dead-letter queue");
        verify(salesGenerator, times(3)).generate(any());

        // The dead-letter consumer acknowledged the message: nothing is left in either queue.
        Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> queueService.deadLetterDepth() == 0 && queueService.queueDepth() == 0);
    }

    @Test
    void permanentFailureFailsOnTheFirstAttemptAndNeverReachesTheDeadLetterQueue() {
        doThrow(new ReportGenerationException("corrupt template", false)).when(salesGenerator).generate(any());
        ReportJob job = submit(ReportType.SALES_SUMMARY, Map.of());

        ReportJob failed = awaitJob(job.getId(), j -> j.getStatus() == ReportStatus.FAILED, Duration.ofSeconds(30));

        assertThat(failed.getAttemptCount()).isEqualTo(1);
        assertThat(failed.getErrorMessage()).contains("non-retryable").contains("corrupt template");
        assertThat(failed.getDeadLetteredAt()).isNull();
        verify(salesGenerator, times(1)).generate(any());
        Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> queueService.queueDepth() == 0);
        assertThat(queueService.deadLetterDepth()).isZero();
    }
}
