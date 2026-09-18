package com.taskforge.common.exception;

/**
 * A report could not be produced. {@code retryable} decides what the worker does next: a retryable
 * failure (a timeout, a throttled dependency) is handed back to SQS with a backoff; a non-retryable
 * one (bad input, a bug in the generator) fails the job immediately, because running it again cannot
 * change the outcome.
 */
public class ReportGenerationException extends RuntimeException {

    private final boolean retryable;

    public ReportGenerationException(String message, boolean retryable) {
        super(message);
        this.retryable = retryable;
    }

    public ReportGenerationException(String message, Throwable cause, boolean retryable) {
        super(message, cause);
        this.retryable = retryable;
    }

    public static ReportGenerationException retryable(String message, Throwable cause) {
        return new ReportGenerationException(message, cause, true);
    }

    public static ReportGenerationException permanent(String message, Throwable cause) {
        return new ReportGenerationException(message, cause, false);
    }

    public boolean isRetryable() { return retryable; }
}
