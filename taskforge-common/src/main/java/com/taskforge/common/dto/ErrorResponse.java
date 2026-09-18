package com.taskforge.common.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;

/**
 * The one error body every 4xx and 5xx response uses.
 *
 * <pre>{@code
 * {
 *   "timestamp": "2026-09-18T12:00:00Z",
 *   "status": 400,
 *   "error": "Bad Request",
 *   "message": "Invalid report parameters",
 *   "details": ["parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'x'"],
 *   "path": "/api/v1/reports",
 *   "correlationId": "1f9b2c3d4e5f",
 *   "existingReportId": "..."        // only on 409 duplicate submissions
 * }
 * }</pre>
 */
public class ErrorResponse {

    private final Instant timestamp;
    private final int status;
    private final String error;
    private final String message;
    private final List<String> details;
    private final String path;
    private final String correlationId;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private final String existingReportId;

    public ErrorResponse(Instant timestamp, int status, String error, String message, List<String> details,
                         String path, String correlationId, String existingReportId) {
        this.timestamp = timestamp;
        this.status = status;
        this.error = error;
        this.message = message;
        this.details = details == null ? List.of() : List.copyOf(details);
        this.path = path;
        this.correlationId = correlationId;
        this.existingReportId = existingReportId;
    }

    public Instant getTimestamp() { return timestamp; }
    public int getStatus() { return status; }
    public String getError() { return error; }
    public String getMessage() { return message; }
    public List<String> getDetails() { return details; }
    public String getPath() { return path; }
    public String getCorrelationId() { return correlationId; }
    public String getExistingReportId() { return existingReportId; }
}
