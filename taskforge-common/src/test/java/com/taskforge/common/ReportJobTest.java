package com.taskforge.common;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.model.ReportJob;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ReportJobTest {

    @Test
    void shouldInitializeWithDefaults() {
        ReportJob job = new ReportJob();
        assertNotNull(job.getId());
        assertNotNull(job.getCorrelationId());
        assertEquals(ReportStatus.ACCEPTED, job.getStatus());
        assertEquals(0, job.getAttemptCount());
        assertEquals(3, job.getMaxRetries());
        assertNotNull(job.getCreatedAt());
        assertTrue(job.getTtl() > 0);
    }

    @Test
    void shouldTransitionThroughLifecycle() {
        ReportJob job = new ReportJob();
        job.setType(ReportType.SALES_SUMMARY);

        job.markQueued();
        assertEquals(ReportStatus.QUEUED, job.getStatus());

        job.markProcessing();
        assertEquals(ReportStatus.PROCESSING, job.getStatus());
        assertEquals(1, job.getAttemptCount());

        job.markCompleted("reports/test.csv", 150);
        assertEquals(ReportStatus.COMPLETED, job.getStatus());
        assertEquals("reports/test.csv", job.getFileKey());
        assertEquals(150, job.getExecutionTimeMs());
        assertNotNull(job.getCompletedAt());
        assertNull(job.getErrorMessage());
    }

    @Test
    void shouldHandleRetryLogic() {
        ReportJob job = new ReportJob();
        job.setMaxRetries(3);

        assertTrue(job.canRetry()); // 0 attempts

        job.markProcessing(); // attempt 1
        assertTrue(job.canRetry());

        job.markProcessing(); // attempt 2
        assertTrue(job.canRetry());

        job.markProcessing(); // attempt 3
        assertFalse(job.canRetry());
    }

    @Test
    void shouldCalculateExponentialBackoffForEveryReachableRetry() {
        // markProcessing() increments attemptCount before the attempt runs and canRetry() is
        // attemptCount < maxRetries, so with the default maxRetries of 3 only two backoffs are
        // ever taken: 1s after the first attempt and 4s after the second. The third attempt is
        // terminal and is dead-lettered rather than requeued. Jitter adds up to 20% on top.
        ReportJob job = new ReportJob();

        job.markProcessing();
        assertTrue(job.canRetry());
        long b1 = job.calculateBackoffMs();
        assertTrue(b1 >= 1000 && b1 <= 1200, "Expected ~1s, got " + b1);

        job.markProcessing();
        assertTrue(job.canRetry());
        long b2 = job.calculateBackoffMs();
        assertTrue(b2 >= 4000 && b2 <= 4800, "Expected ~4s, got " + b2);

        job.markProcessing();
        assertFalse(job.canRetry(), "Third attempt is terminal, so no third backoff is reachable");
    }

    @Test
    void shouldCapBackoffAt60Seconds() {
        // The cap is a guard on calculateBackoffMs() itself: nothing in the default configuration
        // reaches an attempt count this high, but raising maxRetries would, and the delay must
        // stay inside the SQS 900s DelaySeconds ceiling.
        ReportJob job = new ReportJob();
        job.setMaxRetries(12);
        job.setAttemptCount(10);
        long backoff = job.calculateBackoffMs();
        assertTrue(backoff <= 60_000, "Backoff should be capped at 60s, got " + backoff);
    }

    @Test
    void shouldMoveToDeadLetter() {
        ReportJob job = new ReportJob();
        job.markDeadLetter("Max retries exhausted: timeout");
        assertEquals(ReportStatus.DEAD_LETTER, job.getStatus());
        assertEquals("Max retries exhausted: timeout", job.getErrorMessage());
        assertNotNull(job.getCompletedAt());
    }

    @Test
    void shouldGenerateCorrelationId() {
        ReportJob job1 = new ReportJob();
        ReportJob job2 = new ReportJob();
        assertNotEquals(job1.getCorrelationId(), job2.getCorrelationId());
        assertEquals(12, job1.getCorrelationId().length());
    }
}
