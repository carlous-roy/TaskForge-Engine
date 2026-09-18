package com.taskforge.common.enums;

/**
 * Lifecycle of a report job.
 *
 * <pre>
 * ACCEPTED -> QUEUED -> PROCESSING -> COMPLETED
 *                          |  ^
 *                          v  |
 *                   RETRY_SCHEDULED           (attempt failed, SQS redelivers after the backoff)
 *                          |
 *                          v
 *                        FAILED               (non-retryable error, or attempts exhausted)
 * </pre>
 *
 * A worker may also move a job from ACCEPTED straight to PROCESSING if it receives the message
 * before the API has recorded QUEUED.
 */
public enum ReportStatus {
    /** Record written; the SQS message is being sent. */
    ACCEPTED,
    /** Message is in the queue waiting for a worker. */
    QUEUED,
    /** A worker holds the job. */
    PROCESSING,
    /** The last attempt failed; the message is hidden until the backoff elapses, then redelivered. */
    RETRY_SCHEDULED,
    /** The CSV is in S3. */
    COMPLETED,
    /** Terminal failure: a non-retryable error, or the retry budget was spent and the message was dead-lettered. */
    FAILED;

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED;
    }
}
