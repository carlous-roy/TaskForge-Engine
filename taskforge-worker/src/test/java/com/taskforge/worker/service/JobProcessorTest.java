package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportGenerationException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.report.ReportParameters;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import com.taskforge.common.service.StorageService;
import com.taskforge.worker.report.ReportGenerator;
import com.taskforge.worker.service.JobProcessor.Outcome;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.MDC;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class JobProcessorTest {

    private static final Instant NOW = Instant.parse("2026-09-18T12:00:00Z");

    private final ReportJobRepository repository = mock(ReportJobRepository.class);
    private final QueueService queueService = mock(QueueService.class);
    private final StorageService storageService = mock(StorageService.class);
    private final AtomicReference<Function<ReportParameters, byte[]>> generatorBehaviour = new AtomicReference<>();
    private final TaskForgeProperties properties = new TaskForgeProperties();
    private JobProcessor processor;

    @BeforeEach
    void setUp() {
        generatorBehaviour.set(p -> "a,b\r\n".getBytes());
        ReportGenerator generator = new ReportGenerator() {
            @Override public ReportType getType() { return ReportType.SALES_SUMMARY; }
            @Override public byte[] generate(ReportParameters parameters) { return generatorBehaviour.get().apply(parameters); }
        };
        properties.getWorker().setId("worker-test");
        properties.getSqs().setVisibilityTimeout(Duration.ofSeconds(120));
        processor = new JobProcessor(repository, queueService, storageService, List.of(generator), properties,
                new WorkerIdentity(properties), Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @AfterEach
    void clearMdc() {
        MDC.clear();
        Thread.interrupted(); // clear a flag left by the interrupt test
    }

    private ReportJob queuedJob() {
        ReportJob job = ReportJob.create(ReportType.SALES_SUMMARY, Map.of("region", "North"), "cid-job", null, 3, 1L, NOW.minusSeconds(10));
        job.setStatus(ReportStatus.QUEUED);
        job.setVersion(1);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        return job;
    }

    private static ReceivedMessage message(ReportJob job, int receiveCount) {
        return new ReceivedMessage("m-" + receiveCount, "rh-" + receiveCount, job.getId(), "cid-msg", receiveCount);
    }

    // ---- success -----------------------------------------------------------------------------

    @Test
    void completesTheJobUploadsWithTheCorrelationIdAndDeletesTheMessage() {
        ReportJob job = queuedJob();

        Outcome outcome = processor.process(message(job, 1));

        assertThat(outcome).isEqualTo(Outcome.COMPLETED);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.COMPLETED);
        assertThat(job.getAttemptCount()).isEqualTo(1);
        assertThat(job.getFileKey()).isEqualTo("reports/sales_summary/" + job.getId() + ".csv");
        verify(storageService).upload(eq(job.getFileKey()), any(), eq("text/csv"), eq("cid-job"));
        verify(repository, org.mockito.Mockito.times(2)).update(job);   // PROCESSING, then COMPLETED
        verify(queueService).delete("rh-1");
        verify(queueService, never()).changeVisibility(anyString(), anyInt());
        assertThat(MDC.get("cid")).as("MDC is cleared afterwards").isNull();
    }

    // ---- transient failure -------------------------------------------------------------------

    @Test
    void transientFailureSchedulesARetryThroughTheVisibilityTimeoutAndKeepsTheMessage() {
        ReportJob job = queuedJob();
        doThrow(S3Exception.builder().statusCode(503).message("slow down").build())
                .when(storageService).upload(anyString(), any(), anyString(), anyString());

        Outcome outcome = processor.process(message(job, 1));

        assertThat(outcome).isEqualTo(Outcome.RETRY_SCHEDULED);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.RETRY_SCHEDULED);
        assertThat(job.getErrorMessage()).startsWith("Attempt 1 failed: slow down");
        ArgumentCaptor<Integer> delay = ArgumentCaptor.forClass(Integer.class);
        verify(queueService).changeVisibility(eq("rh-1"), delay.capture());
        assertThat(delay.getValue()).isBetween(0, 4);
        assertThat(job.getNextAttemptAt()).isEqualTo(NOW.plusSeconds(delay.getValue()));
        verify(queueService, never()).delete(anyString());
        verify(queueService, never()).enqueue(anyString(), anyString());
    }

    @Test
    void visibilityTimeoutSentToSqsVariesAcrossFailuresAndStaysInsideTheWindow() {
        doThrow(new ReportGenerationException("dependency timed out", true))
                .when(storageService).upload(anyString(), any(), anyString(), anyString());

        Set<Integer> firstAttemptDelays = new HashSet<>();
        Set<Integer> secondAttemptDelays = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            reset(queueService);
            ReportJob job = queuedJob();
            processor.process(message(job, 1));
            ArgumentCaptor<Integer> delay = ArgumentCaptor.forClass(Integer.class);
            verify(queueService).changeVisibility(anyString(), delay.capture());
            assertThat(delay.getValue()).isBetween(0, 4);
            firstAttemptDelays.add(delay.getValue());

            reset(queueService);
            job.setStatus(ReportStatus.RETRY_SCHEDULED);
            processor.process(message(job, 2));
            verify(queueService).changeVisibility(anyString(), delay.capture());
            assertThat(delay.getValue()).isBetween(0, 8);
            secondAttemptDelays.add(delay.getValue());
        }
        assertThat(firstAttemptDelays).as("attempt 1 delays 0-4 s").hasSizeGreaterThan(2);
        assertThat(secondAttemptDelays).as("attempt 2 delays 0-8 s").hasSizeGreaterThan(3);
        assertThat(secondAttemptDelays.stream().mapToInt(Integer::intValue).max().orElse(0)).isGreaterThan(4);
    }

    @Test
    void lastAttemptFailsTheJobAndReleasesTheMessageForTheDeadLetterQueue() {
        ReportJob job = queuedJob();
        job.setAttemptCount(2);
        job.setStatus(ReportStatus.RETRY_SCHEDULED);
        doThrow(new ReportGenerationException("still broken", true))
                .when(storageService).upload(anyString(), any(), anyString(), anyString());

        Outcome outcome = processor.process(message(job, 3));

        assertThat(outcome).isEqualTo(Outcome.FAILED);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.FAILED);
        assertThat(job.getAttemptCount()).isEqualTo(3);
        assertThat(job.getErrorMessage()).contains("Attempt 3 of 3 failed: still broken").contains("dead-letter queue");
        verify(queueService).changeVisibility("rh-3", 0);
        verify(queueService, never()).delete(anyString());
    }

    @Test
    void deliveryCountFromSqsIsTrustedOverTheJobsOwnCounter() {
        ReportJob job = queuedJob();   // attemptCount 0, but SQS says this is the third delivery
        doThrow(new ReportGenerationException("boom", true))
                .when(storageService).upload(anyString(), any(), anyString(), anyString());

        assertThat(processor.process(message(job, 3))).isEqualTo(Outcome.FAILED);
        verify(queueService).changeVisibility("rh-3", 0);
    }

    // ---- permanent failure -------------------------------------------------------------------

    @Test
    void nonRetryableFailureFailsImmediatelyAndDeletesTheMessage() {
        ReportJob job = queuedJob();
        job.setParameters(Map.of("region", "North", "dateFrom", "not-a-date"));

        Outcome outcome = processor.process(message(job, 1));

        assertThat(outcome).isEqualTo(Outcome.FAILED);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.FAILED);
        assertThat(job.getErrorMessage()).contains("non-retryable").contains("dateFrom");
        verify(queueService).delete("rh-1");
        verify(queueService, never()).changeVisibility(anyString(), anyInt());
        verify(storageService, never()).upload(anyString(), any(), anyString(), anyString());
    }

    @Test
    void missingGeneratorIsPermanent() {
        ReportJob job = queuedJob();
        job.setType(ReportType.USER_ACTIVITY);
        assertThat(processor.process(message(job, 1))).isEqualTo(Outcome.FAILED);
        assertThat(job.getErrorMessage()).contains("No generator for report type USER_ACTIVITY");
        verify(queueService).delete("rh-1");
    }

    // ---- interruption ------------------------------------------------------------------------

    @Test
    void interruptedAttemptReleasesTheMessageAtOnceAndKeepsTheInterruptFlag() {
        ReportJob job = queuedJob();
        generatorBehaviour.set(p -> {
            Thread.currentThread().interrupt();
            throw new ReportGenerationException("aborted", true);
        });
        // The real SDK refuses calls on an interrupted thread; the hand-back must clear the flag first.
        org.mockito.Mockito.doAnswer(inv -> {
            if (Thread.currentThread().isInterrupted()) {
                throw software.amazon.awssdk.core.exception.AbortedException.builder().message("Thread was interrupted").build();
            }
            return null;
        }).when(repository).update(any());
        org.mockito.Mockito.doAnswer(inv -> {
            if (Thread.currentThread().isInterrupted()) {
                throw software.amazon.awssdk.core.exception.AbortedException.builder().message("Thread was interrupted").build();
            }
            return null;
        }).when(queueService).changeVisibility(anyString(), anyInt());

        Outcome outcome = processor.process(message(job, 1));

        assertThat(outcome).isEqualTo(Outcome.INTERRUPTED);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.RETRY_SCHEDULED);
        assertThat(job.getErrorMessage()).contains("interrupted by a worker shutdown");
        verify(queueService).changeVisibility("rh-1", 0);
        verify(queueService, never()).delete(anyString());
        assertThat(Thread.currentThread().isInterrupted()).isTrue();
    }

    // ---- concurrency and stale state ---------------------------------------------------------

    @Test
    void skipsAJobAnotherWorkerIsProcessingWithoutTouchingTheMessage() {
        ReportJob job = queuedJob();
        job.setStatus(ReportStatus.PROCESSING);
        job.setLockedBy("worker-other");
        job.setUpdatedAt(NOW.minusSeconds(30));

        assertThat(processor.process(message(job, 2))).isEqualTo(Outcome.SKIPPED);
        verify(repository, never()).update(any());
        verify(queueService, never()).delete(anyString());
        verify(queueService, never()).changeVisibility(anyString(), anyInt());
    }

    @Test
    void takesOverAJobWhoseHolderWentSilentForLongerThanTheVisibilityTimeout() {
        ReportJob job = queuedJob();
        job.setStatus(ReportStatus.PROCESSING);
        job.setLockedBy("worker-dead");
        job.setAttemptCount(1);
        job.setUpdatedAt(NOW.minusSeconds(200));

        assertThat(processor.process(message(job, 2))).isEqualTo(Outcome.COMPLETED);
        assertThat(job.getAttemptCount()).isEqualTo(2);
        assertThat(job.getLockedBy()).isNull();
        verify(queueService).delete("rh-2");
    }

    @Test
    void aLockLostToTheApisQueuedWriteIsRetriedOnAFreshCopy() {
        ReportJob accepted = queuedJob();
        accepted.setStatus(ReportStatus.ACCEPTED);
        accepted.setVersion(0);
        ReportJob queued = ReportJob.create(ReportType.SALES_SUMMARY, accepted.getParameters(), "cid-job", null, 3, 1L, NOW.minusSeconds(10));
        queued.setId(accepted.getId());
        queued.setStatus(ReportStatus.QUEUED);
        queued.setVersion(1);
        // The first read sees ACCEPTED (version 0); the lock collides with the API's QUEUED write;
        // the reload returns the QUEUED copy (version 1) and the lock succeeds.
        when(repository.findById(accepted.getId())).thenReturn(Optional.of(accepted), Optional.of(queued));
        org.mockito.Mockito.doThrow(new StaleJobException(accepted.getId(), 0)).doNothing().when(repository).update(any());

        assertThat(processor.process(message(accepted, 1))).isEqualTo(Outcome.COMPLETED);
        verify(repository, org.mockito.Mockito.times(2)).findById(accepted.getId());
        assertThat(queued.getStatus()).isEqualTo(ReportStatus.COMPLETED);
        assertThat(queued.getAttemptCount()).isEqualTo(1);
        verify(queueService).delete("rh-1");
    }

    @Test
    void repeatedlyLosingTheRaceForTheLockLeavesTheMessageAlone() {
        ReportJob job = queuedJob();
        doThrow(new StaleJobException(job.getId(), 1)).when(repository).update(any());

        assertThat(processor.process(message(job, 1))).isEqualTo(Outcome.SKIPPED);
        verify(storageService, never()).upload(anyString(), any(), anyString(), anyString());
        verify(queueService, never()).delete(anyString());
        verify(queueService, never()).changeVisibility(anyString(), anyInt());
    }

    @Test
    void staleCompletionIsDiscardedInsteadOfOverwritingNewerState() {
        ReportJob job = queuedJob();
        org.mockito.Mockito.doNothing().doThrow(new StaleJobException(job.getId(), 2)).when(repository).update(any());

        assertThat(processor.process(message(job, 1))).isEqualTo(Outcome.SKIPPED);
        verify(storageService).upload(anyString(), any(), anyString(), anyString());
        verify(queueService, never()).delete(anyString());
    }

    @Test
    void terminalJobsDiscardDuplicateDeliveries() {
        ReportJob job = queuedJob();
        job.setStatus(ReportStatus.COMPLETED);
        assertThat(processor.process(message(job, 2))).isEqualTo(Outcome.SKIPPED);
        verify(queueService).delete("rh-2");
        verify(repository, never()).update(any());
    }

    @Test
    void unknownOrMalformedMessagesAreDiscarded() {
        when(repository.findById("missing")).thenReturn(Optional.empty());
        assertThat(processor.process(new ReceivedMessage("m", "rh-a", "missing", "c", 1))).isEqualTo(Outcome.SKIPPED);
        verify(queueService).delete("rh-a");
        assertThat(processor.process(new ReceivedMessage("m", "rh-b", null, null, 1))).isEqualTo(Outcome.SKIPPED);
        verify(queueService).delete("rh-b");
    }
}
