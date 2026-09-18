package com.taskforge.common.exception;

/**
 * A conditional write on a job record failed because the stored version no longer matches the one
 * this process loaded: someone else has moved the job on. The caller must reload and decide again.
 */
public class StaleJobException extends RuntimeException {

    private final String jobId;
    private final long expectedVersion;

    public StaleJobException(String jobId, long expectedVersion) {
        super("Job " + jobId + " was modified concurrently (expected version " + expectedVersion + ")");
        this.jobId = jobId;
        this.expectedVersion = expectedVersion;
    }

    public String getJobId() { return jobId; }
    public long getExpectedVersion() { return expectedVersion; }
}
