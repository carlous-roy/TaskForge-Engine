package com.taskforge.common.service;

import com.taskforge.common.EmulatorSupport;
import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Runs against LocalStack (Testcontainers) or the emulator named by AWS_ENDPOINT_OVERRIDE. */
class QueueServiceIT {

    private static QueueService queue;

    @BeforeAll
    static void createQueues() {
        TaskForgeProperties properties = EmulatorSupport.uniqueProperties("queue-it");
        properties.getSqs().setVisibilityTimeout(Duration.ofSeconds(2));
        properties.getSqs().setWaitTime(Duration.ofSeconds(1));
        properties.getRetry().setMaxAttempts(3);
        queue = new QueueService(EmulatorSupport.awsConfig().sqsClient(), JsonMapper.builder().build(), properties);
        queue.init();
        queue.init(); // idempotent: queues exist and attributes are re-applied
    }

    @Test
    void carriesJobIdCorrelationIdAndReceiveCount() {
        String jobId = UUID.randomUUID().toString();
        queue.enqueue(jobId, "cid-42");

        ReceivedMessage m = receiveOne(jobId);
        assertThat(m.correlationId()).isEqualTo("cid-42");
        assertThat(m.receiveCount()).isEqualTo(1);
        queue.delete(m.receiptHandle());
    }

    @Test
    void changingVisibilityRedeliversTheSameMessageAndCountsIt() throws InterruptedException {
        String jobId = UUID.randomUUID().toString();
        queue.enqueue(jobId, "cid-vis");

        ReceivedMessage first = receiveOne(jobId);
        queue.changeVisibility(first.receiptHandle(), 1);
        Thread.sleep(1_200);

        ReceivedMessage second = receiveOne(jobId);
        assertThat(second.messageId()).isEqualTo(first.messageId());
        assertThat(second.receiveCount()).isEqualTo(2);
        queue.delete(second.receiptHandle());
    }

    @Test
    void afterMaxAttemptsDeliveriesTheMessageMovesToTheDeadLetterQueue() {
        String jobId = UUID.randomUUID().toString();
        queue.enqueue(jobId, "cid-dlq");

        for (int delivery = 1; delivery <= 3; delivery++) {
            ReceivedMessage m = receiveOne(jobId);
            assertThat(m.receiveCount()).isEqualTo(delivery);
            queue.changeVisibility(m.receiptHandle(), 0);
        }
        // Fourth receive: SQS moves the message to the DLQ instead of delivering it.
        assertThat(drain(jobId, 5)).isEmpty();

        ReceivedMessage dead = null;
        for (int i = 0; i < 10 && dead == null; i++) {
            dead = queue.receiveDeadLetters(10, Duration.ofSeconds(1)).stream()
                    .filter(m -> jobId.equals(m.jobId())).findFirst().orElse(null);
        }
        assertThat(dead).isNotNull();
        assertThat(dead.correlationId()).as("message attributes survive the redrive").isEqualTo("cid-dlq");
        queue.deleteDeadLetter(dead.receiptHandle());
    }

    @Test
    void reportsDepths() {
        assertThat(queue.queueDepth()).isGreaterThanOrEqualTo(0);
        assertThat(queue.deadLetterDepth()).isGreaterThanOrEqualTo(0);
    }

    private static ReceivedMessage receiveOne(String jobId) {
        for (int i = 0; i < 15; i++) {
            for (ReceivedMessage m : queue.receive(10)) {
                if (jobId.equals(m.jobId())) return m;
                queue.changeVisibility(m.receiptHandle(), 0); // not ours: give it back at once
            }
        }
        throw new AssertionError("Message for job " + jobId + " was not delivered");
    }

    private static List<ReceivedMessage> drain(String jobId, int polls) {
        for (int i = 0; i < polls; i++) {
            List<ReceivedMessage> mine = queue.receive(10).stream().filter(m -> jobId.equals(m.jobId())).toList();
            if (!mine.isEmpty()) return mine;
        }
        return List.of();
    }
}
