package com.taskforge.api.service;

import com.taskforge.common.dto.CreateReportRequest;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.ReportNotFoundException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

@Service
public class ReportService {

    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    private final ReportJobRepository repository;
    private final QueueService queueService;
    private final StorageService storageService;

    public ReportService(ReportJobRepository repository, QueueService queueService,
                          StorageService storageService) {
        this.repository = repository;
        this.queueService = queueService;
        this.storageService = storageService;
    }

    public ReportJob submit(CreateReportRequest request) {
        if (request.getIdempotencyKey() != null && !request.getIdempotencyKey().isBlank()) {
            Optional<ReportJob> existing = repository.findByIdempotencyKey(request.getIdempotencyKey());
            if (existing.isPresent()) {
                throw new DuplicateReportException(request.getIdempotencyKey(), existing.get().getId());
            }
        }

        ReportJob job = new ReportJob();
        job.setType(request.getType());
        job.setParameters(request.getParameters());
        job.setIdempotencyKey(request.getIdempotencyKey());
        repository.save(job);

        job.markQueued();
        repository.save(job);
        queueService.enqueue(job.getId(), job.getCorrelationId());

        log.info("[{}] Report submitted: {} {}", job.getCorrelationId(), job.getType(), job.getId());
        return job;
    }

    public ReportJob getReport(String id) {
        return repository.findByIdOrThrow(id);
    }

    public List<ReportJob> listReports(ReportStatus status) {
        if (status != null) return repository.findByStatus(status);
        return repository.findAll();
    }

    public String getDownloadUrl(String id) {
        ReportJob job = repository.findByIdOrThrow(id);
        if (job.getStatus() != ReportStatus.COMPLETED || job.getFileKey() == null) {
            throw new IllegalStateException("Report is not ready for download (status: " + job.getStatus() + ")");
        }
        if (!storageService.exists(job.getFileKey())) {
            throw new ReportNotFoundException("Report file has expired or been deleted");
        }
        return storageService.generateDownloadUrl(job.getFileKey());
    }
}
