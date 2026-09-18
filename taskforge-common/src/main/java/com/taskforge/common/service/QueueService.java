package com.taskforge.common.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.exception.QueueUnavailableException;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.ChangeMessageVisibilityRequest;
import software.amazon.awssdk.services.sqs.model.CreateQueueRequest;
import software.amazon.awssdk.services.sqs.model.DeleteMessageRequest;
import software.amazon.awssdk.services.sqs.model.GetQueueAttributesRequest;
import software.amazon.awssdk.services.sqs.model.GetQueueUrlRequest;
import software.amazon.awssdk.services.sqs.model.Message;
import software.amazon.awssdk.services.sqs.model.MessageAttributeValue;
import software.amazon.awssdk.services.sqs.model.MessageSystemAttributeName;
import software.amazon.awssdk.services.sqs.model.QueueAttributeName;
import software.amazon.awssdk.services.sqs.model.QueueDoesNotExistException;
import software.amazon.awssdk.services.sqs.model.ReceiveMessageRequest;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;
import software.amazon.awssdk.services.sqs.model.SetQueueAttributesRequest;
import software.amazon.awssdk.services.sqs.model.SqsException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The main job queue and its dead-letter queue.
 *
 * <p>Retries never re-send a message. A failed attempt calls {@link #changeVisibility} with the
 * backoff, so SQS redelivers the same message later and counts the delivery. After
 * {@code taskforge.retry.max-attempts} deliveries the redrive policy moves the message to the
 * dead-letter queue, which the worker's {@code DeadLetterConsumer} reads with
 * {@link #receiveDeadLetters}.
 */
@Service
public class QueueService {

    private static final Logger log = LoggerFactory.getLogger(QueueService.class);

    /** SQS rejects visibility timeouts above 12 hours. */
    static final int MAX_VISIBILITY_SECONDS = 43_200;

    /** One received message, with the fields the worker needs. */
    public record ReceivedMessage(String messageId, String receiptHandle, String jobId, String correlationId,
                                  int receiveCount) {
    }

    private final SqsClient sqs;
    private final ObjectMapper json;
    private final TaskForgeProperties.Sqs config;
    private final int maxReceiveCount;

    private String queueUrl;
    private String dlqUrl;

    public QueueService(SqsClient sqs, ObjectMapper json, TaskForgeProperties properties) {
        this.sqs = sqs;
        this.json = json;
        this.config = properties.getSqs();
        this.maxReceiveCount = properties.getRetry().getMaxAttempts();
    }

    @PostConstruct
    public void init() {
        this.dlqUrl = ensureQueue(config.getDlq(), Map.of(
                QueueAttributeName.MESSAGE_RETENTION_PERIOD, String.valueOf(config.getDlqRetention().toSeconds())));
        String dlqArn = sqs.getQueueAttributes(GetQueueAttributesRequest.builder()
                        .queueUrl(dlqUrl).attributeNames(QueueAttributeName.QUEUE_ARN).build())
                .attributes().get(QueueAttributeName.QUEUE_ARN);

        Map<QueueAttributeName, String> mainAttributes = Map.of(
                QueueAttributeName.VISIBILITY_TIMEOUT, String.valueOf(config.getVisibilityTimeout().toSeconds()),
                QueueAttributeName.REDRIVE_POLICY,
                "{\"deadLetterTargetArn\":\"%s\",\"maxReceiveCount\":\"%d\"}".formatted(dlqArn, maxReceiveCount));
        this.queueUrl = ensureQueue(config.getQueue(), mainAttributes);
        // An existing queue keeps whatever it was created with; align it with the configuration so
        // the redrive threshold always equals the retry budget the workers apply.
        sqs.setQueueAttributes(SetQueueAttributesRequest.builder().queueUrl(queueUrl).attributes(mainAttributes).build());

        log.info("SQS ready: queue={} (visibility {}s, redrive after {} receives), dlq={}",
                queueUrl, config.getVisibilityTimeout().toSeconds(), maxReceiveCount, dlqUrl);
    }

    private String ensureQueue(String name, Map<QueueAttributeName, String> attributes) {
        try {
            return sqs.getQueueUrl(GetQueueUrlRequest.builder().queueName(name).build()).queueUrl();
        } catch (QueueDoesNotExistException e) {
            log.info("Creating SQS queue '{}'", name);
            return sqs.createQueue(CreateQueueRequest.builder().queueName(name).attributes(attributes).build()).queueUrl();
        } catch (SqsException e) {
            // Some emulators report the missing queue under the legacy error code.
            String code = e.awsErrorDetails() == null ? "" : String.valueOf(e.awsErrorDetails().errorCode());
            if (code.contains("NonExistentQueue") || code.contains("QueueDoesNotExist")) {
                log.info("Creating SQS queue '{}'", name);
                return sqs.createQueue(CreateQueueRequest.builder().queueName(name).attributes(attributes).build()).queueUrl();
            }
            throw e;
        }
    }

    // ---- main queue --------------------------------------------------------------------------

    /** Sends the message for a job. The correlation id travels as a message attribute. */
    public void enqueue(String jobId, String correlationId) {
        try {
            sqs.sendMessage(SendMessageRequest.builder()
                    .queueUrl(queueUrl)
                    .messageBody(json.writeValueAsString(Map.of("jobId", jobId)))
                    .messageAttributes(Map.of(CorrelationId.SQS_ATTRIBUTE, MessageAttributeValue.builder()
                            .dataType("String").stringValue(correlationId).build()))
                    .build());
            log.debug("Enqueued job {}", jobId);
        } catch (SdkException e) {
            throw new QueueUnavailableException("Could not enqueue job " + jobId, e);
        }
    }

    /** Long-polls the main queue; received messages stay hidden for the configured visibility timeout. */
    public List<ReceivedMessage> receive(int maxMessages) {
        return receiveFrom(queueUrl, maxMessages, config.getWaitTime());
    }

    public void delete(String receiptHandle) {
        sqs.deleteMessage(DeleteMessageRequest.builder().queueUrl(queueUrl).receiptHandle(receiptHandle).build());
    }

    /**
     * Hides a received message for {@code seconds} more, after which SQS delivers it again. Zero
     * makes it visible at once. This is how a retry is scheduled.
     */
    public void changeVisibility(String receiptHandle, int seconds) {
        int clamped = Math.max(0, Math.min(seconds, MAX_VISIBILITY_SECONDS));
        sqs.changeMessageVisibility(ChangeMessageVisibilityRequest.builder()
                .queueUrl(queueUrl).receiptHandle(receiptHandle).visibilityTimeout(clamped).build());
    }

    // ---- dead-letter queue -------------------------------------------------------------------

    public List<ReceivedMessage> receiveDeadLetters(int maxMessages, Duration wait) {
        return receiveFrom(dlqUrl, maxMessages, wait);
    }

    public void deleteDeadLetter(String receiptHandle) {
        sqs.deleteMessage(DeleteMessageRequest.builder().queueUrl(dlqUrl).receiptHandle(receiptHandle).build());
    }

    // ---- depth -------------------------------------------------------------------------------

    /** Messages visible in the main queue (approximate, as reported by SQS). */
    public int queueDepth() {
        return depth(queueUrl);
    }

    public int deadLetterDepth() {
        return depth(dlqUrl);
    }

    private int depth(String url) {
        var attrs = sqs.getQueueAttributes(GetQueueAttributesRequest.builder()
                .queueUrl(url).attributeNames(QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES).build()).attributes();
        return Integer.parseInt(attrs.getOrDefault(QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES, "0"));
    }

    // ---- helpers -----------------------------------------------------------------------------

    private List<ReceivedMessage> receiveFrom(String url, int maxMessages, Duration wait) {
        List<Message> messages = sqs.receiveMessage(ReceiveMessageRequest.builder()
                .queueUrl(url)
                .maxNumberOfMessages(Math.max(1, Math.min(maxMessages, 10)))
                .waitTimeSeconds((int) Math.min(20, wait.toSeconds()))
                .messageSystemAttributeNames(MessageSystemAttributeName.APPROXIMATE_RECEIVE_COUNT)
                .messageAttributeNames("All")
                .build()).messages();
        List<ReceivedMessage> result = new ArrayList<>(messages.size());
        for (Message m : messages) {
            result.add(new ReceivedMessage(m.messageId(), m.receiptHandle(), parseJobId(m.body()),
                    correlationIdOf(m), receiveCountOf(m)));
        }
        return result;
    }

    private String parseJobId(String body) {
        try {
            JsonNode node = json.readTree(body).get("jobId");
            return node == null || node.isNull() ? null : node.asString();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String correlationIdOf(Message m) {
        MessageAttributeValue attr = m.messageAttributes().get(CorrelationId.SQS_ATTRIBUTE);
        return attr == null ? null : attr.stringValue();
    }

    private static int receiveCountOf(Message m) {
        String count = m.attributes().get(MessageSystemAttributeName.APPROXIMATE_RECEIVE_COUNT);
        try {
            return count == null ? 1 : Integer.parseInt(count);
        } catch (NumberFormatException e) {
            return 1;
        }
    }
}
