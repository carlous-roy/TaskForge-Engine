package com.taskforge.api.config;

import com.taskforge.common.config.TaskForgeProperties;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.json.JsonMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

class RateLimitFilterTest {

    private final AtomicLong nowMillis = new AtomicLong(Instant.parse("2026-09-18T12:00:00Z").toEpochMilli());
    private final Clock clock = new Clock() {
        @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(nowMillis.get()); }
        @Override public long millis() { return nowMillis.get(); }
    };

    private RateLimitFilter filter(int perMinute, int maxTracked) {
        TaskForgeProperties properties = new TaskForgeProperties();
        properties.getRateLimit().setRequestsPerMinute(perMinute);
        properties.getRateLimit().setMaxTrackedClients(maxTracked);
        return new RateLimitFilter(properties, JsonMapper.builder().build(), clock);
    }

    private static MockHttpServletResponse call(RateLimitFilter filter, String address, String path) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
        request.setRequestURI(path);
        request.setRemoteAddr(address);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = new MockFilterChain();
        filter.doFilter(request, response, chain);
        return response;
    }

    @Test
    void limitsPerAddressAndResetsWhenTheWindowEnds() throws Exception {
        RateLimitFilter filter = filter(2, 100);
        assertThat(call(filter, "10.0.0.1", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(call(filter, "10.0.0.1", "/api/v1/reports").getStatus()).isEqualTo(200);
        MockHttpServletResponse limited = call(filter, "10.0.0.1", "/api/v1/reports");
        assertThat(limited.getStatus()).isEqualTo(429);
        assertThat(limited.getHeader("Retry-After")).isEqualTo("60");
        assertThat(limited.getContentAsString()).contains("\"status\":429").contains("Retry-After".toLowerCase().isEmpty() ? "" : "Too Many Requests");
        assertThat(call(filter, "10.0.0.2", "/api/v1/reports").getStatus()).as("other address").isEqualTo(200);

        nowMillis.addAndGet(RateLimitFilter.WINDOW_MS);
        assertThat(call(filter, "10.0.0.1", "/api/v1/reports").getStatus()).as("new window").isEqualTo(200);
    }

    @Test
    void retryAfterCountsDownWithinTheWindow() throws Exception {
        RateLimitFilter filter = filter(1, 100);
        call(filter, "10.0.0.1", "/api/v1/reports");
        nowMillis.addAndGet(45_500);
        assertThat(call(filter, "10.0.0.1", "/api/v1/reports").getHeader("Retry-After")).isEqualTo("15");
    }

    @Test
    void healthAndNonApiPathsAreNotLimited() throws Exception {
        RateLimitFilter filter = filter(1, 100);
        for (int i = 0; i < 5; i++) {
            assertThat(call(filter, "10.0.0.1", "/api/v1/health").getStatus()).isEqualTo(200);
            assertThat(call(filter, "10.0.0.1", "/").getStatus()).isEqualTo(200);
            assertThat(call(filter, "10.0.0.1", "/assets/index.js").getStatus()).isEqualTo(200);
        }
        assertThat(filter.trackedClients()).isZero();
    }

    @Test
    void newAddressesShareAnOverflowWindowOnceTheMapIsFullInsteadOfResettingEveryone() throws Exception {
        RateLimitFilter filter = filter(3, 2);
        call(filter, "10.0.0.1", "/api/v1/reports");
        call(filter, "10.0.0.2", "/api/v1/reports");
        assertThat(filter.trackedClients()).isEqualTo(2);

        // Three more addresses share one window of 3: the third of them is refused.
        assertThat(call(filter, "10.0.0.3", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(call(filter, "10.0.0.4", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(call(filter, "10.0.0.5", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(call(filter, "10.0.0.6", "/api/v1/reports").getStatus()).isEqualTo(429);
        // The tracked clients kept their own counters.
        assertThat(call(filter, "10.0.0.1", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(filter.trackedClients()).isEqualTo(3);
    }

    @Test
    void expiredWindowsAreSweptWhenTheMapIsFull() throws Exception {
        RateLimitFilter filter = filter(3, 2);
        call(filter, "10.0.0.1", "/api/v1/reports");
        call(filter, "10.0.0.2", "/api/v1/reports");
        nowMillis.addAndGet(RateLimitFilter.WINDOW_MS + 1);
        assertThat(call(filter, "10.0.0.3", "/api/v1/reports").getStatus()).isEqualTo(200);
        assertThat(filter.trackedClients()).as("stale windows evicted, new client tracked").isEqualTo(1);
    }
}
