package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Pulls messages from the main queue and hands them to a bounded pool of processing threads.
 *
 * <p>Shutdown is a drain: {@link #stop()} stops polling, waits for in-flight jobs up to
 * {@code taskforge.worker.drain-timeout}, then interrupts whatever is still running. An interrupted
 * job releases its message at once (see {@code JobProcessor}), so another worker picks it up. Spring
 * runs this from its shutdown hook, which is what SIGTERM triggers, before it stops Tomcat and closes
 * the AWS clients.
 */
@Component
public class MessagePoller implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(MessagePoller.class);

    /**
     * Stop order is descending by phase. Spring Boot's web server graceful shutdown runs at
     * {@code DEFAULT_PHASE - 1024} and the server itself stops after that, so this phase drains the
     * jobs first, while the health endpoint still answers, and long before any bean is destroyed.
     */
    static final int PHASE = SmartLifecycle.DEFAULT_PHASE - 512;

    private final QueueService queueService;
    private final JobProcessor jobProcessor;
    private final TaskForgeProperties.Worker config;
    private final Duration receiveWait;
    private final Semaphore capacity;
    private final AtomicInteger activeJobs = new AtomicInteger();
    private final AtomicInteger processed = new AtomicInteger();

    private volatile boolean running;
    private ExecutorService pool;
    private Thread pollThread;

    public MessagePoller(QueueService queueService, JobProcessor jobProcessor, TaskForgeProperties properties) {
        this.queueService = queueService;
        this.jobProcessor = jobProcessor;
        this.config = properties.getWorker();
        this.receiveWait = properties.getSqs().getWaitTime();
        this.capacity = new Semaphore(config.getMaxConcurrent());
    }

    @Override
    public synchronized void start() {
        if (running) return;
        running = true;
        pool = Executors.newFixedThreadPool(config.getMaxConcurrent(), r -> {
            Thread t = new Thread(r, "taskforge-job-" + processed.incrementAndGet());
            t.setDaemon(false);
            return t;
        });
        pollThread = new Thread(this::pollLoop, "taskforge-poller");
        pollThread.start();
        log.info("Polling started (max-concurrent={}, batch-size={}, drain-timeout={})",
                config.getMaxConcurrent(), config.getBatchSize(), config.getDrainTimeout());
    }

    private void pollLoop() {
        while (running) {
            try {
                int free = capacity.availablePermits();
                if (free == 0) {
                    Thread.sleep(config.getIdleWait().toMillis());
                    continue;
                }
                List<ReceivedMessage> messages = queueService.receive(Math.min(free, config.getBatchSize()));
                if (messages.isEmpty()) {
                    if (receiveWait.isZero()) {
                        Thread.sleep(config.getIdleWait().toMillis());
                    }
                    continue;
                }
                for (ReceivedMessage message : messages) {
                    if (!running) {
                        // Received while stopping: hand it back so another worker gets it at once.
                        queueService.changeVisibility(message.receiptHandle(), 0);
                        continue;
                    }
                    capacity.acquire();
                    activeJobs.incrementAndGet();
                    try {
                        pool.execute(() -> handle(message));
                    } catch (RuntimeException rejected) {
                        activeJobs.decrementAndGet();
                        capacity.release();
                        throw rejected;
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (RuntimeException e) {
                if (!running) break;
                log.error("Polling failed; retrying after {}", config.getIdleWait(), e);
                try {
                    Thread.sleep(config.getIdleWait().toMillis());
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        log.info("Polling stopped");
    }

    private void handle(ReceivedMessage message) {
        try {
            jobProcessor.process(message);
        } catch (RuntimeException e) {
            log.error("Unhandled error processing message {}", message.messageId(), e);
        } finally {
            activeJobs.decrementAndGet();
            capacity.release();
        }
    }

    /**
     * How long, after the drain deadline has interrupted the remaining jobs, they are given to hand
     * their messages back. An interrupt cannot cut short a blocking HTTP call, so this covers one
     * such call plus the hand-back writes.
     */
    static final Duration INTERRUPT_GRACE = Duration.ofSeconds(30);

    @Override
    public synchronized void stop() {
        if (!running) return;
        running = false;
        log.info("Shutdown requested: no longer polling, {} job(s) in flight, waiting up to {}",
                activeJobs.get(), config.getDrainTimeout());
        // The drain clock starts now; the poll thread may still be inside a long poll and is joined last.
        pollThread.interrupt();
        pool.shutdown();
        try {
            if (pool.awaitTermination(config.getDrainTimeout().toMillis(), TimeUnit.MILLISECONDS)) {
                log.info("Drain complete: all in-flight jobs finished");
            } else {
                log.warn("Drain deadline of {} reached with {} job(s) still running; interrupting them",
                        config.getDrainTimeout(), activeJobs.get());
                pool.shutdownNow();
                if (pool.awaitTermination(INTERRUPT_GRACE.toMillis(), TimeUnit.MILLISECONDS)) {
                    log.info("Interrupted jobs handed their messages back");
                } else {
                    log.error("{} job thread(s) did not stop within {} of being interrupted", activeJobs.get(), INTERRUPT_GRACE);
                }
            }
            pollThread.join(receiveWait.plusSeconds(5).toMillis());
        } catch (InterruptedException e) {
            pool.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return PHASE;
    }

    public int getActiveJobs() {
        return activeJobs.get();
    }
}
