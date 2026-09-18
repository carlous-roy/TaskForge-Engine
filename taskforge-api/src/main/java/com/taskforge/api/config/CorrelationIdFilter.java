package com.taskforge.api.config;

import com.taskforge.common.correlation.CorrelationId;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Gives every request a correlation id: the caller's {@code X-Correlation-ID} when it is well formed,
 * a generated one otherwise. The id is placed in the MDC for the duration of the request, returned in
 * the response header, and becomes the correlation id of any job the request creates.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String supplied = request.getHeader(CorrelationId.HEADER);
        String correlationId = CorrelationId.isValid(supplied) ? supplied : CorrelationId.generate();
        CorrelationId.bind(correlationId);
        response.setHeader(CorrelationId.HEADER, correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            CorrelationId.clear();
        }
    }
}
