package com.taskforge.common.dto;

import java.time.Instant;

public class ErrorResponse {
    private final int status;
    private final String error;
    private final String message;
    private final String correlationId;
    private final Instant timestamp;

    public ErrorResponse(int status, String error, String message, String correlationId) {
        this.status = status;
        this.error = error;
        this.message = message;
        this.correlationId = correlationId;
        this.timestamp = Instant.now();
    }

    public int getStatus() { return status; }
    public String getError() { return error; }
    public String getMessage() { return message; }
    public String getCorrelationId() { return correlationId; }
    public Instant getTimestamp() { return timestamp; }
}
