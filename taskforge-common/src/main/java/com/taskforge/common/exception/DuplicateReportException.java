package com.taskforge.common.exception;

public class DuplicateReportException extends RuntimeException {
    private final String existingId;
    public DuplicateReportException(String idempotencyKey, String existingId) {
        super("Duplicate report request with key: " + idempotencyKey);
        this.existingId = existingId;
    }
    public String getExistingId() { return existingId; }
}
