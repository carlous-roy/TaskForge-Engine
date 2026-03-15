package com.taskforge.common.model;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class ReportJob {

    private String id;
    private ReportType type;
    private ReportStatus status;
    private Map<String, String> parameters;
    private String correlationId;
    private String idempotencyKey;
    private String fileKey;
    private String errorMessage;
    private int attemptCount;
    private int maxRetries;
    private Instant createdAt;
    private Instant updatedAt;
    private Instant completedAt;
    private long executionTimeMs;
    private long ttl;

    public ReportJob() {
        this.id = UUID.randomUUID().toString();
        this.status = ReportStatus.ACCEPTED;
        this.parameters = new HashMap<>();
        this.correlationId = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        this.attemptCount = 0;
        this.maxRetries = 3;
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
        this.ttl = Instant.now().plusSeconds(86400).getEpochSecond();
    }


    public void markQueued() {
        this.status = ReportStatus.QUEUED;
        this.updatedAt = Instant.now();
    }

    public void markProcessing() {
        this.status = ReportStatus.PROCESSING;
        this.attemptCount++;
        this.updatedAt = Instant.now();
    }

    public void markCompleted(String fileKey, long executionTimeMs) {
        this.status = ReportStatus.COMPLETED;
        this.fileKey = fileKey;
        this.executionTimeMs = executionTimeMs;
        this.completedAt = Instant.now();
        this.updatedAt = Instant.now();
        this.errorMessage = null;
    }

    public void markFailed(String errorMessage) {
        this.status = ReportStatus.FAILED;
        this.errorMessage = errorMessage;
        this.updatedAt = Instant.now();
    }

    public void markDeadLetter(String errorMessage) {
        this.status = ReportStatus.DEAD_LETTER;
        this.errorMessage = errorMessage;
        this.completedAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    public boolean canRetry() {
        return this.attemptCount < this.maxRetries;
    }

    // Exponential backoff: base * 4^(attempt-1) + jitter, capped at 60s
    public long calculateBackoffMs() {
        long base = 1000L;
        long delay = base * (long) Math.pow(4, attemptCount - 1);
        long jitter = (long) (delay * 0.2 * Math.random());
        return Math.min(delay + jitter, 60_000L);
    }


    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public ReportType getType() { return type; }
    public void setType(ReportType type) { this.type = type; }

    public ReportStatus getStatus() { return status; }
    public void setStatus(ReportStatus status) { this.status = status; }

    public Map<String, String> getParameters() { return parameters; }
    public void setParameters(Map<String, String> parameters) { this.parameters = parameters; }

    public String getCorrelationId() { return correlationId; }
    public void setCorrelationId(String correlationId) { this.correlationId = correlationId; }

    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }

    public String getFileKey() { return fileKey; }
    public void setFileKey(String fileKey) { this.fileKey = fileKey; }

    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }

    public int getAttemptCount() { return attemptCount; }
    public void setAttemptCount(int attemptCount) { this.attemptCount = attemptCount; }

    public int getMaxRetries() { return maxRetries; }
    public void setMaxRetries(int maxRetries) { this.maxRetries = maxRetries; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }

    public Instant getCompletedAt() { return completedAt; }
    public void setCompletedAt(Instant completedAt) { this.completedAt = completedAt; }

    public long getExecutionTimeMs() { return executionTimeMs; }
    public void setExecutionTimeMs(long executionTimeMs) { this.executionTimeMs = executionTimeMs; }

    public long getTtl() { return ttl; }
    public void setTtl(long ttl) { this.ttl = ttl; }

    @Override
    public String toString() {
        return "[%s] %s %s (attempt %d/%d)".formatted(correlationId, type, status, attemptCount, maxRetries);
    }
}
