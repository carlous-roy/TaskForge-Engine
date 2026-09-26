package com.taskforge.common.repository;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.model.ReportJob;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.CancellationReason;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsResponse;
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * DynamoDB cancels one of two simultaneous transactions on the same item with a
 * {@code TransactionConflict} reason instead of a failed condition. These tests drive that path
 * with a stubbed client, because no emulator reproduces it on demand.
 */
class ReportJobRepositoryConflictTest {

    private static final Instant T0 = Instant.parse("2026-09-18T12:00:00Z");

    private DynamoDbClient dynamoDb;
    private ReportJobRepository repository;

    @BeforeEach
    void setUp() {
        dynamoDb = mock(DynamoDbClient.class);
        TaskForgeProperties properties = new TaskForgeProperties();
        properties.getDynamodb().setTable("jobs");
        repository = new ReportJobRepository(dynamoDb, properties);
    }

    private static ReportJob job(String key) {
        return ReportJob.create(ReportType.SALES_SUMMARY, Map.of("region", "North"), "cid-1", key, 3,
                T0.plusSeconds(86_400).getEpochSecond(), T0);
    }

    private static TransactionCanceledException cancelled(String... codes) {
        List<CancellationReason> reasons = java.util.Arrays.stream(codes)
                .map(code -> CancellationReason.builder().code(code).build())
                .toList();
        return TransactionCanceledException.builder().message("cancelled").cancellationReasons(reasons).build();
    }

    @Test
    void aConflictIsRetriedAndTheSubmissionSucceeds() {
        when(dynamoDb.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenThrow(cancelled("None", "TransactionConflict"))
                .thenReturn(TransactWriteItemsResponse.builder().build());

        repository.create(job("key-1"));

        verify(dynamoDb, times(2)).transactWriteItems(any(TransactWriteItemsRequest.class));
    }

    @Test
    void aConflictFollowedByTheMarkerConditionIsReportedAsADuplicate() {
        when(dynamoDb.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenThrow(cancelled("TransactionConflict", "TransactionConflict"))
                .thenThrow(cancelled("None", "ConditionalCheckFailed"));
        when(dynamoDb.getItem(any(GetItemRequest.class))).thenReturn(GetItemResponse.builder()
                .item(Map.of("id", AttributeValue.fromS(ReportJobRepository.KEY_PREFIX + "key-1"),
                        "jobId", AttributeValue.fromS("winner")))
                .build());

        assertThatThrownBy(() -> repository.create(job("key-1")))
                .isInstanceOf(DuplicateReportException.class)
                .satisfies(e -> assertThat(((DuplicateReportException) e).getExistingId()).isEqualTo("winner"));
        verify(dynamoDb, times(2)).transactWriteItems(any(TransactWriteItemsRequest.class));
    }

    @Test
    void persistentConflictsGiveUpAfterTheRetryBudget() {
        when(dynamoDb.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenThrow(cancelled("None", "TransactionConflict"));

        assertThatThrownBy(() -> repository.create(job("key-1")))
                .isInstanceOf(TransactionCanceledException.class);
        verify(dynamoDb, times(5)).transactWriteItems(any(TransactWriteItemsRequest.class));
    }

    @Test
    void otherCancellationReasonsAreNotRetried() {
        when(dynamoDb.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenThrow(cancelled("None", "ValidationError"));

        assertThatThrownBy(() -> repository.create(job("key-1")))
                .isInstanceOf(TransactionCanceledException.class);
        verify(dynamoDb, times(1)).transactWriteItems(any(TransactWriteItemsRequest.class));
    }
}
