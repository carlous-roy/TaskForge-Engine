package com.taskforge.common.repository;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Repository;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.CancellationReason;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.CreateTableRequest;
import software.amazon.awssdk.services.dynamodb.model.Delete;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.DescribeTableRequest;
import software.amazon.awssdk.services.dynamodb.model.DescribeTimeToLiveRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.GlobalSecondaryIndex;
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement;
import software.amazon.awssdk.services.dynamodb.model.KeyType;
import software.amazon.awssdk.services.dynamodb.model.Projection;
import software.amazon.awssdk.services.dynamodb.model.ProjectionType;
import software.amazon.awssdk.services.dynamodb.model.ProvisionedThroughput;
import software.amazon.awssdk.services.dynamodb.model.Put;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.ResourceInUseException;
import software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException;
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType;
import software.amazon.awssdk.services.dynamodb.model.ScanRequest;
import software.amazon.awssdk.services.dynamodb.model.TableStatus;
import software.amazon.awssdk.services.dynamodb.model.TimeToLiveSpecification;
import software.amazon.awssdk.services.dynamodb.model.TimeToLiveStatus;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException;
import software.amazon.awssdk.services.dynamodb.model.UpdateTimeToLiveRequest;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Job records in one DynamoDB table.
 *
 * <p>Two kinds of item share the table, told apart by the partition key:
 * <ul>
 *   <li>{@code id = <uuid>}: a job record, see {@link ReportJob}.</li>
 *   <li>{@code id = KEY#<idempotencyKey>}: a marker pointing at the job that owns that key. It is
 *       written in the same transaction as the job with {@code attribute_not_exists(id)}, so two
 *       submissions racing on one key cannot both succeed; the loser learns the winner's job id.</li>
 * </ul>
 *
 * <p>Every write to an existing job is conditional on its {@code version} attribute (optimistic
 * locking). The {@code status-index} global secondary index serves status filters; it only contains
 * job records because key markers have no {@code status} attribute.
 */
@Repository
public class ReportJobRepository {

    private static final Logger log = LoggerFactory.getLogger(ReportJobRepository.class);

    static final String KEY_PREFIX = "KEY#";
    static final String STATUS_INDEX = "status-index";
    private static final int MAX_ERROR_LENGTH = 1_000;

    private final DynamoDbClient dynamoDb;
    private final String tableName;

    public ReportJobRepository(DynamoDbClient dynamoDb, TaskForgeProperties properties) {
        this.dynamoDb = dynamoDb;
        this.tableName = properties.getDynamodb().getTable();
    }

    @PostConstruct
    public void init() {
        ensureTableExists();
    }

    // ---- provisioning ------------------------------------------------------------------------

    private void ensureTableExists() {
        try {
            var table = dynamoDb.describeTable(DescribeTableRequest.builder().tableName(tableName).build()).table();
            if (table.tableStatus() != TableStatus.ACTIVE) {
                log.info("DynamoDB table '{}' is {}, waiting for ACTIVE", tableName, table.tableStatus());
                waitUntilActive();
            }
            log.info("DynamoDB table '{}' exists", tableName);
        } catch (ResourceNotFoundException e) {
            createTable();
        }
        ensureTtlEnabled();
    }

    private void createTable() {
        try {
            log.info("Creating DynamoDB table '{}'", tableName);
            dynamoDb.createTable(CreateTableRequest.builder()
                    .tableName(tableName)
                    .keySchema(KeySchemaElement.builder().attributeName("id").keyType(KeyType.HASH).build())
                    .attributeDefinitions(
                            attr("id", ScalarAttributeType.S),
                            attr("status", ScalarAttributeType.S))
                    .globalSecondaryIndexes(GlobalSecondaryIndex.builder()
                            .indexName(STATUS_INDEX)
                            .keySchema(KeySchemaElement.builder().attributeName("status").keyType(KeyType.HASH).build())
                            .projection(Projection.builder().projectionType(ProjectionType.ALL).build())
                            .provisionedThroughput(throughput())
                            .build())
                    .provisionedThroughput(throughput())
                    .build());
        } catch (ResourceInUseException e) {
            // Another instance created it between our describe and create; that is fine.
            log.info("DynamoDB table '{}' is being created by another process", tableName);
        }
        waitUntilActive();
        log.info("DynamoDB table '{}' is ACTIVE", tableName);
    }

    private void waitUntilActive() {
        dynamoDb.waiter().waitUntilTableExists(DescribeTableRequest.builder().tableName(tableName).build());
    }

    private void ensureTtlEnabled() {
        try {
            var ttl = dynamoDb.describeTimeToLive(DescribeTimeToLiveRequest.builder().tableName(tableName).build())
                    .timeToLiveDescription();
            if (ttl != null && (ttl.timeToLiveStatus() == TimeToLiveStatus.ENABLED
                    || ttl.timeToLiveStatus() == TimeToLiveStatus.ENABLING)) {
                return;
            }
            dynamoDb.updateTimeToLive(UpdateTimeToLiveRequest.builder()
                    .tableName(tableName)
                    .timeToLiveSpecification(TimeToLiveSpecification.builder().attributeName("ttl").enabled(true).build())
                    .build());
            log.info("DynamoDB TTL enabled on '{}' (attribute 'ttl')", tableName);
        } catch (RuntimeException e) {
            log.warn("Could not enable TTL on '{}': {}", tableName, e.getMessage());
        }
    }

    // ---- writes ------------------------------------------------------------------------------

    /**
     * Inserts a new job. With an idempotency key, the job and its {@code KEY#} marker are written in
     * one transaction, each conditional on not existing yet.
     *
     * @throws DuplicateReportException if the key already belongs to another job
     */
    public void create(ReportJob job) {
        Map<String, AttributeValue> item = toItem(job, job.getVersion());
        if (job.getIdempotencyKey() == null) {
            dynamoDb.putItem(PutItemRequest.builder()
                    .tableName(tableName).item(item)
                    .conditionExpression("attribute_not_exists(id)")
                    .build());
            return;
        }
        Map<String, AttributeValue> marker = new HashMap<>();
        marker.put("id", s(KEY_PREFIX + job.getIdempotencyKey()));
        marker.put("jobId", s(job.getId()));
        marker.put("createdAt", s(job.getCreatedAt().toString()));
        marker.put("ttl", n(job.getTtl()));
        try {
            dynamoDb.transactWriteItems(TransactWriteItemsRequest.builder()
                    .transactItems(
                            TransactWriteItem.builder().put(Put.builder()
                                    .tableName(tableName).item(item)
                                    .conditionExpression("attribute_not_exists(id)").build()).build(),
                            TransactWriteItem.builder().put(Put.builder()
                                    .tableName(tableName).item(marker)
                                    .conditionExpression("attribute_not_exists(id)").build()).build())
                    .build());
        } catch (TransactionCanceledException e) {
            if (conditionFailed(e, 1)) {
                String existingId = findJobIdByIdempotencyKey(job.getIdempotencyKey()).orElse(null);
                throw new DuplicateReportException(job.getIdempotencyKey(), existingId);
            }
            if (conditionFailed(e, 0)) {
                throw new IllegalStateException("Job id collision for " + job.getId(), e);
            }
            throw e;
        }
    }

    /**
     * Writes the job if its stored version still equals {@code job.getVersion()}, then bumps the
     * in-memory version to match the store.
     *
     * @throws StaleJobException if another process has written the job since it was loaded
     */
    public void update(ReportJob job) {
        long expected = job.getVersion();
        long next = expected + 1;
        try {
            dynamoDb.putItem(PutItemRequest.builder()
                    .tableName(tableName)
                    .item(toItem(job, next))
                    .conditionExpression("#v = :expected")
                    .expressionAttributeNames(Map.of("#v", "version"))
                    .expressionAttributeValues(Map.of(":expected", n(expected)))
                    .build());
        } catch (ConditionalCheckFailedException e) {
            throw new StaleJobException(job.getId(), expected);
        }
        job.setVersion(next);
    }

    /** Removes a job and its key marker, used when the message for a new job could not be sent. */
    public void delete(String jobId, String idempotencyKey) {
        if (idempotencyKey == null) {
            dynamoDb.deleteItem(DeleteItemRequest.builder().tableName(tableName).key(Map.of("id", s(jobId))).build());
            return;
        }
        dynamoDb.transactWriteItems(TransactWriteItemsRequest.builder()
                .transactItems(
                        TransactWriteItem.builder().delete(Delete.builder()
                                .tableName(tableName).key(Map.of("id", s(jobId))).build()).build(),
                        TransactWriteItem.builder().delete(Delete.builder()
                                .tableName(tableName).key(Map.of("id", s(KEY_PREFIX + idempotencyKey))).build()).build())
                .build());
    }

    // ---- reads -------------------------------------------------------------------------------

    public Optional<ReportJob> findById(String id) {
        if (id == null || id.startsWith(KEY_PREFIX)) {
            return Optional.empty();
        }
        var resp = dynamoDb.getItem(GetItemRequest.builder()
                .tableName(tableName).key(Map.of("id", s(id))).consistentRead(true).build());
        if (!resp.hasItem() || resp.item().isEmpty()) return Optional.empty();
        return Optional.of(fromItem(resp.item()));
    }

    public Optional<String> findJobIdByIdempotencyKey(String key) {
        var resp = dynamoDb.getItem(GetItemRequest.builder()
                .tableName(tableName).key(Map.of("id", s(KEY_PREFIX + key))).consistentRead(true).build());
        if (!resp.hasItem() || resp.item().isEmpty()) return Optional.empty();
        return Optional.ofNullable(resp.item().get("jobId")).map(AttributeValue::s);
    }

    /** All jobs, newest first, at most {@code limit}. Reads every page of the scan. */
    public List<ReportJob> findAll(int limit) {
        List<ReportJob> jobs = new ArrayList<>();
        dynamoDb.scanPaginator(ScanRequest.builder()
                        .tableName(tableName)
                        .filterExpression("NOT begins_with(id, :keyPrefix)")
                        .expressionAttributeValues(Map.of(":keyPrefix", s(KEY_PREFIX)))
                        .build())
                .items().forEach(item -> jobs.add(fromItem(item)));
        return newestFirst(jobs, limit);
    }

    /** Jobs in one status, newest first, at most {@code limit}. Reads every page of the index query. */
    public List<ReportJob> findByStatus(ReportStatus status, int limit) {
        List<ReportJob> jobs = new ArrayList<>();
        dynamoDb.queryPaginator(QueryRequest.builder()
                        .tableName(tableName).indexName(STATUS_INDEX)
                        .keyConditionExpression("#s = :status")
                        .expressionAttributeNames(Map.of("#s", "status"))
                        .expressionAttributeValues(Map.of(":status", s(status.name())))
                        .build())
                .items().forEach(item -> jobs.add(fromItem(item)));
        return newestFirst(jobs, limit);
    }

    private static List<ReportJob> newestFirst(List<ReportJob> jobs, int limit) {
        jobs.sort(Comparator.comparing(ReportJob::getCreatedAt, Comparator.nullsLast(Comparator.reverseOrder())));
        return jobs.size() > limit ? new ArrayList<>(jobs.subList(0, limit)) : jobs;
    }

    // ---- mapping -----------------------------------------------------------------------------

    private static Map<String, AttributeValue> toItem(ReportJob job, long version) {
        Map<String, AttributeValue> item = new HashMap<>();
        item.put("id", s(job.getId()));
        item.put("type", s(job.getType().name()));
        item.put("status", s(job.getStatus().name()));
        item.put("correlationId", s(job.getCorrelationId()));
        item.put("attemptCount", n(job.getAttemptCount()));
        item.put("maxAttempts", n(job.getMaxAttempts()));
        item.put("version", n(version));
        item.put("executionTimeMs", n(job.getExecutionTimeMs()));
        item.put("ttl", n(job.getTtl()));
        item.put("createdAt", s(job.getCreatedAt().toString()));
        item.put("updatedAt", s(job.getUpdatedAt().toString()));
        if (!job.getParameters().isEmpty()) {
            Map<String, AttributeValue> params = new LinkedHashMap<>();
            job.getParameters().forEach((k, v) -> params.put(k, s(v)));
            item.put("parameters", AttributeValue.builder().m(params).build());
        }
        putIfPresent(item, "idempotencyKey", job.getIdempotencyKey());
        putIfPresent(item, "fileKey", job.getFileKey());
        putIfPresent(item, "errorMessage", truncate(job.getErrorMessage()));
        putIfPresent(item, "lockedBy", job.getLockedBy());
        putIfPresent(item, "completedAt", job.getCompletedAt());
        putIfPresent(item, "nextAttemptAt", job.getNextAttemptAt());
        putIfPresent(item, "deadLetteredAt", job.getDeadLetteredAt());
        return item;
    }

    private static ReportJob fromItem(Map<String, AttributeValue> item) {
        ReportJob job = new ReportJob();
        job.setId(item.get("id").s());
        job.setType(ReportType.valueOf(item.get("type").s()));
        job.setStatus(ReportStatus.valueOf(item.get("status").s()));
        job.setCorrelationId(item.get("correlationId").s());
        job.setAttemptCount(Integer.parseInt(item.get("attemptCount").n()));
        job.setMaxAttempts(Integer.parseInt(item.get("maxAttempts").n()));
        job.setVersion(Long.parseLong(item.get("version").n()));
        job.setExecutionTimeMs(Long.parseLong(item.get("executionTimeMs").n()));
        job.setTtl(Long.parseLong(item.get("ttl").n()));
        job.setCreatedAt(Instant.parse(item.get("createdAt").s()));
        job.setUpdatedAt(Instant.parse(item.get("updatedAt").s()));
        if (item.containsKey("parameters")) {
            Map<String, String> params = new LinkedHashMap<>();
            item.get("parameters").m().forEach((k, v) -> params.put(k, v.s()));
            job.setParameters(params);
        }
        job.setIdempotencyKey(str(item, "idempotencyKey"));
        job.setFileKey(str(item, "fileKey"));
        job.setErrorMessage(str(item, "errorMessage"));
        job.setLockedBy(str(item, "lockedBy"));
        job.setCompletedAt(instant(item, "completedAt"));
        job.setNextAttemptAt(instant(item, "nextAttemptAt"));
        job.setDeadLetteredAt(instant(item, "deadLetteredAt"));
        return job;
    }

    private static boolean conditionFailed(TransactionCanceledException e, int index) {
        List<CancellationReason> reasons = e.cancellationReasons();
        return reasons != null && reasons.size() > index
                && "ConditionalCheckFailed".equals(reasons.get(index).code());
    }

    private static String truncate(String message) {
        if (message == null || message.length() <= MAX_ERROR_LENGTH) return message;
        return message.substring(0, MAX_ERROR_LENGTH - 3) + "...";
    }

    private static ProvisionedThroughput throughput() {
        return ProvisionedThroughput.builder().readCapacityUnits(5L).writeCapacityUnits(5L).build();
    }

    private static AttributeValue s(String val) { return AttributeValue.builder().s(val).build(); }
    private static AttributeValue n(long val) { return AttributeValue.builder().n(String.valueOf(val)).build(); }
    private static String str(Map<String, AttributeValue> item, String name) {
        AttributeValue v = item.get(name);
        return v == null ? null : v.s();
    }
    private static Instant instant(Map<String, AttributeValue> item, String name) {
        String v = str(item, name);
        return v == null ? null : Instant.parse(v);
    }
    private static AttributeDefinition attr(String name, ScalarAttributeType type) {
        return AttributeDefinition.builder().attributeName(name).attributeType(type).build();
    }
    private static void putIfPresent(Map<String, AttributeValue> item, String key, String val) {
        if (val != null && !val.isBlank()) item.put(key, s(val));
    }
    private static void putIfPresent(Map<String, AttributeValue> item, String key, Instant val) {
        if (val != null) item.put(key, s(val.toString()));
    }
}
