package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DeadLetterConsumerTest {

    private static final Instant NOW = Instant.parse("2026-09-18T12:00:00Z");

    private final QueueService queueService = mock(QueueService.class);
    private final ReportJobRepository repository = mock(ReportJobRepository.class);
    private final DeadLetterConsumer consumer = new DeadLetterConsumer(queueService, repository,
            new TaskForgeProperties(), Clock.fixed(NOW, ZoneOffset.UTC));

    private ReportJob job(ReportStatus status) {
        ReportJob job = ReportJob.create(ReportType.USER_ACTIVITY, Map.of(), "cid", null, 3, 1L, NOW.minusSeconds(60));
        job.setStatus(status);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        return job;
    }

    private static ReceivedMessage dead(ReportJob job) {
        return new ReceivedMessage("m", "rh-dlq", job.getId(), "cid", 4);
    }

    @Test
    void jobLeftProcessingByADeadWorkerIsFailedWithAReason() {
        ReportJob job = job(ReportStatus.PROCESSING);
        job.setAttemptCount(3);
        job.setErrorMessage("Attempt 2 failed: timeout");

        consumer.handle(dead(job));

        assertThat(job.getStatus()).isEqualTo(ReportStatus.FAILED);
        assertThat(job.getErrorMessage()).isEqualTo("Dead-lettered after 3 deliveries while PROCESSING; last error: Attempt 2 failed: timeout");
        assertThat(job.getDeadLetteredAt()).isEqualTo(NOW);
        assertThat(job.getCompletedAt()).isEqualTo(NOW);
        verify(repository).update(job);
        verify(queueService).deleteDeadLetter("rh-dlq");
    }

    @Test
    void jobWithoutAnyRecordedErrorGetsAnExplanation() {
        ReportJob job = job(ReportStatus.RETRY_SCHEDULED);
        consumer.handle(dead(job));
        assertThat(job.getErrorMessage()).contains("no attempt recorded an outcome");
    }

    @Test
    void alreadyFailedJobIsOnlyStamped() {
        ReportJob job = job(ReportStatus.FAILED);
        job.setErrorMessage("Attempt 3 of 3 failed: boom");

        consumer.handle(dead(job));

        assertThat(job.getErrorMessage()).isEqualTo("Attempt 3 of 3 failed: boom");
        assertThat(job.getDeadLetteredAt()).isEqualTo(NOW);
        verify(repository).update(job);
        verify(queueService).deleteDeadLetter("rh-dlq");
    }

    @Test
    void completedJobIsLeftAloneAndTheMessageDiscarded() {
        ReportJob job = job(ReportStatus.COMPLETED);
        consumer.handle(dead(job));
        assertThat(job.getStatus()).isEqualTo(ReportStatus.COMPLETED);
        verify(repository, never()).update(any());
        verify(queueService).deleteDeadLetter("rh-dlq");
    }

    @Test
    void unknownJobsAndMalformedMessagesAreDiscarded() {
        when(repository.findById("gone")).thenReturn(Optional.empty());
        consumer.handle(new ReceivedMessage("m", "rh-1", "gone", "c", 4));
        consumer.handle(new ReceivedMessage("m", "rh-2", null, null, 4));
        verify(queueService).deleteDeadLetter("rh-1");
        verify(queueService).deleteDeadLetter("rh-2");
        verify(repository, never()).update(any());
    }
}
