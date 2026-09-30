package com.taskforge.api;

import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.QueueService.ReceivedMessage;
import com.taskforge.testsupport.AwsEmulator;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The API against a real emulator (LocalStack via Testcontainers, or AWS_ENDPOINT_OVERRIDE): a
 * submission lands in DynamoDB and SQS, and a burst of duplicates yields exactly one job.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "taskforge.rate-limit.enabled=false")
class SubmissionIT {

    @DynamicPropertySource
    static void emulator(DynamicPropertyRegistry registry) {
        AwsEmulator.get().springProperties().forEach((k, v) -> registry.add(k, () -> v));
        registry.add("taskforge.dynamodb.table", () -> AwsEmulator.uniqueName("api-it"));
        registry.add("taskforge.sqs.queue", () -> AwsEmulator.uniqueName("api-it"));
        registry.add("taskforge.sqs.dlq", () -> AwsEmulator.uniqueName("api-it-dlq"));
        registry.add("taskforge.s3.bucket", () -> AwsEmulator.uniqueName("api-it"));
        registry.add("taskforge.sqs.wait-time", () -> "1s");
    }

    @LocalServerPort int port;
    @Autowired ReportJobRepository repository;
    @Autowired QueueService queueService;
    @Autowired ObjectMapper json;

    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> post(String body, String correlationId) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/reports"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (correlationId != null) request.header("X-Correlation-ID", correlationId);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void submissionIsStoredQueuedAndVisibleThroughTheApi() throws Exception {
        HttpResponse<String> response = post("{\"type\":\"INVENTORY_SNAPSHOT\",\"parameters\":{\"warehouse\":\"WH-EAST\"}}", "it-cid-1");
        assertThat(response.statusCode()).isEqualTo(202);
        JsonNode body = json.readTree(response.body());
        String id = body.get("id").asString();
        assertThat(body.get("status").asString()).isEqualTo("QUEUED");
        assertThat(body.get("correlationId").asString()).isEqualTo("it-cid-1");

        assertThat(repository.findById(id)).isPresent();

        ReceivedMessage message = null;
        for (int i = 0; i < 10 && message == null; i++) {
            message = queueService.receive(10).stream().filter(m -> id.equals(m.jobId())).findFirst().orElse(null);
        }
        assertThat(message).as("message for the job is in the queue").isNotNull();
        assertThat(message.correlationId()).isEqualTo("it-cid-1");
        queueService.delete(message.receiptHandle());

        HttpResponse<String> get = http.send(HttpRequest.newBuilder(
                URI.create("http://127.0.0.1:" + port + "/api/v1/reports/" + id)).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(get.statusCode()).isEqualTo(200);
        assertThat(json.readTree(get.body()).get("parameters").get("warehouse").asString()).isEqualTo("WH-EAST");
    }

    @Test
    void twentyParallelSubmissionsWithOneKeyCreateExactlyOneJob() throws Exception {
        assumeTrue(AwsEmulator.get().serializesTransactions(),
                "needs an emulator that applies transactions one at a time (LocalStack); "
                        + AwsEmulator.get().description() + " does not guarantee that");
        String key = "burst-" + UUID.randomUUID();
        String body = "{\"type\":\"SALES_SUMMARY\",\"parameters\":{\"region\":\"South\"},\"idempotencyKey\":\"" + key + "\"}";
        int clients = 20;
        ExecutorService pool = Executors.newFixedThreadPool(clients);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<HttpResponse<String>>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < clients; i++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    return post(body, null);
                }));
            }
            start.countDown();

            List<String> accepted = new ArrayList<>();
            Set<String> conflictsPointTo = new HashSet<>();
            for (Future<HttpResponse<String>> f : futures) {
                HttpResponse<String> r = f.get(60, TimeUnit.SECONDS);
                JsonNode node = json.readTree(r.body());
                if (r.statusCode() == 202) {
                    accepted.add(node.get("id").asString());
                } else {
                    assertThat(r.statusCode()).isEqualTo(409);
                    conflictsPointTo.add(node.get("existingReportId").asString());
                    assertThat(r.headers().firstValue("Location")).contains("/api/v1/reports/" + node.get("existingReportId").asString());
                }
            }
            assertThat(accepted).hasSize(1);
            assertThat(conflictsPointTo).containsExactly(accepted.get(0));
            assertThat(repository.findJobIdByIdempotencyKey(key)).contains(accepted.get(0));
            assertThat(repository.findAll(10_000).stream().filter(j -> key.equals(j.getIdempotencyKey())).count()).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }
}
