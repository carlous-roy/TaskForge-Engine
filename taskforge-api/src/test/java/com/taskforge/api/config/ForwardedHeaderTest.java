package com.taskforge.api.config;

import com.taskforge.common.repository.ReportJobRepository;
import com.taskforge.common.service.QueueService;
import com.taskforge.common.service.StorageService;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.when;

/**
 * Whether the rate limiter believes {@code X-Forwarded-For}. These need the real Tomcat, because
 * the decision is made by its RemoteIpValve, which MockMvc never runs.
 */
class ForwardedHeaderTest {

    static abstract class Base {
        @LocalServerPort int port;
        @MockitoBean ReportJobRepository repository;
        @MockitoBean QueueService queueService;
        @MockitoBean StorageService storageService;

        private final HttpClient http = HttpClient.newHttpClient();

        int list(String forwardedFor) throws IOException, InterruptedException {
            when(repository.findAll(anyInt())).thenReturn(List.of());
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/reports")).GET();
            if (forwardedFor != null) {
                request.header("X-Forwarded-For", forwardedFor);
            }
            return http.send(request.build(), HttpResponse.BodyHandlers.discarding()).statusCode();
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
            properties = "taskforge.rate-limit.requests-per-minute=3")
    class WithNoTrustedProxy extends Base {

        @Test
        void aClientCannotEscapeItsBucketByInventingForwardedAddresses() throws Exception {
            for (int i = 1; i <= 3; i++) {
                assertThat(list("203.0.113." + i)).isEqualTo(200);
            }
            assertThat(list("203.0.113.99")).as("fourth request from the same peer").isEqualTo(429);
            assertThat(list(null)).isEqualTo(429);
        }
    }

    @Nested
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
            "taskforge.rate-limit.requests-per-minute=3",
            "server.tomcat.remoteip.internal-proxies=127\\.0\\.0\\.1|0:0:0:0:0:0:0:1"
    })
    class BehindATrustedProxy extends Base {

        @Test
        void forwardedAddressesFromTheTrustedProxyAreSeparateClients() throws Exception {
            for (int i = 1; i <= 6; i++) {
                assertThat(list("198.51.100." + i)).as("distinct forwarded client %d", i).isEqualTo(200);
            }
            for (int i = 1; i <= 3; i++) {
                assertThat(list("198.51.100.7")).isEqualTo(200);
            }
            assertThat(list("198.51.100.7")).as("fourth request from one forwarded client").isEqualTo(429);
            // The rightmost hop that is not a trusted proxy is the client, so appending the proxy
            // to a chain still resolves to the original address.
            assertThat(list("198.51.100.7, 127.0.0.1")).isEqualTo(429);
        }
    }
}
