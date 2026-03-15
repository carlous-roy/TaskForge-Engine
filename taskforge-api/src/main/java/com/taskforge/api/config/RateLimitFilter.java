package com.taskforge.api.config;

import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

// 60 requests per minute per IP
@Component
public class RateLimitFilter implements Filter {

    private static final int MAX_REQUESTS = 60;
    private static final long WINDOW_MS = 60_000;

    private final Map<String, WindowCounter> counters = new ConcurrentHashMap<>();

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest req = (HttpServletRequest) request;
        String ip = req.getRemoteAddr();

        WindowCounter counter = counters.compute(ip, (k, v) -> {
            long now = System.currentTimeMillis();
            if (v == null || now - v.windowStart > WINDOW_MS) {
                return new WindowCounter(now);
            }
            return v;
        });

        if (counter.count.incrementAndGet() > MAX_REQUESTS) {
            HttpServletResponse resp = (HttpServletResponse) response;
            resp.setStatus(429);
            resp.setContentType("application/json");
            resp.getWriter().write("{\"status\":429,\"error\":\"Too Many Requests\",\"message\":\"Rate limit exceeded. Max 60 requests per minute.\"}");
            return;
        }

        chain.doFilter(request, response);
    }

    private static class WindowCounter {
        final long windowStart;
        final AtomicInteger count = new AtomicInteger(0);
        WindowCounter(long windowStart) { this.windowStart = windowStart; }
    }
}
