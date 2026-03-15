package com.taskforge.common.exception;

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
    public boolean isRetryable() { return retryable; }
}
