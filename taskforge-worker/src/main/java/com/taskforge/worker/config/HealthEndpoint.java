package com.taskforge.worker.config;

import com.taskforge.worker.service.MessagePoller;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
public class HealthEndpoint {

    private final MessagePoller poller;

    @Value("${taskforge.worker.id:worker-1}")
    private String workerId;

    public HealthEndpoint(MessagePoller poller) { this.poller = poller; }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        return Map.of(
                "service", "taskforge-worker",
                "workerId", workerId,
                "status", poller.isRunning() ? "UP" : "SHUTTING_DOWN",
                "activeJobs", poller.getActiveJobs(),
                "timestamp", Instant.now().toString());
    }
}
