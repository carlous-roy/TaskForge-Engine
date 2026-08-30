package com.taskforge.api.config;

import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Fixed-window rate limit of 60 requests per minute per client IP.
 *
 * <p>State is in-process, so it resets on deploy and is per-instance rather than global. That is a
 * deliberate limit of this build, not an oversight: see "What I'd do differently" in the README.
 */
@Component
public class RateLimitFilter implements Filter {

    private static final int MAX_REQUESTS = 60;
    private static final long WINDOW_MS = 60_000;

    /** A counter whose window closed this long ago can no longer affect a decision. */
    private static final long STALE_AFTER_MS = WINDOW_MS * 2;

    /** Sweep no more than once per window, so a burst does not trigger a scan per request. */
    private static final long SWEEP_INTERVAL_MS = WINDOW_MS;

    /** Hard ceiling on tracked clients, so a spray of unique source IPs cannot grow the map forever. */
    private static final int MAX_TRACKED_CLIENTS = 10_000;

    private final Map<String, WindowCounter> counters = new ConcurrentHashMap<>();
    private final AtomicLong lastSweepAt = new AtomicLong(System.currentTimeMillis());

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest req = (HttpServletRequest) request;
        long now = System.currentTimeMillis();

        evictStale(now);

        String client = clientKey(req);
        WindowCounter counter = counters.compute(client, (k, v) ->
                (v == null || now - v.windowStart > WINDOW_MS) ? new WindowCounter(now) : v);

        if (counter.count.incrementAndGet() > MAX_REQUESTS) {
            HttpServletResponse resp = (HttpServletResponse) response;
            resp.setStatus(429);
            resp.setContentType("application/json");
            resp.getWriter().write("{\"status\":429,\"error\":\"Too Many Requests\",\"message\":\"Rate limit exceeded. Max 60 requests per minute.\"}");
            return;
        }

        chain.doFilter(request, response);
    }

    /**
     * Behind a load balancer {@code getRemoteAddr()} returns the balancer's address, which would put
     * every visitor in one bucket and make the 60/min limit effectively global. Prefer the
     * originating address from {@code X-Forwarded-For} when it is present.
     *
     * <p>The header is client-supplied and therefore only as trustworthy as the proxy in front of
     * this service; deployments that are not behind a header-rewriting proxy should not honour it.
     */
    private String clientKey(HttpServletRequest req) {
        String forwarded = req.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            int comma = forwarded.indexOf(',');
            String origin = (comma >= 0 ? forwarded.substring(0, comma) : forwarded).trim();
            if (!origin.isEmpty()) {
                return origin;
            }
        }
        return req.getRemoteAddr();
    }

    /**
     * Drops counters whose window has long closed. Without this the map grows by one entry per
     * distinct source address for the lifetime of the process.
     */
    private void evictStale(long now) {
        long last = lastSweepAt.get();
        boolean due = (now - last) > SWEEP_INTERVAL_MS || counters.size() > MAX_TRACKED_CLIENTS;
        if (!due || !lastSweepAt.compareAndSet(last, now)) {
            return;
        }

        counters.entrySet().removeIf(e -> (now - e.getValue().windowStart) > STALE_AFTER_MS);

        // Every tracked window is still live and there are more of them than we are willing to
        // hold. Drop the lot rather than grow without bound; the cost is that a small number of
        // in-flight clients get a fresh window.
        if (counters.size() > MAX_TRACKED_CLIENTS) {
            counters.clear();
        }
    }

    private static class WindowCounter {
        final long windowStart;
        final AtomicInteger count = new AtomicInteger(0);
        WindowCounter(long windowStart) { this.windowStart = windowStart; }
    }
}
