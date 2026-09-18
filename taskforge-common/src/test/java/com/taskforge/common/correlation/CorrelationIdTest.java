package com.taskforge.common.correlation;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CorrelationIdTest {

    @AfterEach
    void clear() {
        CorrelationId.clear();
    }

    @Test
    void generatesTwelveHexCharacters() {
        String id = CorrelationId.generate();
        assertThat(id).hasSize(12).matches("[0-9a-f]{12}");
        assertThat(CorrelationId.generate()).isNotEqualTo(id);
    }

    @Test
    void acceptsOnlySafeClientSuppliedIds() {
        assertThat(CorrelationId.isValid("req-123.A_b")).isTrue();
        assertThat(CorrelationId.isValid("a".repeat(64))).isTrue();
        assertThat(CorrelationId.isValid("a".repeat(65))).isFalse();
        assertThat(CorrelationId.isValid("")).isFalse();
        assertThat(CorrelationId.isValid(null)).isFalse();
        assertThat(CorrelationId.isValid("has space")).isFalse();
        assertThat(CorrelationId.isValid("new\nline")).isFalse();
    }

    @Test
    void bindsToTheMdc() {
        assertThat(CorrelationId.current()).isNull();
        CorrelationId.bind("abc");
        assertThat(CorrelationId.current()).isEqualTo("abc");
        CorrelationId.clear();
        assertThat(CorrelationId.current()).isNull();
    }
}
