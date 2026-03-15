package com.taskforge.worker.service;

import com.taskforge.common.service.QueueService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.sqs.model.Message;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@Service
public class MessagePoller {

    private static final Logger log = LoggerFactory.getLogger(MessagePoller.class);

    private final QueueService queueService;
    private final JobProcessor jobProcessor;
    private final ExecutorService threadPool;
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final AtomicInteger activeJobs = new AtomicInteger(0);

    @Value("${taskforge.worker.max-concurrent:3}")
    private int maxConcurrent;

    public MessagePoller(QueueService queueService, JobProcessor jobProcessor,
                          @Value("${taskforge.worker.max-concurrent:3}") int maxConcurrent) {
        this.queueService = queueService;
        this.jobProcessor = jobProcessor;
        this.threadPool = Executors.newFixedThreadPool(maxConcurrent);
        log.info("Message poller initialized (max-concurrent={})", maxConcurrent);
    }

    @Scheduled(fixedDelayString = "${taskforge.worker.poll-interval-ms:2000}")
    public void poll() {
        if (!running.get()) return;

        int available = maxConcurrent - activeJobs.get();
        if (available <= 0) return;

        try {
            List<Message> messages = queueService.receive(Math.min(available, 5));
            for (Message msg : messages) {
                activeJobs.incrementAndGet();
                threadPool.submit(() -> {
                    try {
                        jobProcessor.process(msg);
                    } catch (Exception e) {
                        log.error("Unhandled error processing message", e);
                    } finally {
                        activeJobs.decrementAndGet();
                    }
                });
            }
        } catch (Exception e) {
            log.error("Error polling queue", e);
        }
    }

    @PreDestroy
    public void shutdown() {
        log.info("Shutting down... waiting for {} active jobs to complete", activeJobs.get());
        running.set(false);
        threadPool.shutdown();
        try {
            if (!threadPool.awaitTermination(60, TimeUnit.SECONDS)) {
                log.warn("Forcing shutdown with {} jobs still running", activeJobs.get());
                threadPool.shutdownNow();
            }
        } catch (InterruptedException e) {
            threadPool.shutdownNow();
            Thread.currentThread().interrupt();
        }
        log.info("Shutdown complete");
    }

    public boolean isRunning() { return running.get(); }
    public int getActiveJobs() { return activeJobs.get(); }
}
