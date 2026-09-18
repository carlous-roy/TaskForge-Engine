package com.taskforge.common.model;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReportJobTest {

    private static final Instant T0 = Instant.parse("2026-09-18T12:00:00Z");

    private static ReportJob newJob() {
        return ReportJob.create(ReportType.SALES_SUMMARY, Map.of("region", "North"), "cid123", "key-1", 3, 1_000L, T0);
    }

    @Test
    void createsAnAcceptedJobWithVersionZero() {
        ReportJob job = newJob();
        assertThat(job.getId()).isNotBlank();
        assertThat(job.getStatus()).isEqualTo(ReportStatus.ACCEPTED);
        assertThat(job.getVersion()).isZero();
        assertThat(job.getAttemptCount()).isZero();
        assertThat(job.getMaxAttempts()).isEqualTo(3);
        assertThat(job.getParameters()).containsEntry("region", "North");
        assertThat(job.getCorrelationId()).isEqualTo("cid123");
        assertThat(job.getIdempotencyKey()).isEqualTo("key-1");
        assertThat(job.getTtl()).isEqualTo(1_000L);
        assertThat(job.getCreatedAt()).isEqualTo(T0);
    }

    @Test
    void walksTheHappyPath() {
        ReportJob job = newJob();
        job.markQueued(T0.plusSeconds(1));
        assertThat(job.getStatus()).isEqualTo(ReportStatus.QUEUED);

        job.markProcessing("worker-a", T0.plusSeconds(2));
        assertThat(job.getStatus()).isEqualTo(ReportStatus.PROCESSING);
        assertThat(job.getAttemptCount()).isEqualTo(1);
        assertThat(job.getLockedBy()).isEqualTo("worker-a");

        job.markCompleted("reports/x.csv", 150, T0.plusSeconds(3));
        assertThat(job.getStatus()).isEqualTo(ReportStatus.COMPLETED);
        assertThat(job.getFileKey()).isEqualTo("reports/x.csv");
        assertThat(job.getExecutionTimeMs()).isEqualTo(150);
        assertThat(job.getCompletedAt()).isEqualTo(T0.plusSeconds(3));
        assertThat(job.getLockedBy()).isNull();
        assertThat(job.getStatus().isTerminal()).isTrue();
    }

    @Test
    void retryScheduledCanBePickedUpAgain() {
        ReportJob job = newJob();
        job.markQueued(T0);
        job.markProcessing("worker-a", T0);
        job.markRetryScheduled("boom", T0.plusSeconds(5), T0);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.RETRY_SCHEDULED);
        assertThat(job.getErrorMessage()).isEqualTo("boom");
        assertThat(job.getNextAttemptAt()).isEqualTo(T0.plusSeconds(5));
        assertThat(job.canRetry()).isTrue();

        job.markProcessing("worker-b", T0.plusSeconds(5));
        assertThat(job.getAttemptCount()).isEqualTo(2);
        assertThat(job.getNextAttemptAt()).isNull();
    }

    @Test
    void canRetryUntilTheBudgetIsSpent() {
        ReportJob job = newJob();
        job.markQueued(T0);
        for (int i = 1; i <= 3; i++) {
            job.markProcessing("w", T0);
            assertThat(job.canRetry()).isEqualTo(i < 3);
            job.markRetryScheduled("e", T0, T0);
        }
    }

    @Test
    void terminalStatesRejectFurtherTransitions() {
        ReportJob job = newJob();
        job.markQueued(T0);
        job.markProcessing("w", T0);
        job.markFailed("bad input", T0);
        assertThat(job.getStatus()).isEqualTo(ReportStatus.FAILED);
        assertThat(job.getCompletedAt()).isEqualTo(T0);
        assertThatThrownBy(() -> job.markProcessing("w", T0)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> job.markFailed("again", T0)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> job.markCompleted("f", 1, T0)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void onlyProcessingJobsCanCompleteOrScheduleRetries() {
        ReportJob job = newJob();
        assertThatThrownBy(() -> job.markCompleted("f", 1, T0)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> job.markRetryScheduled("e", T0, T0)).isInstanceOf(IllegalStateException.class);
        job.markQueued(T0);
        assertThatThrownBy(() -> job.markQueued(T0)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void staleLockIsDetectedByAge() {
        ReportJob job = newJob();
        job.markQueued(T0);
        assertThat(job.isLockStale(T0.plusSeconds(1_000), Duration.ofSeconds(120))).isFalse();
        job.markProcessing("w", T0);
        assertThat(job.isLockStale(T0.plusSeconds(60), Duration.ofSeconds(120))).isFalse();
        assertThat(job.isLockStale(T0.plusSeconds(121), Duration.ofSeconds(120))).isTrue();
    }

    @Test
    void deadLetteringStampsTheJob() {
        ReportJob job = newJob();
        job.markQueued(T0);
        job.markProcessing("w", T0);
        job.markFailed("x", T0);
        job.markDeadLettered(T0.plusSeconds(9));
        assertThat(job.getDeadLetteredAt()).isEqualTo(T0.plusSeconds(9));
    }
}
