package com.taskforge.common.model;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;

import java.time.Instant;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * A report job as stored in DynamoDB.
 *
 * <p>The transition methods enforce the state machine in {@link ReportStatus}. {@link #getVersion()}
 * is the optimistic-locking counter: the repository only writes a job when the stored version equals
 * the version this object was loaded with, and increments it on every successful write. A worker that
 * finished late therefore cannot overwrite a record another worker has moved on.
 */
public class ReportJob {

    private static final Set<ReportStatus> CAN_START_PROCESSING =
            EnumSet.of(ReportStatus.ACCEPTED, ReportStatus.QUEUED, ReportStatus.RETRY_SCHEDULED, ReportStatus.PROCESSING);

    private String id;
    private ReportType type;
    private ReportStatus status;
    private Map<String, String> parameters = new LinkedHashMap<>();
    private String correlationId;
    private String idempotencyKey;
    private String fileKey;
    private String errorMessage;
    private int attemptCount;
    private int maxAttempts;
    private long version;
    private String lockedBy;
    private Instant createdAt;
    private Instant updatedAt;
    private Instant completedAt;
    private Instant nextAttemptAt;
    private Instant deadLetteredAt;
    private long executionTimeMs;
    private long ttl;

    /** Used by the repository when reading an item back; application code uses {@link #create}. */
    public ReportJob() {
    }

    public static ReportJob create(ReportType type, Map<String, String> parameters, String correlationId,
                                   String idempotencyKey, int maxAttempts, long ttlEpochSeconds, Instant now) {
        ReportJob job = new ReportJob();
        job.id = UUID.randomUUID().toString();
        job.type = Objects.requireNonNull(type, "type");
        job.status = ReportStatus.ACCEPTED;
        job.parameters = parameters == null ? new LinkedHashMap<>() : new LinkedHashMap<>(parameters);
        job.correlationId = Objects.requireNonNull(correlationId, "correlationId");
        job.idempotencyKey = idempotencyKey;
        job.maxAttempts = maxAttempts;
        job.version = 0;
        job.createdAt = now;
        job.updatedAt = now;
        job.ttl = ttlEpochSeconds;
        return job;
    }

    // ---- transitions -------------------------------------------------------------------------

    /** ACCEPTED -> QUEUED, once the SQS message has been sent. */
    public void markQueued(Instant now) {
        require(ReportStatus.ACCEPTED);
        status = ReportStatus.QUEUED;
        updatedAt = now;
    }

    /**
     * A worker takes the job. Allowed from ACCEPTED, QUEUED and RETRY_SCHEDULED, and from PROCESSING
     * when the caller has decided the previous holder is dead (see {@link #isLockStale}).
     */
    public void markProcessing(String workerId, Instant now) {
        if (!CAN_START_PROCESSING.contains(status)) {
            throw new IllegalStateException("Cannot start processing job " + id + " in status " + status);
        }
        status = ReportStatus.PROCESSING;
        attemptCount++;
        lockedBy = workerId;
        nextAttemptAt = null;
        updatedAt = now;
    }

    /** PROCESSING -> RETRY_SCHEDULED: the attempt failed and SQS will redeliver at {@code nextAttemptAt}. */
    public void markRetryScheduled(String error, Instant nextAttemptAt, Instant now) {
        require(ReportStatus.PROCESSING);
        status = ReportStatus.RETRY_SCHEDULED;
        errorMessage = error;
        this.nextAttemptAt = nextAttemptAt;
        lockedBy = null;
        updatedAt = now;
    }

    /** PROCESSING -> COMPLETED. */
    public void markCompleted(String fileKey, long executionTimeMs, Instant now) {
        require(ReportStatus.PROCESSING);
        status = ReportStatus.COMPLETED;
        this.fileKey = fileKey;
        this.executionTimeMs = executionTimeMs;
        errorMessage = null;
        lockedBy = null;
        nextAttemptAt = null;
        completedAt = now;
        updatedAt = now;
    }

    /** Any non-terminal status -> FAILED. */
    public void markFailed(String error, Instant now) {
        if (status.isTerminal()) {
            throw new IllegalStateException("Cannot fail job " + id + " in terminal status " + status);
        }
        status = ReportStatus.FAILED;
        errorMessage = error;
        lockedBy = null;
        nextAttemptAt = null;
        completedAt = now;
        updatedAt = now;
    }

    /** Records that the SQS message for this job reached the dead-letter queue. */
    public void markDeadLettered(Instant now) {
        deadLetteredAt = now;
        updatedAt = now;
    }

    public boolean canRetry() {
        return attemptCount < maxAttempts;
    }

    /** True when the job is PROCESSING but nothing has touched it for longer than {@code staleAfter}. */
    public boolean isLockStale(Instant now, java.time.Duration staleAfter) {
        return status == ReportStatus.PROCESSING && updatedAt != null
                && updatedAt.plus(staleAfter).isBefore(now);
    }

    private void require(ReportStatus expected) {
        if (status != expected) {
            throw new IllegalStateException("Job " + id + " is " + status + ", expected " + expected);
        }
    }

    // ---- accessors ---------------------------------------------------------------------------

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public ReportType getType() { return type; }
    public void setType(ReportType type) { this.type = type; }
    public ReportStatus getStatus() { return status; }
    public void setStatus(ReportStatus status) { this.status = status; }
    public Map<String, String> getParameters() { return parameters; }
    public void setParameters(Map<String, String> parameters) { this.parameters = parameters == null ? new LinkedHashMap<>() : parameters; }
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
    public int getMaxAttempts() { return maxAttempts; }
    public void setMaxAttempts(int maxAttempts) { this.maxAttempts = maxAttempts; }
    public long getVersion() { return version; }
    public void setVersion(long version) { this.version = version; }
    public String getLockedBy() { return lockedBy; }
    public void setLockedBy(String lockedBy) { this.lockedBy = lockedBy; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
    public Instant getCompletedAt() { return completedAt; }
    public void setCompletedAt(Instant completedAt) { this.completedAt = completedAt; }
    public Instant getNextAttemptAt() { return nextAttemptAt; }
    public void setNextAttemptAt(Instant nextAttemptAt) { this.nextAttemptAt = nextAttemptAt; }
    public Instant getDeadLetteredAt() { return deadLetteredAt; }
    public void setDeadLetteredAt(Instant deadLetteredAt) { this.deadLetteredAt = deadLetteredAt; }
    public long getExecutionTimeMs() { return executionTimeMs; }
    public void setExecutionTimeMs(long executionTimeMs) { this.executionTimeMs = executionTimeMs; }
    public long getTtl() { return ttl; }
    public void setTtl(long ttl) { this.ttl = ttl; }

    @Override
    public String toString() {
        return "%s %s %s (attempt %d/%d, v%d)".formatted(id, type, status, attemptCount, maxAttempts, version);
    }
}
