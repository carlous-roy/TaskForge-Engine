package com.taskforge.common.exception;

/** A submission reused an idempotency key that already belongs to a job. Maps to HTTP 409. */
public class DuplicateReportException extends RuntimeException {

    private final String idempotencyKey;
    private final String existingId;

    public DuplicateReportException(String idempotencyKey, String existingId) {
        super("Duplicate report request with key '" + idempotencyKey + "' (existing report " + existingId + ")");
        this.idempotencyKey = idempotencyKey;
        this.existingId = existingId;
    }

    public String getIdempotencyKey() { return idempotencyKey; }

    /** The job that owns the key; null only if its marker vanished between the failed write and the lookup. */
    public String getExistingId() { return existingId; }
}
