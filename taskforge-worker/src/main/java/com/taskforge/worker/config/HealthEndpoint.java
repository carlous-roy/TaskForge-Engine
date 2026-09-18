package com.taskforge.worker.config;

import com.taskforge.worker.service.MessagePoller;
import com.taskforge.worker.service.WorkerIdentity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Liveness of this worker. The poller stops before the web server does (see
 * {@code MessagePoller#PHASE}), so during a drain this endpoint keeps answering with
 * {@code status: STOPPING}, {@code polling: false} and the number of jobs still running.
 */
@RestController
public class HealthEndpoint {

    private final MessagePoller poller;
    private final WorkerIdentity identity;
    private final Clock clock;

    public HealthEndpoint(MessagePoller poller, WorkerIdentity identity, Clock clock) {
        this.poller = poller;
        this.identity = identity;
        this.clock = clock;
    }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", "taskforge-worker");
        body.put("workerId", identity.id());
        body.put("status", poller.isRunning() ? "UP" : "STOPPING");
        body.put("polling", poller.isRunning());
        body.put("activeJobs", poller.getActiveJobs());
        body.put("timestamp", clock.instant().toString());
        return body;
    }
}
