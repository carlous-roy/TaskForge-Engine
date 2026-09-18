package com.taskforge.api.controller;

import com.taskforge.common.enums.ReportStatus;
import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.QueueUnavailableException;
import com.taskforge.common.model.ReportJob;
import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.matchesPattern;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The HTTP contract: status codes, the error body and the headers, with the AWS-backed services
 * mocked. Every test uses its own client address so the rate limiter's windows do not interfere.
 */
@SpringBootTest(properties = "taskforge.rate-limit.requests-per-minute=5")
@AutoConfigureMockMvc
class ReportControllerTest {

    private static final AtomicInteger NEXT_CLIENT = new AtomicInteger(1);
    private static final String VALID_BODY = """
            {"type":"SALES_SUMMARY","parameters":{"dateFrom":"2026-01-01","dateTo":"2026-01-31","region":"North"},"idempotencyKey":"key-1"}
            """;

    @Autowired MockMvc mvc;
    @MockitoBean ReportJobRepository repository;
    @MockitoBean QueueService queueService;
    @MockitoBean StorageService storageService;

    private String client;

    @BeforeEach
    void newClientAddress() {
        client = "10.9." + (NEXT_CLIENT.get() / 250) + "." + (NEXT_CLIENT.getAndIncrement() % 250);
    }

    private RequestPostProcessor from(String address) {
        return request -> {
            request.setRemoteAddr(address);
            return request;
        };
    }

    private MockHttpServletRequestBuilder postReport(String body) {
        return post("/api/v1/reports").with(from(client)).contentType(MediaType.APPLICATION_JSON).content(body);
    }

    private static ReportJob storedJob(ReportStatus status) {
        ReportJob job = ReportJob.create(ReportType.SALES_SUMMARY, Map.of("region", "North"), "cid-stored", "key-1", 3,
                1_000L, Instant.parse("2026-09-18T10:00:00Z"));
        job.setStatus(status);
        if (status == ReportStatus.COMPLETED) {
            job.setFileKey("reports/sales_summary/" + job.getId() + ".csv");
        }
        return job;
    }

    // ---- 202 ---------------------------------------------------------------------------------

    @Test
    void submitReturns202WithLocationAndEchoesTheCorrelationId() throws Exception {
        mvc.perform(postReport(VALID_BODY).header("X-Correlation-ID", "client-req-7"))
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Correlation-ID", "client-req-7"))
                .andExpect(header().string("Location", matchesPattern("/api/v1/reports/[0-9a-f-]{36}")))
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.correlationId").value("client-req-7"))
                .andExpect(jsonPath("$.type").value("SALES_SUMMARY"))
                .andExpect(jsonPath("$.maxAttempts").value(3))
                .andExpect(jsonPath("$.parameters.region").value("North"));

        ArgumentCaptor<ReportJob> created = ArgumentCaptor.forClass(ReportJob.class);
        verify(repository).create(created.capture());
        verify(queueService).enqueue(eq(created.getValue().getId()), eq("client-req-7"));
        verify(repository).update(any(ReportJob.class));
        assertThat(created.getValue().getIdempotencyKey()).isEqualTo("key-1");
    }

    @Test
    void submitGeneratesACorrelationIdWhenTheHeaderIsMissingOrUnsafe() throws Exception {
        mvc.perform(postReport(VALID_BODY).header("X-Correlation-ID", "has spaces and \"quotes\""))
                .andExpect(status().isAccepted())
                .andExpect(header().string("X-Correlation-ID", matchesPattern("[0-9a-f]{12}")))
                .andExpect(jsonPath("$.correlationId").value(matchesPattern("[0-9a-f]{12}")));
    }

    // ---- 400 ---------------------------------------------------------------------------------

    @Test
    void malformedJsonIs400() throws Exception {
        mvc.perform(postReport("{\"type\":"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.error").value("Bad Request"))
                .andExpect(jsonPath("$.message").value("Malformed request body"))
                .andExpect(jsonPath("$.details[0]").value(containsString("malformed JSON at line 1")))
                .andExpect(jsonPath("$.path").value("/api/v1/reports"))
                .andExpect(jsonPath("$.correlationId").value(matchesPattern("[0-9a-f]{12}")))
                .andExpect(jsonPath("$.timestamp").exists());
        verify(repository, never()).create(any());
    }

    @Test
    void unknownEnumValueIs400WithTheAllowedValues() throws Exception {
        mvc.perform(postReport("{\"type\":\"BOGUS\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value("invalid value 'BOGUS' for field 'type'; allowed: [SALES_SUMMARY, INVENTORY_SNAPSHOT, USER_ACTIVITY]"));
    }

    @Test
    void unknownJsonFieldIs400() throws Exception {
        mvc.perform(postReport("{\"type\":\"SALES_SUMMARY\",\"foo\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value("unknown field 'foo'"));
    }

    @Test
    void missingTypeIs400() throws Exception {
        mvc.perform(postReport("{\"parameters\":{}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Request validation failed"))
                .andExpect(jsonPath("$.details[0]").value("type: type is required"));
    }

    @Test
    void invalidParametersAre400WithEveryProblemListed() throws Exception {
        mvc.perform(postReport("{\"type\":\"USER_ACTIVITY\",\"parameters\":{\"userId\":\"abc\",\"dateFrom\":\"nope\",\"x\":\"1\"}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Invalid report parameters"))
                .andExpect(jsonPath("$.details", hasSize(3)));
        verify(repository, never()).create(any());
    }

    @Test
    void oversizedIdempotencyKeyIs400() throws Exception {
        mvc.perform(postReport("{\"type\":\"SALES_SUMMARY\",\"idempotencyKey\":\"" + "k".repeat(129) + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value(containsString("idempotencyKey must be between 1 and 128")));
    }

    @Test
    void tooManyParametersIs400() throws Exception {
        StringBuilder params = new StringBuilder();
        for (int i = 0; i < 11; i++) {
            params.append(i > 0 ? "," : "").append("\"p").append(i).append("\":\"v\"");
        }
        mvc.perform(postReport("{\"type\":\"SALES_SUMMARY\",\"parameters\":{" + params + "}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value(containsString("at most 10 parameters")));
    }

    @Test
    void invalidStatusFilterIs400() throws Exception {
        mvc.perform(get("/api/v1/reports").with(from(client)).param("status", "BOGUS"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value(containsString("invalid value 'BOGUS' for parameter 'status'")));
    }

    @Test
    void limitOutOfRangeIs400() throws Exception {
        mvc.perform(get("/api/v1/reports").with(from(client)).param("limit", "0"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value(containsString("limit")));
    }

    @Test
    void malformedIdIs400() throws Exception {
        mvc.perform(get("/api/v1/reports/not-a-uuid").with(from(client)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.details[0]").value("id: must be a UUID"));
    }

    // ---- 404, 405, 415 -----------------------------------------------------------------------

    @Test
    void unknownReportIs404() throws Exception {
        String id = UUID.randomUUID().toString();
        when(repository.findById(id)).thenReturn(Optional.empty());
        mvc.perform(get("/api/v1/reports/" + id).with(from(client)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value("Report not found: " + id));
    }

    @Test
    void unknownRouteAndFaviconAre404NotAServerError() throws Exception {
        mvc.perform(get("/api/v1/nothing").with(from(client)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.status").value(404));
        mvc.perform(get("/favicon.ico").with(from(client)))
                .andExpect(status().isNotFound());
    }

    @Test
    void wrongMethodIs405WithAllowHeader() throws Exception {
        mvc.perform(delete("/api/v1/reports").with(from(client)))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(header().string("Allow", containsString("GET")))
                .andExpect(jsonPath("$.status").value(405));
    }

    @Test
    void wrongContentTypeIs415() throws Exception {
        mvc.perform(post("/api/v1/reports").with(from(client)).contentType(MediaType.TEXT_PLAIN).content("x"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.status").value(415));
    }

    // ---- 409 ---------------------------------------------------------------------------------

    @Test
    void duplicateKeyIs409WithTheExistingIdAndLocation() throws Exception {
        String existing = UUID.randomUUID().toString();
        doThrow(new DuplicateReportException("key-1", existing)).when(repository).create(any());

        mvc.perform(postReport(VALID_BODY))
                .andExpect(status().isConflict())
                .andExpect(header().string("Location", "/api/v1/reports/" + existing))
                .andExpect(jsonPath("$.status").value(409))
                .andExpect(jsonPath("$.existingReportId").value(existing))
                .andExpect(jsonPath("$.message").value("A report with idempotency key 'key-1' already exists"));
        verify(queueService, never()).enqueue(anyString(), anyString());
    }

    @Test
    void downloadOfAnUnfinishedReportIs409() throws Exception {
        ReportJob job = storedJob(ReportStatus.QUEUED);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        mvc.perform(get("/api/v1/reports/" + job.getId() + "/download").with(from(client)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value(containsString("not ready for download (status: QUEUED)")));
    }

    // ---- 200 / 302 ---------------------------------------------------------------------------

    @Test
    void completedReportCarriesADownloadUrlInGetAndList() throws Exception {
        ReportJob job = storedJob(ReportStatus.COMPLETED);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        when(repository.findAll(anyInt())).thenReturn(List.of(job, storedJob(ReportStatus.QUEUED)));
        when(storageService.generateDownloadUrl(job.getFileKey())).thenReturn("http://localhost:4566/bucket/" + job.getFileKey());

        mvc.perform(get("/api/v1/reports/" + job.getId()).with(from(client)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.downloadUrl").value("http://localhost:4566/bucket/" + job.getFileKey()));
        mvc.perform(get("/api/v1/reports").with(from(client)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(2)))
                .andExpect(jsonPath("$[0].downloadUrl").value(containsString(job.getFileKey())))
                .andExpect(jsonPath("$[1].downloadUrl").doesNotExist());
    }

    @Test
    void downloadRedirectsToThePresignedUrl() throws Exception {
        ReportJob job = storedJob(ReportStatus.COMPLETED);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        when(storageService.exists(job.getFileKey())).thenReturn(true);
        when(storageService.generateDownloadUrl(job.getFileKey())).thenReturn("http://localhost:4566/bucket/file.csv?sig");
        mvc.perform(get("/api/v1/reports/" + job.getId() + "/download").with(from(client)))
                .andExpect(status().isFound())
                .andExpect(header().string("Location", "http://localhost:4566/bucket/file.csv?sig"));
    }

    @Test
    void downloadOfAnExpiredFileIs404() throws Exception {
        ReportJob job = storedJob(ReportStatus.COMPLETED);
        when(repository.findById(job.getId())).thenReturn(Optional.of(job));
        when(storageService.exists(job.getFileKey())).thenReturn(false);
        mvc.perform(get("/api/v1/reports/" + job.getId() + "/download").with(from(client)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value(containsString("expired or been deleted")));
    }

    // ---- 429 ---------------------------------------------------------------------------------

    @Test
    void sixthRequestInAMinuteIs429WithRetryAfter() throws Exception {
        when(repository.findAll(anyInt())).thenReturn(List.of());
        for (int i = 1; i <= 5; i++) {
            mvc.perform(get("/api/v1/reports").with(from(client)))
                    .andExpect(status().isOk())
                    .andExpect(header().string("X-RateLimit-Remaining", String.valueOf(5 - i)));
        }
        mvc.perform(get("/api/v1/reports").with(from(client)))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After"))
                .andExpect(jsonPath("$.status").value(429))
                .andExpect(jsonPath("$.error").value("Too Many Requests"))
                .andExpect(jsonPath("$.correlationId").exists());
        // Another client is unaffected.
        mvc.perform(get("/api/v1/reports").with(from(client + "1"))).andExpect(status().isOk());
    }

    @Test
    void healthAndStaticContentAreNeverRateLimited() throws Exception {
        when(queueService.queueDepth()).thenReturn(2);
        when(queueService.deadLetterDepth()).thenReturn(0);
        for (int i = 0; i < 20; i++) {
            mvc.perform(get("/api/v1/health").with(from(client)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.status").value("UP"))
                    .andExpect(jsonPath("$.queueDepth").value(2))
                    .andExpect(jsonPath("$.deadLetterDepth").value(0));
        }
    }

    // ---- 503 ---------------------------------------------------------------------------------

    @Test
    void enqueueFailureIs503AndReleasesTheRecord() throws Exception {
        doThrow(new QueueUnavailableException("sqs down", new RuntimeException())).when(queueService).enqueue(anyString(), anyString());
        mvc.perform(postReport(VALID_BODY))
                .andExpect(status().isServiceUnavailable())
                .andExpect(header().string("Retry-After", "5"))
                .andExpect(jsonPath("$.status").value(503));
        ArgumentCaptor<ReportJob> created = ArgumentCaptor.forClass(ReportJob.class);
        verify(repository).create(created.capture());
        verify(repository).delete(created.getValue().getId(), "key-1");
        verify(repository, never()).update(any());
    }

    @Test
    void healthIsDegradedWhenTheQueueCannotBeRead() throws Exception {
        when(queueService.queueDepth()).thenThrow(new RuntimeException("connection refused"));
        mvc.perform(get("/api/v1/health").with(from(client)))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.status").value("DEGRADED"));
    }

    @Test
    void unexpectedErrorsAre500WithoutInternals() throws Exception {
        String id = UUID.randomUUID().toString();
        when(repository.findById(id)).thenThrow(new IllegalStateException("table missing: internal detail"));
        mvc.perform(get("/api/v1/reports/" + id).with(from(client)))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.message").value(containsString("unexpected error")))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.not(containsString("internal detail"))))
                .andExpect(jsonPath("$.correlationId").exists());
    }
}
