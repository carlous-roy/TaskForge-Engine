package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportGenerationException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.report.ReportParameters;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.retry.BackoffPolicy;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import com.taskforge.common.service.StorageService;
import com.taskforge.worker.report.ReportGenerator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Runs one delivered message through the job state machine.
 *
 * <p>The SQS message is the unit of retry. It is deleted only when the job reaches a terminal state
 * through this worker's own doing (completed, or failed for a permanent reason). A transient failure
 * hides the message for a backoff period with {@code ChangeMessageVisibility} and leaves it in the
 * queue; SQS redelivers it and counts the delivery. When the last permitted delivery fails, the job
 * is marked FAILED and the message is released immediately so the redrive policy moves it to the
 * dead-letter queue on the next receive.
 *
 * <p>Every write to the job record is conditional on the version the job was loaded with, so a
 * slow worker whose message was redelivered to another worker cannot overwrite the newer state.
 */
@Service
public class JobProcessor {

    private static final Logger log = LoggerFactory.getLogger(JobProcessor.class);

    /** What happened to the delivery, mainly for tests and log lines. */
    public enum Outcome { COMPLETED, RETRY_SCHEDULED, FAILED, SKIPPED, INTERRUPTED }

    private final ReportJobRepository repository;
    private final QueueService queueService;
    private final StorageService storageService;
    private final Map<ReportType, ReportGenerator> generators = new EnumMap<>(ReportType.class);
    private final BackoffPolicy backoff;
    private final int maxAttempts;
    private final Duration staleLockAfter;
    private final String workerId;
    private final Clock clock;

    public JobProcessor(ReportJobRepository repository, QueueService queueService, StorageService storageService,
                        List<ReportGenerator> generatorList, TaskForgeProperties properties,
                        WorkerIdentity identity, Clock clock) {
        this.repository = repository;
        this.queueService = queueService;
        this.storageService = storageService;
        for (ReportGenerator g : generatorList) {
            ReportGenerator previous = generators.put(g.getType(), g);
            if (previous != null) {
                throw new IllegalStateException("Two generators for " + g.getType() + ": " + previous + ", " + g);
            }
        }
        this.backoff = new BackoffPolicy(properties.getRetry().getBackoff().getBase(), properties.getRetry().getBackoff().getCap());
        this.maxAttempts = properties.getRetry().getMaxAttempts();
        Duration stale = properties.getWorker().getStaleLockAfter();
        this.staleLockAfter = stale != null ? stale : properties.getSqs().getVisibilityTimeout();
        this.workerId = identity.id();
        this.clock = clock;
        log.info("Loaded {} report generators: {}", generators.size(), generators.keySet());
    }

    public Outcome process(ReceivedMessage message) {
        CorrelationId.bind(message.correlationId() != null ? message.correlationId() : "unknown");
        try {
            return doProcess(message);
        } finally {
            CorrelationId.clear();
        }
    }

    private Outcome doProcess(ReceivedMessage message) {
        if (message.jobId() == null) {
            log.error("Message {} has no jobId; discarding it", message.messageId());
            queueService.delete(message.receiptHandle());
            return Outcome.SKIPPED;
        }
        Optional<ReportJob> loaded = repository.findById(message.jobId());
        if (loaded.isEmpty()) {
            log.warn("Job {} does not exist; discarding message {}", message.jobId(), message.messageId());
            queueService.delete(message.receiptHandle());
            return Outcome.SKIPPED;
        }
        ReportJob job = loaded.get();
        CorrelationId.bind(job.getCorrelationId());
        Instant now = clock.instant();

        if (job.getStatus().isTerminal()) {
            log.info("Job {} is already {}; discarding duplicate delivery", job.getId(), job.getStatus());
            queueService.delete(message.receiptHandle());
            return Outcome.SKIPPED;
        }
        if (job.getStatus() == com.taskforge.common.enums.ReportStatus.PROCESSING) {
            if (!job.isLockStale(now, staleLockAfter)) {
                log.info("Job {} is being processed by {} since {}; leaving the message for redelivery",
                        job.getId(), job.getLockedBy(), job.getUpdatedAt());
                return Outcome.SKIPPED;
            }
            log.warn("Job {} was left PROCESSING by {} at {}; taking it over", job.getId(), job.getLockedBy(), job.getUpdatedAt());
        }

        job.markProcessing(workerId, now);
        try {
            repository.update(job);
        } catch (StaleJobException e) {
            log.info("Job {} was taken by another worker first; leaving the message alone", job.getId());
            return Outcome.SKIPPED;
        }
        log.info("Processing {} job {} (attempt {}/{}, delivery {})",
                job.getType(), job.getId(), job.getAttemptCount(), job.getMaxAttempts(), message.receiveCount());

        long started = System.nanoTime();
        try {
            ReportGenerator generator = generators.get(job.getType());
            if (generator == null) {
                throw new ReportGenerationException("No generator for report type " + job.getType(), false);
            }
            ReportParameters parameters = ReportParameters.of(job.getType(), job.getParameters());
            byte[] content = generator.generate(parameters);
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("interrupted after generating the report");
            }
            String fileKey = "reports/%s/%s.csv".formatted(job.getType().name().toLowerCase(Locale.ROOT), job.getId());
            storageService.upload(fileKey, content, "text/csv", job.getCorrelationId());

            long elapsedMs = (System.nanoTime() - started) / 1_000_000;
            job.markCompleted(fileKey, elapsedMs, clock.instant());
            if (!tryUpdate(job)) {
                return Outcome.SKIPPED;
            }
            queueService.delete(message.receiptHandle());
            log.info("Job {} completed in {} ms: {}", job.getId(), elapsedMs, fileKey);
            return Outcome.COMPLETED;
        } catch (Exception e) {
            return handleFailure(job, message, e);
        }
    }

    private Outcome handleFailure(ReportJob job, ReceivedMessage message, Exception failure) {
        FailureClassifier.Kind kind = FailureClassifier.classify(failure);
        String reason = describe(failure);
        Instant now = clock.instant();
        int attempt = job.getAttemptCount();

        switch (kind) {
            case INTERRUPTED -> {
                log.warn("Attempt {} of job {} interrupted by shutdown; releasing the message", attempt, job.getId());
                job.markRetryScheduled("Attempt " + attempt + " was interrupted by a worker shutdown", now, now);
                if (tryUpdate(job)) {
                    queueService.changeVisibility(message.receiptHandle(), 0);
                }
                Thread.currentThread().interrupt();
                return Outcome.INTERRUPTED;
            }
            case PERMANENT -> {
                log.error("Attempt {} of job {} failed with a non-retryable error: {}", attempt, job.getId(), reason);
                job.markFailed("Attempt " + attempt + " failed with a non-retryable error: " + reason, now);
                if (tryUpdate(job)) {
                    queueService.delete(message.receiptHandle());
                }
                return Outcome.FAILED;
            }
            case TRANSIENT -> {
                int deliveries = Math.max(message.receiveCount(), attempt);
                if (deliveries < maxAttempts) {
                    int delaySeconds = backoff.delaySeconds(deliveries);
                    log.warn("Attempt {} of job {} failed ({}); retry in {} s (window 0-{} s)", attempt, job.getId(),
                            reason, delaySeconds, backoff.upperBoundSeconds(deliveries));
                    job.markRetryScheduled("Attempt " + attempt + " failed: " + reason, now.plusSeconds(delaySeconds), now);
                    if (tryUpdate(job)) {
                        queueService.changeVisibility(message.receiptHandle(), delaySeconds);
                    }
                    return Outcome.RETRY_SCHEDULED;
                }
                log.error("Attempt {} of {} for job {} failed ({}); no attempts left, message goes to the dead-letter queue",
                        attempt, maxAttempts, job.getId(), reason);
                job.markFailed("Attempt " + attempt + " of " + maxAttempts + " failed: " + reason
                        + ". No attempts left; the message was sent to the dead-letter queue.", now);
                if (tryUpdate(job)) {
                    queueService.changeVisibility(message.receiptHandle(), 0);
                }
                return Outcome.FAILED;
            }
            default -> throw new IllegalStateException("Unknown failure kind " + kind);
        }
    }

    /** Writes the job; false (and a warning) if another process has moved it on in the meantime. */
    private boolean tryUpdate(ReportJob job) {
        try {
            repository.update(job);
            return true;
        } catch (StaleJobException e) {
            log.warn("Job {} was modified by another process; this worker's result is discarded and the message left alone",
                    job.getId());
            return false;
        }
    }

    private static String describe(Throwable failure) {
        String message = failure.getMessage();
        if (message == null || message.isBlank()) {
            message = failure.getClass().getSimpleName();
        }
        return message.length() > 500 ? message.substring(0, 497) + "..." : message;
    }
}
