package com.taskforge.common.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.InvalidReportParametersException;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.function.BiConsumer;

/**
 * The parameters each report type accepts, with their validation rules.
 *
 * <p>The API validates a submission with {@link #normalize} so a bad date or id is rejected with a
 * 400 before a job exists. The worker re-parses with {@link #of}; a failure there is a non-retryable
 * error, because the same input will fail the same way on every attempt.
 */
public final class ReportParameters {

    public static final int MAX_VALUE_LENGTH = 100;
    public static final int MAX_THRESHOLD = 1_000_000;

    private static final Map<ReportType, Map<String, BiConsumer<String, List<String>>>> RULES = buildRules();

    private final Map<String, String> values;

    private ReportParameters(Map<String, String> values) {
        this.values = values;
    }

    /** Names accepted for a type, in a stable order for error messages. */
    public static List<String> allowedNames(ReportType type) {
        return List.copyOf(RULES.get(type).keySet());
    }

    /** Every problem with {@code raw} for {@code type}; empty when the parameters are valid. */
    public static List<String> validate(ReportType type, Map<String, String> raw) {
        List<String> problems = new ArrayList<>();
        if (raw == null || raw.isEmpty()) {
            return problems;
        }
        Map<String, BiConsumer<String, List<String>>> rules = RULES.get(type);
        for (Map.Entry<String, String> e : raw.entrySet()) {
            String name = e.getKey();
            String value = e.getValue();
            BiConsumer<String, List<String>> rule = name == null ? null : rules.get(name);
            if (rule == null) {
                problems.add("unknown parameter '" + name + "' for " + type + "; allowed: " + String.join(", ", rules.keySet()));
                continue;
            }
            if (value == null || value.isBlank()) {
                problems.add("parameter '" + name + "' must not be blank");
                continue;
            }
            if (value.length() > MAX_VALUE_LENGTH) {
                problems.add("parameter '" + name + "' must be at most " + MAX_VALUE_LENGTH + " characters");
                continue;
            }
            rule.accept(value.trim(), problems);
        }
        if (problems.isEmpty() && raw.containsKey("dateFrom") && raw.containsKey("dateTo")) {
            LocalDate from = LocalDate.parse(raw.get("dateFrom").trim());
            LocalDate to = LocalDate.parse(raw.get("dateTo").trim());
            if (from.isAfter(to)) {
                problems.add("parameter 'dateFrom' (" + from + ") must not be after 'dateTo' (" + to + ")");
            }
        }
        return problems;
    }

    /** Validates and returns a trimmed copy, or throws with every problem listed. */
    public static Map<String, String> normalize(ReportType type, Map<String, String> raw) {
        List<String> problems = validate(type, raw);
        if (!problems.isEmpty()) {
            throw new InvalidReportParametersException(problems);
        }
        Map<String, String> trimmed = new LinkedHashMap<>();
        if (raw != null) {
            raw.forEach((k, v) -> trimmed.put(k, v.trim()));
        }
        return Collections.unmodifiableMap(trimmed);
    }

    /** Typed view over already validated parameters; throws if they are not valid for the type. */
    public static ReportParameters of(ReportType type, Map<String, String> raw) {
        return new ReportParameters(normalize(type, raw));
    }

    public LocalDate dateFrom(LocalDate fallback) {
        return values.containsKey("dateFrom") ? LocalDate.parse(values.get("dateFrom")) : fallback;
    }

    public LocalDate dateTo(LocalDate fallback) {
        return values.containsKey("dateTo") ? LocalDate.parse(values.get("dateTo")) : fallback;
    }

    public Optional<String> region() {
        return Optional.ofNullable(values.get("region"));
    }

    public Optional<String> warehouse() {
        return Optional.ofNullable(values.get("warehouse"));
    }

    public int lowStockThreshold(int fallback) {
        return values.containsKey("lowStockThreshold") ? Integer.parseInt(values.get("lowStockThreshold")) : fallback;
    }

    public OptionalLong userId() {
        return values.containsKey("userId") ? OptionalLong.of(Long.parseLong(values.get("userId"))) : OptionalLong.empty();
    }

    public Map<String, String> asMap() {
        return values;
    }

    // ---- rules -------------------------------------------------------------------------------

    private static Map<ReportType, Map<String, BiConsumer<String, List<String>>>> buildRules() {
        Map<ReportType, Map<String, BiConsumer<String, List<String>>>> rules = new LinkedHashMap<>();

        Map<String, BiConsumer<String, List<String>>> sales = new LinkedHashMap<>();
        sales.put("dateFrom", isoDate("dateFrom"));
        sales.put("dateTo", isoDate("dateTo"));
        sales.put("region", text("region"));
        rules.put(ReportType.SALES_SUMMARY, sales);

        Map<String, BiConsumer<String, List<String>>> inventory = new LinkedHashMap<>();
        inventory.put("warehouse", text("warehouse"));
        inventory.put("lowStockThreshold", boundedInt("lowStockThreshold", 0, MAX_THRESHOLD));
        rules.put(ReportType.INVENTORY_SNAPSHOT, inventory);

        Map<String, BiConsumer<String, List<String>>> activity = new LinkedHashMap<>();
        activity.put("dateFrom", isoDate("dateFrom"));
        activity.put("dateTo", isoDate("dateTo"));
        activity.put("userId", positiveLong("userId"));
        rules.put(ReportType.USER_ACTIVITY, activity);

        for (ReportType type : ReportType.values()) {
            if (!rules.containsKey(type)) {
                throw new IllegalStateException("No parameter rules for " + type);
            }
        }
        return rules;
    }

    private static BiConsumer<String, List<String>> isoDate(String name) {
        return (value, problems) -> {
            try {
                LocalDate.parse(value);
            } catch (DateTimeParseException e) {
                problems.add("parameter '" + name + "' must be an ISO-8601 date (yyyy-MM-dd), got '" + value + "'");
            }
        };
    }

    private static BiConsumer<String, List<String>> text(String name) {
        return (value, problems) -> {
            if (value.chars().anyMatch(Character::isISOControl)) {
                problems.add("parameter '" + name + "' must not contain control characters");
            }
        };
    }

    private static BiConsumer<String, List<String>> boundedInt(String name, int min, int max) {
        return (value, problems) -> {
            try {
                int n = Integer.parseInt(value);
                if (n < min || n > max) {
                    problems.add("parameter '" + name + "' must be between " + min + " and " + max + ", got " + n);
                }
            } catch (NumberFormatException e) {
                problems.add("parameter '" + name + "' must be an integer, got '" + value + "'");
            }
        };
    }

    private static BiConsumer<String, List<String>> positiveLong(String name) {
        return (value, problems) -> {
            try {
                long n = Long.parseLong(value);
                if (n <= 0) {
                    problems.add("parameter '" + name + "' must be a positive integer, got " + n);
                }
            } catch (NumberFormatException e) {
                problems.add("parameter '" + name + "' must be a positive integer, got '" + value + "'");
            }
        };
    }
}
