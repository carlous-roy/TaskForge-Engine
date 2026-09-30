package com.taskforge.api.controller;

import com.taskforge.api.service.ReportService;
import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.dto.CreateReportRequest;
import com.taskforge.common.dto.ReportResponse;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.service.QueueService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The HTTP surface: submit a report, read or list jobs, follow a download and check health. Status
 * codes and error bodies for the failure cases come from {@link GlobalExceptionHandler}.
 */
@RestController
@RequestMapping("/api/v1")
public class ReportController {

    private static final Logger log = LoggerFactory.getLogger(ReportController.class);
    private static final String UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

    private final ReportService reportService;
    private final QueueService queueService;
    private final Clock clock;

    public ReportController(ReportService reportService, QueueService queueService, Clock clock) {
        this.reportService = reportService;
        this.queueService = queueService;
        this.clock = clock;
    }

    @PostMapping("/reports")
    public ResponseEntity<ReportResponse> submitReport(@Valid @RequestBody CreateReportRequest request) {
        ReportJob job = reportService.submit(request, CorrelationId.current());
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .location(URI.create("/api/v1/reports/" + job.getId()))
                .body(ReportResponse.from(job));
    }

    @GetMapping("/reports/{id}")
    public ReportResponse getReport(@PathVariable @Pattern(regexp = UUID_PATTERN, message = "must be a UUID") String id) {
        ReportJob job = reportService.getReport(id);
        return ReportResponse.from(job, reportService.downloadUrlFor(job).orElse(null));
    }

    @GetMapping("/reports/{id}/download")
    public ResponseEntity<Void> downloadReport(@PathVariable @Pattern(regexp = UUID_PATTERN, message = "must be a UUID") String id) {
        String url = reportService.getDownloadUrl(id);
        return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(url)).build();
    }

    /** Newest jobs first. Completed jobs carry a presigned download URL. */
    @GetMapping("/reports")
    public List<ReportResponse> listReports(
            @RequestParam(required = false) ReportStatus status,
            @RequestParam(defaultValue = "100") @Min(1) @Max(500) int limit) {
        return reportService.listReports(status, limit).stream()
                .map(job -> ReportResponse.from(job, reportService.downloadUrlFor(job).orElse(null)))
                .toList();
    }

    /**
     * Liveness of the API plus what it can see of the pipeline. {@code status} is UP when the queues
     * answer and DEGRADED (HTTP 503) when they do not; the depths are SQS's approximate counts.
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", "taskforge-api");
        body.put("timestamp", clock.instant().toString());
        try {
            body.put("queueDepth", queueService.queueDepth());
            body.put("deadLetterDepth", queueService.deadLetterDepth());
            body.put("status", "UP");
            return ResponseEntity.ok(body);
        } catch (RuntimeException e) {
            log.warn("Health check cannot read queue depth: {}", e.getMessage());
            body.put("queueDepth", null);
            body.put("deadLetterDepth", null);
            body.put("status", "DEGRADED");
            body.put("detail", "queue unreachable");
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body);
        }
    }
}
