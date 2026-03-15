package com.taskforge.common.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.*;

import java.util.List;
import java.util.Map;

@Service
public class QueueService {

    private static final Logger log = LoggerFactory.getLogger(QueueService.class);

    private final SqsClient sqs;
    private final ObjectMapper objectMapper;

    @Value("${taskforge.sqs.queue:taskforge-reports}")
    private String queueName;

    @Value("${taskforge.sqs.dlq:taskforge-reports-dlq}")
    private String dlqName;

    @Value("${taskforge.sqs.visibility-timeout:120}")
    private int visibilityTimeout;

    @Value("${taskforge.sqs.max-receive-count:3}")
    private int maxReceiveCount;

    private String queueUrl;
    private String dlqUrl;

    public QueueService(SqsClient sqs, ObjectMapper objectMapper) {
        this.sqs = sqs;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        this.dlqUrl = ensureQueue(dlqName, Map.of(
                QueueAttributeName.MESSAGE_RETENTION_PERIOD, "1209600"));

        String dlqArn = sqs.getQueueAttributes(GetQueueAttributesRequest.builder()
                .queueUrl(dlqUrl).attributeNames(QueueAttributeName.QUEUE_ARN).build())
                .attributes().get(QueueAttributeName.QUEUE_ARN);

        String redrivePolicy = "{\"deadLetterTargetArn\":\"%s\",\"maxReceiveCount\":\"%d\"}"
                .formatted(dlqArn, maxReceiveCount);

        this.queueUrl = ensureQueue(queueName, Map.of(
                QueueAttributeName.VISIBILITY_TIMEOUT, String.valueOf(visibilityTimeout),
                QueueAttributeName.REDRIVE_POLICY, redrivePolicy));

        log.info("SQS queues ready: main={}, dlq={}", queueUrl, dlqUrl);
    }

    private String ensureQueue(String name, Map<QueueAttributeName, String> attrs) {
        try {
            return sqs.getQueueUrl(GetQueueUrlRequest.builder().queueName(name).build()).queueUrl();
        } catch (QueueDoesNotExistException e) {
            return sqs.createQueue(CreateQueueRequest.builder()
                    .queueName(name).attributes(attrs).build()).queueUrl();
        }
    }

    public void enqueue(String jobId, String correlationId, int delaySeconds) {
        try {
            String body = objectMapper.writeValueAsString(Map.of("jobId", jobId));
            sqs.sendMessage(SendMessageRequest.builder()
                    .queueUrl(queueUrl)
                    .messageBody(body)
                    .delaySeconds(Math.min(delaySeconds, 900))
                    .messageAttributes(Map.of("correlationId",
                            MessageAttributeValue.builder()
                                    .dataType("String").stringValue(correlationId).build()))
                    .build());
            log.debug("[{}] Enqueued job {}", correlationId, jobId);
        } catch (Exception e) {
            throw new RuntimeException("Failed to enqueue job " + jobId, e);
        }
    }

    public void enqueue(String jobId, String correlationId) {
        enqueue(jobId, correlationId, 0);
    }

    public List<Message> receive(int maxMessages) {
        return sqs.receiveMessage(ReceiveMessageRequest.builder()
                .queueUrl(queueUrl)
                .maxNumberOfMessages(Math.min(maxMessages, 10))
                .waitTimeSeconds(10)
                .visibilityTimeout(visibilityTimeout)
                .messageAttributeNames("All")
                .build()).messages();
    }

    public void delete(String receiptHandle) {
        sqs.deleteMessage(DeleteMessageRequest.builder()
                .queueUrl(queueUrl).receiptHandle(receiptHandle).build());
    }

    public int approximateMessageCount() {
        try {
            var attrs = sqs.getQueueAttributes(GetQueueAttributesRequest.builder()
                    .queueUrl(queueUrl)
                    .attributeNames(QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES).build()).attributes();
            return Integer.parseInt(attrs.getOrDefault(
                    QueueAttributeName.APPROXIMATE_NUMBER_OF_MESSAGES, "0"));
        } catch (Exception e) {
            return -1;
        }
    }
}
