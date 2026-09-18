package com.taskforge.common.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.InvalidReportParametersException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.time.LocalDate;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReportParametersTest {

    @ParameterizedTest
    @EnumSource(ReportType.class)
    void everyTypeHasRulesAndAcceptsNoParameters(ReportType type) {
        assertThat(ReportParameters.allowedNames(type)).isNotEmpty();
        assertThat(ReportParameters.validate(type, null)).isEmpty();
        assertThat(ReportParameters.validate(type, Map.of())).isEmpty();
    }

    @Test
    void acceptsValidSalesParametersAndTrimsValues() {
        Map<String, String> params = ReportParameters.normalize(ReportType.SALES_SUMMARY,
                Map.of("dateFrom", " 2026-01-01 ", "dateTo", "2026-01-31", "region", "North"));
        assertThat(params).containsEntry("dateFrom", "2026-01-01").containsEntry("region", "North");
        ReportParameters typed = ReportParameters.of(ReportType.SALES_SUMMARY, params);
        assertThat(typed.dateFrom(null)).isEqualTo(LocalDate.of(2026, 1, 1));
        assertThat(typed.dateTo(null)).isEqualTo(LocalDate.of(2026, 1, 31));
        assertThat(typed.region()).contains("North");
    }

    @Test
    void listsEveryProblemAtOnce() {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("userId", "abc");
        params.put("dateFrom", "not-a-date");
        params.put("bogus", "1");
        assertThat(ReportParameters.validate(ReportType.USER_ACTIVITY, params)).containsExactly(
                "parameter 'userId' must be a positive integer, got 'abc'",
                "parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'not-a-date'",
                "unknown parameter 'bogus' for USER_ACTIVITY; allowed: dateFrom, dateTo, userId");
    }

    @Test
    void rejectsReversedDateRange() {
        assertThat(ReportParameters.validate(ReportType.USER_ACTIVITY, Map.of("dateFrom", "2026-02-01", "dateTo", "2026-01-01")))
                .containsExactly("parameter 'dateFrom' (2026-02-01) must not be after 'dateTo' (2026-01-01)");
    }

    @Test
    void rejectsBlankNullAndOversizedValues() {
        Map<String, String> params = new HashMap<>();
        params.put("region", " ");
        params.put("dateTo", null);
        params.put("dateFrom", "x".repeat(101));
        assertThat(ReportParameters.validate(ReportType.SALES_SUMMARY, params)).containsExactlyInAnyOrder(
                "parameter 'region' must not be blank",
                "parameter 'dateTo' must not be blank",
                "parameter 'dateFrom' must be at most 100 characters");
    }

    @Test
    void boundsThresholdsAndIds() {
        assertThat(ReportParameters.validate(ReportType.INVENTORY_SNAPSHOT, Map.of("lowStockThreshold", "-1")))
                .containsExactly("parameter 'lowStockThreshold' must be between 0 and 1000000, got -1");
        assertThat(ReportParameters.validate(ReportType.INVENTORY_SNAPSHOT, Map.of("lowStockThreshold", "1.5")))
                .containsExactly("parameter 'lowStockThreshold' must be an integer, got '1.5'");
        assertThat(ReportParameters.validate(ReportType.USER_ACTIVITY, Map.of("userId", "0")))
                .containsExactly("parameter 'userId' must be a positive integer, got 0");
        assertThat(ReportParameters.validate(ReportType.INVENTORY_SNAPSHOT, Map.of("warehouse", "WH" + (char) 7 + "EAST")))
                .containsExactly("parameter 'warehouse' must not contain control characters");
    }

    @Test
    void parametersOfAnotherTypeAreUnknown() {
        assertThat(ReportParameters.validate(ReportType.INVENTORY_SNAPSHOT, Map.of("dateFrom", "2026-01-01")))
                .containsExactly("unknown parameter 'dateFrom' for INVENTORY_SNAPSHOT; allowed: warehouse, lowStockThreshold");
    }

    @Test
    void normalizeThrowsWithAllProblems() {
        assertThatThrownBy(() -> ReportParameters.of(ReportType.USER_ACTIVITY, Map.of("userId", "x", "extra", "y")))
                .isInstanceOf(InvalidReportParametersException.class)
                .satisfies(e -> assertThat(((InvalidReportParametersException) e).getProblems()).hasSize(2));
    }

    @Test
    void typedAccessorsFallBackWhenAbsent() {
        ReportParameters typed = ReportParameters.of(ReportType.INVENTORY_SNAPSHOT, Map.of());
        assertThat(typed.warehouse()).isEmpty();
        assertThat(typed.lowStockThreshold(10)).isEqualTo(10);
        assertThat(ReportParameters.of(ReportType.USER_ACTIVITY, Map.of("userId", "42")).userId()).hasValue(42);
    }
}
