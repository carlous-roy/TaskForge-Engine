package com.taskforge.common.retry;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;
import java.util.random.RandomGenerator;

/**
 * "Full jitter" exponential backoff, as described in the AWS Architecture Blog post
 * "Exponential Backoff And Jitter" (Marc Brooker, 2015):
 *
 * <pre>delay = random_between(0, min(cap, base * 2^attempt))</pre>
 *
 * <p>Delays are whole seconds because SQS visibility timeouts are whole seconds. The randomness is
 * the point: when many jobs fail at once against the same overloaded dependency, spreading their
 * retries over the window avoids them all coming back at the same instant.
 */
public final class BackoffPolicy {

    private final long baseSeconds;
    private final long capSeconds;
    private final RandomGenerator random;

    public BackoffPolicy(Duration base, Duration cap) {
        this(base, cap, ThreadLocalRandom.current());
    }

    BackoffPolicy(Duration base, Duration cap, RandomGenerator random) {
        if (base.isNegative() || base.isZero()) throw new IllegalArgumentException("base must be positive");
        if (cap.compareTo(base) < 0) throw new IllegalArgumentException("cap must be at least base");
        this.baseSeconds = Math.max(1, base.toSeconds());
        this.capSeconds = Math.max(1, cap.toSeconds());
        this.random = random;
    }

    /**
     * Upper bound of the delay window after {@code attempt} failures ({@code attempt} is 1 for the
     * first failure): {@code min(cap, base * 2^attempt)} in seconds.
     */
    public long upperBoundSeconds(int attempt) {
        if (attempt < 1) throw new IllegalArgumentException("attempt must be at least 1");
        long exponential = attempt >= 62 ? Long.MAX_VALUE : baseSeconds << attempt;
        if (exponential < 0) exponential = Long.MAX_VALUE; // shift overflow
        return Math.min(capSeconds, exponential);
    }

    /** A delay drawn uniformly from {@code [0, upperBoundSeconds(attempt)]}, in whole seconds. */
    public int delaySeconds(int attempt) {
        long upper = upperBoundSeconds(attempt);
        return (int) random.nextLong(upper + 1);
    }

    public Duration base() { return Duration.ofSeconds(baseSeconds); }
    public Duration cap() { return Duration.ofSeconds(capSeconds); }
}
