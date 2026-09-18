package com.taskforge.common.repository;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportNotFoundException;
import com.taskforge.common.model.ReportJob;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.*;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Repository
public class ReportJobRepository {

    private static final Logger log = LoggerFactory.getLogger(ReportJobRepository.class);

    private final DynamoDbClient dynamoDb;
    private final ObjectMapper objectMapper;

    @Value("${taskforge.dynamodb.table:taskforge-reports}")
    private String tableName;

    public ReportJobRepository(DynamoDbClient dynamoDb, ObjectMapper objectMapper) {
        this.dynamoDb = dynamoDb;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        ensureTableExists();
    }

    private void ensureTableExists() {
        try {
            dynamoDb.describeTable(DescribeTableRequest.builder().tableName(tableName).build());
            log.info("DynamoDB table '{}' exists", tableName);
        } catch (ResourceNotFoundException e) {
            log.info("Creating DynamoDB table '{}'...", tableName);
            dynamoDb.createTable(CreateTableRequest.builder()
                    .tableName(tableName)
                    .keySchema(KeySchemaElement.builder()
                            .attributeName("id").keyType(KeyType.HASH).build())
                    .attributeDefinitions(
                            attr("id", ScalarAttributeType.S),
                            attr("status", ScalarAttributeType.S),
                            attr("idempotencyKey", ScalarAttributeType.S))
                    .globalSecondaryIndexes(
                            gsi("status-index", "status"),
                            gsi("idempotency-index", "idempotencyKey"))
                    .provisionedThroughput(ProvisionedThroughput.builder()
                            .readCapacityUnits(5L).writeCapacityUnits(5L).build())
                    .build());

            // Enable TTL
            try {
                dynamoDb.updateTimeToLive(UpdateTimeToLiveRequest.builder()
                        .tableName(tableName)
                        .timeToLiveSpecification(TimeToLiveSpecification.builder()
                                .attributeName("ttl").enabled(true).build())
                        .build());
            } catch (Exception ttlErr) {
                log.warn("Could not enable TTL (may not be supported in LocalStack): {}", ttlErr.getMessage());
            }

            log.info("DynamoDB table '{}' created with TTL", tableName);
        }
    }

    public ReportJob save(ReportJob job) {
        dynamoDb.putItem(PutItemRequest.builder()
                .tableName(tableName).item(toItem(job)).build());
        return job;
    }

    public Optional<ReportJob> findById(String id) {
        var resp = dynamoDb.getItem(GetItemRequest.builder()
                .tableName(tableName)
                .key(Map.of("id", s(id)))
                .build());
        if (!resp.hasItem() || resp.item().isEmpty()) return Optional.empty();
        return Optional.of(fromItem(resp.item()));
    }

    public ReportJob findByIdOrThrow(String id) {
        return findById(id).orElseThrow(() -> new ReportNotFoundException(id));
    }

    public Optional<ReportJob> findByIdempotencyKey(String key) {
        var resp = dynamoDb.query(QueryRequest.builder()
                .tableName(tableName).indexName("idempotency-index")
                .keyConditionExpression("idempotencyKey = :key")
                .expressionAttributeValues(Map.of(":key", s(key)))
                .limit(1).build());
        if (resp.items().isEmpty()) return Optional.empty();
        return Optional.of(fromItem(resp.items().get(0)));
    }

    public List<ReportJob> findByStatus(ReportStatus status) {
        var resp = dynamoDb.query(QueryRequest.builder()
                .tableName(tableName).indexName("status-index")
                .keyConditionExpression("#s = :status")
                .expressionAttributeNames(Map.of("#s", "status"))
                .expressionAttributeValues(Map.of(":status", s(status.name())))
                .build());
        return resp.items().stream().map(this::fromItem).collect(Collectors.toList());
    }

    public List<ReportJob> findAll() {
        var resp = dynamoDb.scan(ScanRequest.builder().tableName(tableName).build());
        return resp.items().stream().map(this::fromItem).collect(Collectors.toList());
    }


    private Map<String, AttributeValue> toItem(ReportJob job) {
        Map<String, AttributeValue> item = new HashMap<>();
        item.put("id", s(job.getId()));
        item.put("type", s(job.getType().name()));
        item.put("status", s(job.getStatus().name()));
        item.put("correlationId", s(job.getCorrelationId()));
        item.put("attemptCount", n(job.getAttemptCount()));
        item.put("maxRetries", n(job.getMaxRetries()));
        item.put("executionTimeMs", n(job.getExecutionTimeMs()));
        item.put("ttl", n(job.getTtl()));
        item.put("createdAt", s(job.getCreatedAt().toString()));
        item.put("updatedAt", s(job.getUpdatedAt().toString()));

        if (job.getParameters() != null && !job.getParameters().isEmpty()) {
            try {
                item.put("parameters", s(objectMapper.writeValueAsString(job.getParameters())));
            } catch (JacksonException e) {
                log.error("[{}] Failed to serialize parameters", job.getCorrelationId(), e);
            }
        }
        putIfPresent(item, "idempotencyKey", job.getIdempotencyKey());
        putIfPresent(item, "fileKey", job.getFileKey());
        putIfPresent(item, "errorMessage", job.getErrorMessage());
        if (job.getCompletedAt() != null) item.put("completedAt", s(job.getCompletedAt().toString()));

        return item;
    }

    @SuppressWarnings("unchecked")
    private ReportJob fromItem(Map<String, AttributeValue> item) {
        ReportJob job = new ReportJob();
        job.setId(item.get("id").s());
        job.setType(ReportType.valueOf(item.get("type").s()));
        job.setStatus(ReportStatus.valueOf(item.get("status").s()));
        job.setCorrelationId(item.get("correlationId").s());
        job.setAttemptCount(Integer.parseInt(item.get("attemptCount").n()));
        job.setMaxRetries(Integer.parseInt(item.get("maxRetries").n()));
        job.setExecutionTimeMs(Long.parseLong(item.get("executionTimeMs").n()));
        job.setTtl(Long.parseLong(item.get("ttl").n()));
        job.setCreatedAt(Instant.parse(item.get("createdAt").s()));
        job.setUpdatedAt(Instant.parse(item.get("updatedAt").s()));

        if (item.containsKey("parameters")) {
            try {
                job.setParameters(objectMapper.readValue(item.get("parameters").s(), Map.class));
            } catch (JacksonException e) {
                log.error("Failed to deserialize parameters", e);
            }
        }
        if (item.containsKey("idempotencyKey")) job.setIdempotencyKey(item.get("idempotencyKey").s());
        if (item.containsKey("fileKey")) job.setFileKey(item.get("fileKey").s());
        if (item.containsKey("errorMessage")) job.setErrorMessage(item.get("errorMessage").s());
        if (item.containsKey("completedAt")) job.setCompletedAt(Instant.parse(item.get("completedAt").s()));

        return job;
    }

    private static AttributeValue s(String val) { return AttributeValue.builder().s(val).build(); }
    private static AttributeValue n(long val) { return AttributeValue.builder().n(String.valueOf(val)).build(); }
    private static AttributeDefinition attr(String name, ScalarAttributeType type) {
        return AttributeDefinition.builder().attributeName(name).attributeType(type).build();
    }
    private static GlobalSecondaryIndex gsi(String indexName, String hashKey) {
        return GlobalSecondaryIndex.builder()
                .indexName(indexName)
                .keySchema(KeySchemaElement.builder().attributeName(hashKey).keyType(KeyType.HASH).build())
                .projection(Projection.builder().projectionType(ProjectionType.ALL).build())
                .provisionedThroughput(ProvisionedThroughput.builder().readCapacityUnits(5L).writeCapacityUnits(5L).build())
                .build();
    }
    private static void putIfPresent(Map<String, AttributeValue> item, String key, String val) {
        if (val != null && !val.isBlank()) item.put(key, s(val));
    }
}
