package com.taskforge.api.config;

import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.dto.ErrorResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Fixed-window rate limit per client address on {@code /api/**}.
 *
 * <p>The client address is {@link HttpServletRequest#getRemoteAddr()}. Behind a proxy that address
 * is the proxy's, so the API enables Tomcat's {@code RemoteIpValve}
 * ({@code server.forward-headers-strategy=native}); the valve replaces the remote address with the
 * one from {@code X-Forwarded-For} only when the immediate peer is in the configured
 * {@code server.tomcat.remoteip.internal-proxies} list. A client that sends the header directly is
 * therefore still counted under its own address, and cannot spread its requests over invented ones.
 *
 * <p>The dashboard's static files and the health endpoint are not limited: a browser tab polling
 * health cannot starve its own submissions, and monitoring never sees a 429.
 *
 * <p>State is in memory and per instance. It is bounded: once {@code max-tracked-clients} addresses
 * have live windows, further new addresses share one overflow window until old ones expire, which
 * limits memory without resetting everybody's counters.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class RateLimitFilter extends OncePerRequestFilter {

    static final long WINDOW_MS = 60_000;
    static final String OVERFLOW_KEY = "overflow";
    static final int MAX_KEY_LENGTH = 64;
    private static final List<String> UNLIMITED_PATHS = List.of("/api/v1/health");

    private final TaskForgeProperties.RateLimit config;
    private final ObjectMapper json;
    private final Clock clock;
    private final Map<String, Window> windows = new ConcurrentHashMap<>();
    private final AtomicLong lastSweepAt = new AtomicLong();

    public RateLimitFilter(TaskForgeProperties properties, ObjectMapper json, Clock clock) {
        this.config = properties.getRateLimit();
        this.json = json;
        this.clock = clock;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!config.isEnabled()) return true;
        String path = request.getRequestURI();
        return path == null || !path.startsWith("/api/") || UNLIMITED_PATHS.contains(path);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long now = clock.millis();
        Window window = windowFor(clientKey(request), now);
        int used = window.count.incrementAndGet();
        int limit = config.getRequestsPerMinute();

        response.setHeader("X-RateLimit-Limit", String.valueOf(limit));
        response.setHeader("X-RateLimit-Remaining", String.valueOf(Math.max(0, limit - used)));

        if (used > limit) {
            long retryAfterSeconds = Math.max(1, (window.startedAt + WINDOW_MS - now + 999) / 1000);
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterSeconds));
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            ErrorResponse body = new ErrorResponse(clock.instant(), HttpStatus.TOO_MANY_REQUESTS.value(),
                    "Too Many Requests",
                    "Rate limit exceeded: at most " + limit + " requests per minute per client. Retry after "
                            + retryAfterSeconds + " second(s).",
                    List.of(), request.getRequestURI(), CorrelationId.current(), null);
            response.getWriter().write(json.writeValueAsString(body));
            return;
        }
        chain.doFilter(request, response);
    }

    private Window windowFor(String key, long now) {
        Window window = windows.get(key);
        if (window != null && !window.expired(now)) {
            return window;
        }
        if (window == null && windows.size() >= config.getMaxTrackedClients()) {
            sweep(now);
            if (windows.size() >= config.getMaxTrackedClients()) {
                key = OVERFLOW_KEY;
            }
        }
        return windows.compute(key, (k, v) -> (v == null || v.expired(now)) ? new Window(now) : v);
    }

    /** Drops expired windows, at most once per second, so a burst of new clients cannot make every request scan the map. */
    private void sweep(long now) {
        long last = lastSweepAt.get();
        if (now - last < 1_000 || !lastSweepAt.compareAndSet(last, now)) {
            return;
        }
        windows.entrySet().removeIf(e -> e.getValue().expired(now));
    }

    private static String clientKey(HttpServletRequest request) {
        String address = request.getRemoteAddr();
        if (address == null || address.isBlank()) return "unknown";
        return address.length() > MAX_KEY_LENGTH ? address.substring(0, MAX_KEY_LENGTH) : address;
    }

    /** Visible for tests: number of client windows currently tracked. */
    int trackedClients() {
        return windows.size();
    }

    private static final class Window {
        final long startedAt;
        final AtomicInteger count = new AtomicInteger();

        Window(long startedAt) {
            this.startedAt = startedAt;
        }

        boolean expired(long now) {
            return now - startedAt >= WINDOW_MS;
        }
    }
}
