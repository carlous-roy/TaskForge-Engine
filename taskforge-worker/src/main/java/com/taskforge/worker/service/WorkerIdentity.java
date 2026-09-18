package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.UUID;

/** The name this worker writes into job records ({@code lockedBy}) and logs. */
@Component
public class WorkerIdentity {

    private final String id;

    public WorkerIdentity(TaskForgeProperties properties) {
        String configured = properties.getWorker().getId();
        this.id = (configured != null && !configured.isBlank()) ? configured.trim() : defaultId();
    }

    public String id() {
        return id;
    }

    private static String defaultId() {
        String host;
        try {
            host = InetAddress.getLocalHost().getHostName();
        } catch (UnknownHostException e) {
            host = "worker";
        }
        return host + "-" + UUID.randomUUID().toString().substring(0, 4);
    }
}
