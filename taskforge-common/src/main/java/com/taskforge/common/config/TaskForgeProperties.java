package com.taskforge.common.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * Every tunable of the job pipeline, bound from the {@code taskforge.*} properties.
 *
 * <p>The retry budget is one number: {@link Retry#getMaxAttempts()} is both the number of times a
 * worker will run a job and the {@code maxReceiveCount} of the SQS redrive policy, because each SQS
 * delivery is one attempt. Keeping them separate would let the queue and the workers disagree about
 * when a job is finished.
 */
@Validated
@ConfigurationProperties(prefix = "taskforge")
public class TaskForgeProperties {

    @Valid private final DynamoDb dynamodb = new DynamoDb();
    @Valid private final Sqs sqs = new Sqs();
    @Valid private final S3 s3 = new S3();
    @Valid private final Retry retry = new Retry();
    @Valid private final Worker worker = new Worker();
    @Valid private final RateLimit rateLimit = new RateLimit();

    public DynamoDb getDynamodb() { return dynamodb; }
    public Sqs getSqs() { return sqs; }
    public S3 getS3() { return s3; }
    public Retry getRetry() { return retry; }
    public Worker getWorker() { return worker; }
    public RateLimit getRateLimit() { return rateLimit; }

    public static class DynamoDb {
        /** Table that holds job records and idempotency-key records. Created if missing. */
        @NotBlank private String table = "taskforge-reports";
        /** How long a job record lives before DynamoDB's TTL removes it. */
        @NotNull private Duration jobTtl = Duration.ofHours(24);

        public String getTable() { return table; }
        public void setTable(String table) { this.table = table; }
        public Duration getJobTtl() { return jobTtl; }
        public void setJobTtl(Duration jobTtl) { this.jobTtl = jobTtl; }
    }

    public static class Sqs {
        @NotBlank private String queue = "taskforge-reports";
        @NotBlank private String dlq = "taskforge-reports-dlq";
        /**
         * How long a received message stays hidden while a worker processes it. Must exceed the
         * longest report a worker can produce, otherwise SQS redelivers the message mid-run.
         */
        @NotNull private Duration visibilityTimeout = Duration.ofSeconds(120);
        /** Long-poll wait for ReceiveMessage. */
        @NotNull private Duration waitTime = Duration.ofSeconds(10);
        /** How long a dead-lettered message is kept. */
        @NotNull private Duration dlqRetention = Duration.ofDays(14);

        public String getQueue() { return queue; }
        public void setQueue(String queue) { this.queue = queue; }
        public String getDlq() { return dlq; }
        public void setDlq(String dlq) { this.dlq = dlq; }
        public Duration getVisibilityTimeout() { return visibilityTimeout; }
        public void setVisibilityTimeout(Duration visibilityTimeout) { this.visibilityTimeout = visibilityTimeout; }
        public Duration getWaitTime() { return waitTime; }
        public void setWaitTime(Duration waitTime) { this.waitTime = waitTime; }
        public Duration getDlqRetention() { return dlqRetention; }
        public void setDlqRetention(Duration dlqRetention) { this.dlqRetention = dlqRetention; }
    }

    public static class S3 {
        @NotBlank private String bucket = "taskforge-reports";
        /** Lifetime of a presigned download URL. */
        @NotNull private Duration downloadExpiry = Duration.ofMinutes(60);
        /** Bucket lifecycle rule: objects are deleted this many days after upload. */
        @Min(1) private int objectExpiryDays = 1;

        public String getBucket() { return bucket; }
        public void setBucket(String bucket) { this.bucket = bucket; }
        public Duration getDownloadExpiry() { return downloadExpiry; }
        public void setDownloadExpiry(Duration downloadExpiry) { this.downloadExpiry = downloadExpiry; }
        public int getObjectExpiryDays() { return objectExpiryDays; }
        public void setObjectExpiryDays(int objectExpiryDays) { this.objectExpiryDays = objectExpiryDays; }
    }

    public static class Retry {
        /** Attempts per job, including the first; also the redrive policy's maxReceiveCount. */
        @Min(1) @Max(100) private int maxAttempts = 3;
        @Valid private final Backoff backoff = new Backoff();

        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int maxAttempts) { this.maxAttempts = maxAttempts; }
        public Backoff getBackoff() { return backoff; }
    }

    /** Full-jitter exponential backoff: delay = random(0, min(cap, base * 2^attempt)). */
    public static class Backoff {
        @NotNull private Duration base = Duration.ofSeconds(2);
        @NotNull private Duration cap = Duration.ofSeconds(60);

        public Duration getBase() { return base; }
        public void setBase(Duration base) { this.base = base; }
        public Duration getCap() { return cap; }
        public void setCap(Duration cap) { this.cap = cap; }
    }

    public static class Worker {
        /** Identifies this worker in job records and logs; defaults to the host name. */
        private String id = "";
        /** Jobs processed at the same time by one worker process. */
        @Min(1) @Max(64) private int maxConcurrent = 3;
        /** Messages requested per poll; SQS allows at most 10. */
        @Min(1) @Max(10) private int batchSize = 5;
        /** Pause between polls when the queue was empty or the worker is at capacity. */
        @NotNull private Duration idleWait = Duration.ofMillis(500);
        /** How long a stopping worker waits for in-flight jobs before interrupting them. */
        @NotNull private Duration drainTimeout = Duration.ofSeconds(60);
        /**
         * A job that has been PROCESSING longer than this without an update is treated as abandoned
         * by a dead worker and may be taken over. Defaults to the SQS visibility timeout.
         */
        private Duration staleLockAfter;
        @Valid private final DeadLetter deadLetter = new DeadLetter();

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }
        public int getMaxConcurrent() { return maxConcurrent; }
        public void setMaxConcurrent(int maxConcurrent) { this.maxConcurrent = maxConcurrent; }
        public int getBatchSize() { return batchSize; }
        public void setBatchSize(int batchSize) { this.batchSize = batchSize; }
        public Duration getIdleWait() { return idleWait; }
        public void setIdleWait(Duration idleWait) { this.idleWait = idleWait; }
        public Duration getDrainTimeout() { return drainTimeout; }
        public void setDrainTimeout(Duration drainTimeout) { this.drainTimeout = drainTimeout; }
        public Duration getStaleLockAfter() { return staleLockAfter; }
        public void setStaleLockAfter(Duration staleLockAfter) { this.staleLockAfter = staleLockAfter; }
        public DeadLetter getDeadLetter() { return deadLetter; }
    }

    public static class DeadLetter {
        /** Whether this worker also consumes the dead-letter queue and records failures. */
        private boolean enabled = true;
        /** Pause between dead-letter queue polls when it was empty. */
        @NotNull private Duration pollInterval = Duration.ofSeconds(5);

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public Duration getPollInterval() { return pollInterval; }
        public void setPollInterval(Duration pollInterval) { this.pollInterval = pollInterval; }
    }

    public static class RateLimit {
        private boolean enabled = true;
        /** Requests allowed per client address per fixed one-minute window. */
        @Min(1) private int requestsPerMinute = 60;
        /** Distinct client addresses tracked at once; the rest share one overflow bucket. */
        @Min(1) private int maxTrackedClients = 10_000;

        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean enabled) { this.enabled = enabled; }
        public int getRequestsPerMinute() { return requestsPerMinute; }
        public void setRequestsPerMinute(int requestsPerMinute) { this.requestsPerMinute = requestsPerMinute; }
        public int getMaxTrackedClients() { return maxTrackedClients; }
        public void setMaxTrackedClients(int maxTrackedClients) { this.maxTrackedClients = maxTrackedClients; }
    }
}
