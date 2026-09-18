package com.taskforge.api.service;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.dto.CreateReportRequest;
import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.InvalidReportParametersException;
import com.taskforge.common.exception.QueueUnavailableException;
import com.taskforge.common.exception.StaleJobException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.Mockito;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ReportServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-18T12:00:00Z");

    private final ReportJobRepository repository = mock(ReportJobRepository.class);
    private final QueueService queueService = mock(QueueService.class);
    private final StorageService storageService = mock(StorageService.class);
    private ReportService service;

    @BeforeEach
    void setUp() {
        TaskForgeProperties properties = new TaskForgeProperties();
        service = new ReportService(repository, queueService, storageService, properties, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static CreateReportRequest request(String key) {
        CreateReportRequest r = new CreateReportRequest();
        r.setType(ReportType.SALES_SUMMARY);
        r.setParameters(Map.of("region", " North "));
        r.setIdempotencyKey(key);
        return r;
    }

    @Test
    void submitWritesAcceptedThenEnqueuesThenMarksQueued() {
        ReportJob job = service.submit(request("k1"), "cid-1");

        InOrder order = Mockito.inOrder(repository, queueService);
        order.verify(repository).create(job);
        order.verify(queueService).enqueue(job.getId(), "cid-1");
        order.verify(repository).update(job);

        assertThat(job.getStatus()).isEqualTo(ReportStatus.QUEUED);
        assertThat(job.getCorrelationId()).isEqualTo("cid-1");
        assertThat(job.getIdempotencyKey()).isEqualTo("k1");
        assertThat(job.getParameters()).containsExactly(Map.entry("region", "North"));
        assertThat(job.getMaxAttempts()).isEqualTo(3);
        assertThat(job.getCreatedAt()).isEqualTo(NOW);
        assertThat(job.getTtl()).isEqualTo(NOW.plusSeconds(24 * 3600).getEpochSecond());
    }

    @Test
    void invalidParametersAreRejectedBeforeAnythingIsWritten() {
        CreateReportRequest r = request(null);
        r.setParameters(Map.of("dateFrom", "yesterday"));
        assertThatThrownBy(() -> service.submit(r, "cid")).isInstanceOf(InvalidReportParametersException.class);
        verify(repository, never()).create(any());
        verify(queueService, never()).enqueue(anyString(), anyString());
    }

    @Test
    void enqueueFailureDeletesTheRecordSoTheKeyIsFreeAgain() {
        doThrow(new QueueUnavailableException("down", null)).when(queueService).enqueue(anyString(), anyString());

        assertThatThrownBy(() -> service.submit(request("k2"), "cid-2")).isInstanceOf(QueueUnavailableException.class);

        ArgumentCaptor<ReportJob> created = ArgumentCaptor.forClass(ReportJob.class);
        verify(repository).create(created.capture());
        verify(repository).delete(created.getValue().getId(), "k2");
        verify(repository, never()).update(any());
    }

    @Test
    void whenAWorkerTakesTheJobFirstTheCurrentStateIsReturned() {
        doThrow(new StaleJobException("id", 0)).when(repository).update(any());
        ReportJob processing = ReportJob.create(ReportType.SALES_SUMMARY, Map.of(), "cid-3", null, 3, 1, NOW);
        processing.setStatus(ReportStatus.PROCESSING);
        when(repository.findById(anyString())).thenReturn(Optional.of(processing));

        ReportJob result = service.submit(request(null), "cid-3");
        assertThat(result.getStatus()).isEqualTo(ReportStatus.PROCESSING);
    }

    @Test
    void downloadUrlOnlyForCompletedJobsWithAFile() {
        ReportJob queued = ReportJob.create(ReportType.SALES_SUMMARY, Map.of(), "c", null, 3, 1, NOW);
        assertThat(service.downloadUrlFor(queued)).isEmpty();

        queued.setStatus(ReportStatus.COMPLETED);
        queued.setFileKey("reports/x.csv");
        when(storageService.generateDownloadUrl("reports/x.csv")).thenReturn("http://s3/x");
        assertThat(service.downloadUrlFor(queued)).contains("http://s3/x");
    }
}
