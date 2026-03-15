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
    void shouldCalculateExponentialBackoff() {
        ReportJob job = new ReportJob();

        job.setAttemptCount(1);
        long b1 = job.calculateBackoffMs();
        assertTrue(b1 >= 800 && b1 <= 1200, "Expected ~1s, got " + b1);

        job.setAttemptCount(2);
        long b2 = job.calculateBackoffMs();
        assertTrue(b2 >= 3200 && b2 <= 4800, "Expected ~4s, got " + b2);

        job.setAttemptCount(3);
        long b3 = job.calculateBackoffMs();
        assertTrue(b3 >= 12800 && b3 <= 19200, "Expected ~16s, got " + b3);
    }

    @Test
    void shouldCapBackoffAt60Seconds() {
        ReportJob job = new ReportJob();
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
