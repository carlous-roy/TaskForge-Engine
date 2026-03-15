package com.taskforge.api.controller;

import com.taskforge.api.service.ReportService;
import com.taskforge.common.dto.CreateReportRequest;
import com.taskforge.common.dto.ReportResponse;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.service.QueueService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class ReportController {

    private final ReportService reportService;
    private final QueueService queueService;

    public ReportController(ReportService reportService, QueueService queueService) {
        this.reportService = reportService;
        this.queueService = queueService;
    }

    @PostMapping("/reports")
    public ResponseEntity<ReportResponse> submitReport(@Valid @RequestBody CreateReportRequest request) {
        ReportJob job = reportService.submit(request);
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(ReportResponse.from(job));
    }

    @GetMapping("/reports/{id}")
    public ResponseEntity<ReportResponse> getReport(@PathVariable String id) {
        ReportJob job = reportService.getReport(id);
        String downloadUrl = null;
        if (job.getStatus() == ReportStatus.COMPLETED && job.getFileKey() != null) {
            try {
                downloadUrl = reportService.getDownloadUrl(id);
            } catch (Exception ignored) {
                // File may have expired
            }
        }
        return ResponseEntity.ok(ReportResponse.from(job, downloadUrl));
    }

    @GetMapping("/reports/{id}/download")
    public ResponseEntity<Void> downloadReport(@PathVariable String id) {
        String url = reportService.getDownloadUrl(id);
        return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(url)).build();
    }

    @GetMapping("/reports")
    public ResponseEntity<List<ReportResponse>> listReports(
            @RequestParam(required = false) ReportStatus status) {
        return ResponseEntity.ok(
                reportService.listReports(status).stream()
                        .map(ReportResponse::from).toList());
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        return ResponseEntity.ok(Map.of(
                "service", "taskforge-api",
                "status", "UP",
                "timestamp", Instant.now().toString(),
                "queueDepth", queueService.approximateMessageCount()));
    }
}
