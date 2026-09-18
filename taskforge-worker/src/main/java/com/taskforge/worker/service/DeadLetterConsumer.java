package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Reads the dead-letter queue and records the outcome on each job.
 *
 * <p>A message reaches the dead-letter queue when SQS has delivered it {@code max-attempts} times
 * without a worker deleting it: either every attempt failed, or a worker died (or was interrupted)
 * holding it and never recorded an outcome. In both cases this consumer marks the job FAILED with
 * the last recorded error, stamps {@code deadLetteredAt}, and deletes the dead-letter message. Nothing
 * retries the job after this.
 */
@Component
@ConditionalOnProperty(prefix = "taskforge.worker.dead-letter", name = "enabled", havingValue = "true", matchIfMissing = true)
public class DeadLetterConsumer implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(DeadLetterConsumer.class);
    private static final Duration RECEIVE_WAIT = Duration.ofSeconds(2);

    private final QueueService queueService;
    private final ReportJobRepository repository;
    private final Duration pollInterval;
    private final Clock clock;

    private volatile boolean running;
    private Thread thread;

    public DeadLetterConsumer(QueueService queueService, ReportJobRepository repository,
                              TaskForgeProperties properties, Clock clock) {
        this.queueService = queueService;
        this.repository = repository;
        this.pollInterval = properties.getWorker().getDeadLetter().getPollInterval();
        this.clock = clock;
    }

    @Override
    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::loop, "taskforge-dlq-consumer");
        thread.start();
        log.info("Dead-letter consumer started (poll interval {})", pollInterval);
    }

    private void loop() {
        while (running) {
            try {
                List<ReceivedMessage> messages = queueService.receiveDeadLetters(10, RECEIVE_WAIT);
                for (ReceivedMessage message : messages) {
                    handle(message);
                }
                if (messages.isEmpty()) {
                    Thread.sleep(pollInterval.toMillis());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (RuntimeException e) {
                if (!running) break;
                log.error("Dead-letter poll failed; retrying after {}", pollInterval, e);
                try {
                    Thread.sleep(pollInterval.toMillis());
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        log.info("Dead-letter consumer stopped");
    }

    /** Visible for tests. Records the dead-lettering on the job and acknowledges the message. */
    void handle(ReceivedMessage message) {
        CorrelationId.bind(message.correlationId() != null ? message.correlationId() : "unknown");
        try {
            if (message.jobId() == null) {
                log.error("Dead-letter message {} has no jobId; discarding it", message.messageId());
                queueService.deleteDeadLetter(message.receiptHandle());
                return;
            }
            Optional<ReportJob> loaded = repository.findById(message.jobId());
            if (loaded.isEmpty()) {
                log.warn("Dead-letter message for unknown job {}; discarding it", message.jobId());
                queueService.deleteDeadLetter(message.receiptHandle());
                return;
            }
            ReportJob job = loaded.get();
            CorrelationId.bind(job.getCorrelationId());
            record(job, message.receiveCount());
            queueService.deleteDeadLetter(message.receiptHandle());
        } finally {
            CorrelationId.clear();
        }
    }

    private void record(ReportJob job, int deliveries) {
        for (int attempt = 0; attempt < 2; attempt++) {
            Instant now = clock.instant();
            if (job.getStatus() == ReportStatus.COMPLETED) {
                log.info("Job {} completed before its message was dead-lettered; nothing to record", job.getId());
                return;
            }
            if (job.getStatus() == ReportStatus.FAILED && job.getDeadLetteredAt() != null) {
                return;
            }
            if (job.getStatus() == ReportStatus.FAILED) {
                log.info("Message for failed job {} reached the dead-letter queue after {} deliveries; recorded",
                        job.getId(), deliveries);
            } else {
                String lastError = job.getErrorMessage() != null
                        ? "last error: " + job.getErrorMessage()
                        : "no attempt recorded an outcome (the worker holding it stopped or crashed)";
                String reason = "Dead-lettered after " + Math.max(deliveries - 1, job.getAttemptCount())
                        + " deliveries while " + job.getStatus() + "; " + lastError;
                log.error("Job {} failed: {}", job.getId(), reason);
                job.markFailed(reason, now);
            }
            job.markDeadLettered(now);
            try {
                repository.update(job);
                return;
            } catch (StaleJobException e) {
                Optional<ReportJob> fresh = repository.findById(job.getId());
                if (fresh.isEmpty()) return;
                job = fresh.get();
            }
        }
        log.warn("Job {} kept changing while being dead-lettered; leaving it as {}", job.getId(), job.getStatus());
    }

    @Override
    public synchronized void stop() {
        if (!running) return;
        running = false;
        thread.interrupt();
        try {
            thread.join(RECEIVE_WAIT.plusSeconds(5).toMillis());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return MessagePoller.PHASE;
    }
}
