package com.taskforge.api.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.dto.CreateReportRequest;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.exception.QueueUnavailableException;
import com.taskforge.common.exception.ReportNotFoundException;
import com.taskforge.common.exception.ReportNotReadyException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.report.ReportParameters;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class ReportService {

    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    private final ReportJobRepository repository;
    private final QueueService queueService;
    private final StorageService storageService;
    private final TaskForgeProperties properties;
    private final Clock clock;

    public ReportService(ReportJobRepository repository, QueueService queueService, StorageService storageService,
                         TaskForgeProperties properties, Clock clock) {
        this.repository = repository;
        this.queueService = queueService;
        this.storageService = storageService;
        this.properties = properties;
        this.clock = clock;
    }

    /**
     * Accepts a report request.
     *
     * <ol>
     *   <li>Validate the parameters for the report type (400 on any problem).</li>
     *   <li>Write the job as ACCEPTED; with an idempotency key this is a transaction with the key
     *       marker, so a duplicate fails here with the existing job's id (409).</li>
     *   <li>Send the SQS message. If that fails the record is deleted again, so the key is free for
     *       the client's retry, and the client gets a 503.</li>
     *   <li>Move the job to QUEUED. A worker may already have taken it; then the current state is
     *       returned instead.</li>
     * </ol>
     */
    public ReportJob submit(CreateReportRequest request, String correlationId) {
        Map<String, String> parameters = ReportParameters.normalize(request.getType(), request.getParameters());
        Instant now = clock.instant();
        long ttl = now.plus(properties.getDynamodb().getJobTtl()).getEpochSecond();
        ReportJob job = ReportJob.create(request.getType(), parameters, correlationId, request.getIdempotencyKey(),
                properties.getRetry().getMaxAttempts(), ttl, now);

        repository.create(job);
        try {
            queueService.enqueue(job.getId(), correlationId);
        } catch (QueueUnavailableException e) {
            releaseUnqueued(job);
            throw e;
        }

        try {
            job.markQueued(clock.instant());
            repository.update(job);
        } catch (StaleJobException e) {
            log.info("Job {} was picked up before it was marked QUEUED", job.getId());
            return repository.findById(job.getId()).orElse(job);
        }
        log.info("Report submitted: {} {}", job.getType(), job.getId());
        return job;
    }

    private void releaseUnqueued(ReportJob job) {
        try {
            repository.delete(job.getId(), job.getIdempotencyKey());
            log.warn("Enqueue failed; removed job {} so idempotency key {} can be reused", job.getId(), job.getIdempotencyKey());
        } catch (RuntimeException cleanupFailure) {
            log.error("Enqueue failed and job {} could not be removed; it stays ACCEPTED until its TTL", job.getId(), cleanupFailure);
        }
    }

    public ReportJob getReport(String id) {
        return repository.findById(id).orElseThrow(() -> new ReportNotFoundException(id));
    }

    public List<ReportJob> listReports(ReportStatus status, int limit) {
        return status == null ? repository.findAll(limit) : repository.findByStatus(status, limit);
    }

    /** A presigned URL for a completed report, or empty if the job has no file. */
    public Optional<String> downloadUrlFor(ReportJob job) {
        if (job.getStatus() != ReportStatus.COMPLETED || job.getFileKey() == null) {
            return Optional.empty();
        }
        return Optional.of(storageService.generateDownloadUrl(job.getFileKey()));
    }

    /** A presigned URL after checking the file is still there; throws 404/409 otherwise. */
    public String getDownloadUrl(String id) {
        ReportJob job = getReport(id);
        if (job.getStatus() != ReportStatus.COMPLETED || job.getFileKey() == null) {
            throw new ReportNotReadyException(id, job.getStatus());
        }
        if (!storageService.exists(job.getFileKey())) {
            throw ReportNotFoundException.fileMissing(id);
        }
        return storageService.generateDownloadUrl(job.getFileKey());
    }
}
