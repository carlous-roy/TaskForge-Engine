package com.taskforge.worker.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.exception.ReportGenerationException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import com.taskforge.worker.report.ReportGenerator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.sqs.model.Message;

import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class JobProcessor {

    private static final Logger log = LoggerFactory.getLogger(JobProcessor.class);

    private final ReportJobRepository repository;
    private final QueueService queueService;
    private final StorageService storageService;
    private final ObjectMapper objectMapper;
    private final Map<com.taskforge.common.enums.ReportType, ReportGenerator> generators;

    public JobProcessor(ReportJobRepository repository, QueueService queueService,
                         StorageService storageService, ObjectMapper objectMapper,
                         List<ReportGenerator> generatorList) {
        this.repository = repository;
        this.queueService = queueService;
        this.storageService = storageService;
        this.objectMapper = objectMapper;
        this.generators = new EnumMap<>(com.taskforge.common.enums.ReportType.class);
        generatorList.forEach(g -> generators.put(g.getType(), g));
        log.info("Loaded {} report generators: {}", generators.size(), generators.keySet());
    }

    public void process(Message message) {
        String jobId = extractJobId(message);
        if (jobId == null) {
            log.error("Could not extract jobId from message, discarding");
            queueService.delete(message.receiptHandle());
            return;
        }

        String correlationId = extractCorrelationId(message);

        Optional<ReportJob> jobOpt = repository.findById(jobId);
        if (jobOpt.isEmpty()) {
            log.warn("[{}] Job {} not found in DB, discarding message", correlationId, jobId);
            queueService.delete(message.receiptHandle());
            return;
        }

        ReportJob job = jobOpt.get();
        correlationId = job.getCorrelationId(); // Use the authoritative one

        if (job.getStatus() == ReportStatus.COMPLETED || job.getStatus() == ReportStatus.DEAD_LETTER) {
            log.info("[{}] Job already in {}, skipping", correlationId, job.getStatus());
            queueService.delete(message.receiptHandle());
            return;
        }

        log.info("[{}] Processing {} report (attempt {}/{})",
                correlationId, job.getType(), job.getAttemptCount() + 1, job.getMaxRetries());

        job.markProcessing();
        repository.save(job);

        try {
            Instant start = Instant.now();

            ReportGenerator generator = generators.get(job.getType());
            if (generator == null) {
                throw new ReportGenerationException("No generator for type: " + job.getType(), false);
            }

            byte[] content = generator.generate(
                    job.getParameters() != null ? job.getParameters() : Map.of(),
                    correlationId);

            String fileKey = "reports/%s/%s.csv".formatted(job.getType().name().toLowerCase(), job.getId());
            storageService.upload(fileKey, content, "text/csv");

            long durationMs = Instant.now().toEpochMilli() - start.toEpochMilli();
            job.markCompleted(fileKey, durationMs);
            repository.save(job);
            queueService.delete(message.receiptHandle());

            log.info("[{}] Report completed in {}ms, file={}", correlationId, durationMs, fileKey);

        } catch (Exception e) {
            handleFailure(job, message, e);
        }
    }

    private void handleFailure(ReportJob job, Message message, Exception e) {
        String cid = job.getCorrelationId();
        boolean retryable = !(e instanceof ReportGenerationException rge) || rge.isRetryable();

        log.error("[{}] Report failed (retryable={}): {}", cid, retryable, e.getMessage());

        if (retryable && job.canRetry()) {
            long backoffMs = job.calculateBackoffMs();
            int backoffSec = (int) (backoffMs / 1000);

            job.markFailed("Attempt %d: %s".formatted(job.getAttemptCount(), e.getMessage()));
            repository.save(job);
            queueService.delete(message.receiptHandle());
            queueService.enqueue(job.getId(), cid, backoffSec);

            log.info("[{}] Requeued with {}s backoff (attempt {}/{})",
                    cid, backoffSec, job.getAttemptCount(), job.getMaxRetries());
        } else {
            String reason = retryable ? "Max retries exhausted" : "Non-retryable error";
            job.markDeadLetter(reason + ": " + e.getMessage());
            repository.save(job);
            queueService.delete(message.receiptHandle());

            log.warn("[{}] Job moved to DEAD_LETTER: {}", cid, e.getMessage());
        }
    }

    private String extractJobId(Message message) {
        try {
            JsonNode body = objectMapper.readTree(message.body());
            return body.get("jobId").asText();
        } catch (Exception e) {
            return null;
        }
    }

    private String extractCorrelationId(Message message) {
        var attr = message.messageAttributes().get("correlationId");
        return attr != null ? attr.stringValue() : "unknown";
    }
}
