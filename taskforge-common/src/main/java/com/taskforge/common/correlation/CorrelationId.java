package com.taskforge.common.correlation;

import org.slf4j.MDC;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * The identifier that follows one request from the client through the API, the SQS message, the
 * worker's log lines and the S3 object it produces.
 *
 * <p>The API accepts one from the {@code X-Correlation-ID} request header when it looks safe to log
 * (see {@link #isValid}) and generates one otherwise. Every log line in both processes carries it via
 * the {@code cid} MDC key.
 */
public final class CorrelationId {

    public static final String HEADER = "X-Correlation-ID";
    public static final String MDC_KEY = "cid";
    public static final String SQS_ATTRIBUTE = "correlationId";
    public static final String S3_TAG = "correlation-id";

    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._-]{1,64}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private CorrelationId() {
    }

    /** Twelve hexadecimal characters: short enough to read in a log, 48 bits of randomness. */
    public static String generate() {
        byte[] bytes = new byte[6];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    public static boolean isValid(String candidate) {
        return candidate != null && VALID.matcher(candidate).matches();
    }

    /** The id of the current thread's work, or null outside a request or job. */
    public static String current() {
        return MDC.get(MDC_KEY);
    }

    public static void bind(String correlationId) {
        MDC.put(MDC_KEY, correlationId);
    }

    public static void clear() {
        MDC.remove(MDC_KEY);
    }
}
