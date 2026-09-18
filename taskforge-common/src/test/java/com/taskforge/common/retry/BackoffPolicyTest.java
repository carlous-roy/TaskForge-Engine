package com.taskforge.common.retry;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.HashSet;
import java.util.Random;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class BackoffPolicyTest {

    private final BackoffPolicy policy = new BackoffPolicy(Duration.ofSeconds(2), Duration.ofSeconds(60));

    @Test
    void upperBoundDoublesFromBaseAndStopsAtCap() {
        assertThat(policy.upperBoundSeconds(1)).isEqualTo(4);
        assertThat(policy.upperBoundSeconds(2)).isEqualTo(8);
        assertThat(policy.upperBoundSeconds(3)).isEqualTo(16);
        assertThat(policy.upperBoundSeconds(4)).isEqualTo(32);
        assertThat(policy.upperBoundSeconds(5)).isEqualTo(60);
        assertThat(policy.upperBoundSeconds(40)).isEqualTo(60);
        assertThat(policy.upperBoundSeconds(70)).isEqualTo(60);
    }

    @Test
    void delayStaysInsideTheWindowAndVaries() {
        for (int attempt = 1; attempt <= 6; attempt++) {
            Set<Integer> seen = new HashSet<>();
            long upper = policy.upperBoundSeconds(attempt);
            for (int i = 0; i < 500; i++) {
                int delay = policy.delaySeconds(attempt);
                assertThat(delay).isBetween(0, (int) upper);
                seen.add(delay);
            }
            assertThat(seen).as("attempt %d must not always produce the same delay", attempt).hasSizeGreaterThan(2);
        }
    }

    @Test
    void delayIsUniformOverWholeSeconds() {
        // With 5000 draws from [0, 4] each value should appear roughly a fifth of the time.
        int[] counts = new int[5];
        for (int i = 0; i < 5000; i++) {
            counts[policy.delaySeconds(1)]++;
        }
        for (int count : counts) {
            assertThat(count).isBetween(700, 1300);
        }
    }

    @Test
    void seededRandomMakesDelaysReproducible() {
        BackoffPolicy a = new BackoffPolicy(Duration.ofSeconds(2), Duration.ofSeconds(60), new Random(7));
        BackoffPolicy b = new BackoffPolicy(Duration.ofSeconds(2), Duration.ofSeconds(60), new Random(7));
        for (int i = 1; i <= 20; i++) {
            assertThat(a.delaySeconds(i)).isEqualTo(b.delaySeconds(i));
        }
    }

    @Test
    void rejectsInvalidConfiguration() {
        assertThatThrownBy(() -> new BackoffPolicy(Duration.ZERO, Duration.ofSeconds(1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BackoffPolicy(Duration.ofSeconds(5), Duration.ofSeconds(1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> policy.delaySeconds(0)).isInstanceOf(IllegalArgumentException.class);
    }
}
