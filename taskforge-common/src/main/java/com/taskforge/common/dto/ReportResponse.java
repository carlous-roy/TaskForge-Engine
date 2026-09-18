package com.taskforge.common.dto;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.model.ReportJob;

import java.time.Instant;
import java.util.Map;

/** A job as the API presents it. Field order is the order clients see. */
public class ReportResponse {

    private String id;
    private ReportType type;
    private ReportStatus status;
    private Map<String, String> parameters;
    private String correlationId;
    private String errorMessage;
    private int attemptCount;
    private int maxAttempts;
    private String downloadUrl;
    private Instant createdAt;
    private Instant updatedAt;
    private Instant completedAt;
    private Instant nextAttemptAt;
    private Instant deadLetteredAt;
    private long executionTimeMs;

    public static ReportResponse from(ReportJob job) {
        return from(job, null);
    }

    public static ReportResponse from(ReportJob job, String downloadUrl) {
        ReportResponse r = new ReportResponse();
        r.id = job.getId();
        r.type = job.getType();
        r.status = job.getStatus();
        r.parameters = job.getParameters();
        r.correlationId = job.getCorrelationId();
        r.errorMessage = job.getErrorMessage();
        r.attemptCount = job.getAttemptCount();
        r.maxAttempts = job.getMaxAttempts();
        r.downloadUrl = downloadUrl;
        r.createdAt = job.getCreatedAt();
        r.updatedAt = job.getUpdatedAt();
        r.completedAt = job.getCompletedAt();
        r.nextAttemptAt = job.getNextAttemptAt();
        r.deadLetteredAt = job.getDeadLetteredAt();
        r.executionTimeMs = job.getExecutionTimeMs();
        return r;
    }

    public String getId() { return id; }
    public ReportType getType() { return type; }
    public ReportStatus getStatus() { return status; }
    public Map<String, String> getParameters() { return parameters; }
    public String getCorrelationId() { return correlationId; }
    public String getErrorMessage() { return errorMessage; }
    public int getAttemptCount() { return attemptCount; }
    public int getMaxAttempts() { return maxAttempts; }
    public String getDownloadUrl() { return downloadUrl; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Instant getCompletedAt() { return completedAt; }
    public Instant getNextAttemptAt() { return nextAttemptAt; }
    public Instant getDeadLetteredAt() { return deadLetteredAt; }
    public long getExecutionTimeMs() { return executionTimeMs; }
}
