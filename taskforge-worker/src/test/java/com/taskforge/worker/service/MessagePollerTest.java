package com.taskforge.worker.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.when;

/**
 * The drain: {@link MessagePoller#stop()} is what Spring's shutdown hook (SIGTERM) calls. It must
 * let in-flight jobs finish, and it must give up at the deadline.
 */
class MessagePollerTest {

    private final QueueService queueService = mock(QueueService.class);
    private final JobProcessor processor = mock(JobProcessor.class);
    private MessagePoller poller;

    private MessagePoller poller(Duration drainTimeout) {
        TaskForgeProperties properties = new TaskForgeProperties();
        properties.getWorker().setMaxConcurrent(2);
        properties.getWorker().setDrainTimeout(drainTimeout);
        properties.getWorker().setIdleWait(Duration.ofMillis(20));
        properties.getSqs().setWaitTime(Duration.ZERO);
        poller = new MessagePoller(queueService, processor, properties);
        return poller;
    }

    private static ReceivedMessage message(String id) {
        return new ReceivedMessage(id, "rh-" + id, "job-" + id, "cid", 1);
    }

    @AfterEach
    void stopPoller() {
        if (poller != null) poller.stop();
    }

    @Test
    void stopWaitsForInFlightJobsToFinish() throws Exception {
        MessagePoller poller = poller(Duration.ofSeconds(30));
        AtomicInteger deliveries = new AtomicInteger();
        when(queueService.receive(anyInt())).thenAnswer(inv ->
                deliveries.getAndIncrement() == 0 ? List.of(message("slow")) : List.<ReceivedMessage>of());
        CountDownLatch started = new CountDownLatch(1);
        AtomicBoolean finished = new AtomicBoolean();
        when(processor.process(message("slow"))).thenAnswer(inv -> {
            started.countDown();
            Thread.sleep(1_500);
            finished.set(true);
            return JobProcessor.Outcome.COMPLETED;
        });

        poller.start();
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(poller.getActiveJobs()).isEqualTo(1);

        long before = System.nanoTime();
        poller.stop();
        long elapsedMs = (System.nanoTime() - before) / 1_000_000;

        assertThat(finished).as("the in-flight job completed before stop() returned").isTrue();
        assertThat(elapsedMs).isBetween(1_000L, 10_000L);
        assertThat(poller.isRunning()).isFalse();
        assertThat(poller.getActiveJobs()).isZero();
    }

    @Test
    void stopInterruptsJobsThatOutliveTheDrainDeadline() throws Exception {
        MessagePoller poller = poller(Duration.ofSeconds(1));
        AtomicInteger deliveries = new AtomicInteger();
        when(queueService.receive(anyInt())).thenAnswer(inv ->
                deliveries.getAndIncrement() == 0 ? List.of(message("endless")) : List.<ReceivedMessage>of());
        CountDownLatch started = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean();
        when(processor.process(message("endless"))).thenAnswer(inv -> {
            started.countDown();
            try {
                Thread.sleep(60_000);
            } catch (InterruptedException e) {
                interrupted.set(true);
                Thread.currentThread().interrupt();
            }
            return JobProcessor.Outcome.INTERRUPTED;
        });

        poller.start();
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();

        long before = System.nanoTime();
        poller.stop();
        long elapsedMs = (System.nanoTime() - before) / 1_000_000;

        assertThat(interrupted).as("the job thread was interrupted at the deadline").isTrue();
        assertThat(elapsedMs).as("deadline enforced without waiting for the long poll first").isBetween(1_000L, 4_000L);
        assertThat(poller.getActiveJobs()).isZero();
    }

    @Test
    void messagesReceivedWhileStoppingAreHandedBackImmediately() throws Exception {
        MessagePoller poller = poller(Duration.ofSeconds(5));
        CountDownLatch polling = new CountDownLatch(1);
        AtomicBoolean stopped = new AtomicBoolean();
        when(queueService.receive(anyInt())).thenAnswer(inv -> {
            polling.countDown();
            while (!stopped.get()) {
                try {
                    Thread.sleep(10);   // a long poll that only returns after stop() has begun
                } catch (InterruptedException e) {
                    // The SDK's blocking receive is not cut short by an interrupt either.
                }
            }
            return List.of(message("late"));
        });

        poller.start();
        assertThat(polling.await(5, TimeUnit.SECONDS)).isTrue();
        Thread stopper = new Thread(poller::stop);
        stopper.start();
        Thread.sleep(200);
        stopped.set(true);
        stopper.join(10_000);

        org.mockito.Mockito.verify(queueService, org.mockito.Mockito.timeout(5_000)).changeVisibility("rh-late", 0);
        org.mockito.Mockito.verify(processor, never()).process(message("late"));
    }

    @Test
    void neverRunsMoreJobsThanConfiguredAtOnce() throws Exception {
        MessagePoller poller = poller(Duration.ofSeconds(10));
        AtomicInteger deliveries = new AtomicInteger();
        when(queueService.receive(anyInt())).thenAnswer(inv -> {
            int n = deliveries.getAndIncrement();
            return n < 3 ? List.of(message("a" + n), message("b" + n)) : List.<ReceivedMessage>of();
        });
        AtomicInteger concurrent = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        AtomicInteger done = new AtomicInteger();
        when(processor.process(org.mockito.ArgumentMatchers.any())).thenAnswer(inv -> {
            int now = concurrent.incrementAndGet();
            peak.accumulateAndGet(now, Math::max);
            Thread.sleep(100);
            concurrent.decrementAndGet();
            done.incrementAndGet();
            return JobProcessor.Outcome.COMPLETED;
        });

        poller.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (done.get() < 6 && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        poller.stop();

        assertThat(done.get()).isEqualTo(6);
        assertThat(peak.get()).isLessThanOrEqualTo(2);
    }
}
