package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.report.ReportParameters;
import com.taskforge.worker.data.DataSeeder;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The three generators over the seeded sample dataset. The important property: the summary and
 * breakdown sections are computed over exactly the rows above them, filters included.
 */
class ReportGeneratorsTest {

    private static EmbeddedDatabase db;
    private static JdbcTemplate jdbc;
    private static final Clock clock = Clock.systemUTC();

    @BeforeAll
    static void seed() {
        db = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2).generateUniqueName(true).build();
        jdbc = new JdbcTemplate(db);
        new DataSeeder(jdbc, clock).seed();
    }

    @AfterAll
    static void close() {
        db.shutdown();
    }

    private static List<String> lines(byte[] csv) {
        String text = new String(csv, StandardCharsets.UTF_8);
        assertThat(text).contains("\r\n").doesNotContain("\n\n\n");
        return Arrays.asList(text.split("\r\n"));
    }

    private static List<String[]> dataRows(List<String> lines) {
        return lines.stream().skip(1).takeWhile(l -> !l.isEmpty()).map(l -> l.split(",")).toList();
    }

    private static long summaryNumber(String summaryLine, String label) {
        Matcher m = Pattern.compile("(\\d+) " + label).matcher(summaryLine);
        assertThat(m.find()).as("summary line has '%s': %s", label, summaryLine).isTrue();
        return Long.parseLong(m.group(1));
    }

    @Test
    void salesSummaryAppliesTheRegionFilterToRowsAndSummary() {
        byte[] csv = new SalesSummaryGenerator(jdbc, clock).generate(ReportParameters.of(ReportType.SALES_SUMMARY,
                Map.of("dateFrom", LocalDate.now(clock).minusDays(90).toString(), "region", "North")));
        List<String> lines = lines(csv);
        assertThat(lines.get(0)).isEqualTo("product,region,total_quantity,total_revenue,avg_price,order_count");

        List<String[]> rows = dataRows(lines);
        assertThat(rows).isNotEmpty().allSatisfy(r -> assertThat(r[1]).isEqualTo("North"));
        long units = rows.stream().mapToLong(r -> Long.parseLong(r[2])).sum();
        long orders = rows.stream().mapToLong(r -> Long.parseLong(r[5])).sum();

        String summary = lines.get(lines.size() - 1);
        assertThat(summary).startsWith("# Summary:");
        assertThat(summaryNumber(summary, "units sold")).isEqualTo(units);
        assertThat(summaryNumber(summary, "orders")).isEqualTo(orders);
        assertThat(summaryNumber(summary, "products")).isEqualTo(rows.stream().map(r -> r[0]).distinct().count());
    }

    @Test
    void salesSummaryWithoutFiltersCoversEveryRegion() {
        byte[] csv = new SalesSummaryGenerator(jdbc, clock).generate(ReportParameters.of(ReportType.SALES_SUMMARY,
                Map.of("dateFrom", LocalDate.now(clock).minusDays(90).toString())));
        List<String> lines = lines(csv);
        List<String[]> rows = dataRows(lines);
        assertThat(rows.stream().map(r -> r[1]).distinct()).containsExactlyInAnyOrder("North", "South", "East", "West");
        assertThat(summaryNumber(lines.get(lines.size() - 1), "orders")).isEqualTo(800);
    }

    @Test
    void salesSummaryHonoursTheDateRange() {
        String today = LocalDate.now(clock).toString();
        byte[] narrow = new SalesSummaryGenerator(jdbc, clock).generate(ReportParameters.of(ReportType.SALES_SUMMARY,
                Map.of("dateFrom", today, "dateTo", today)));
        byte[] wide = new SalesSummaryGenerator(jdbc, clock).generate(ReportParameters.of(ReportType.SALES_SUMMARY,
                Map.of("dateFrom", LocalDate.now(clock).minusDays(90).toString(), "dateTo", today)));
        assertThat(summaryNumber(lines(narrow).get(lines(narrow).size() - 1), "orders"))
                .isLessThan(summaryNumber(lines(wide).get(lines(wide).size() - 1), "orders"));
    }

    @Test
    void inventorySnapshotAppliesTheWarehouseFilterToRowsAndSummary() {
        byte[] csv = new InventorySnapshotGenerator(jdbc).generate(ReportParameters.of(ReportType.INVENTORY_SNAPSHOT,
                Map.of("warehouse", "WH-NORTH", "lowStockThreshold", "50")));
        List<String> lines = lines(csv);
        List<String[]> rows = dataRows(lines);
        assertThat(rows).hasSize(20).allSatisfy(r -> assertThat(r[2]).isEqualTo("WH-NORTH"));
        long units = rows.stream().mapToLong(r -> Long.parseLong(r[3])).sum();
        long low = rows.stream().filter(r -> r[6].equals("YES")).count();
        assertThat(rows).allSatisfy(r -> assertThat(r[6]).isEqualTo(Integer.parseInt(r[3]) < 50 ? "YES" : "no"));

        String summary = lines.get(lines.size() - 1);
        assertThat(summaryNumber(summary, "items")).isEqualTo(20);
        assertThat(summaryNumber(summary, "total units")).isEqualTo(units);
        assertThat(summaryNumber(summary, "low-stock items")).isEqualTo(low);
    }

    @Test
    void userActivityAppliesTheUserFilterToRowsAndHourlyBreakdown() {
        byte[] csv = new UserActivityGenerator(jdbc, clock).generate(ReportParameters.of(ReportType.USER_ACTIVITY,
                Map.of("dateFrom", LocalDate.now(clock).minusDays(30).toString(), "userId", "1")));
        List<String> lines = lines(csv);
        assertThat(lines.get(0)).isEqualTo("username,email,login_count,total_actions,last_active,most_common_action");
        List<String[]> rows = dataRows(lines);
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0)[0]).isEqualTo("alice");
        long totalActions = Long.parseLong(rows.get(0)[3]);

        int breakdownHeader = lines.indexOf("# Hourly Activity Breakdown");
        assertThat(breakdownHeader).isPositive();
        assertThat(lines.get(breakdownHeader + 1)).isEqualTo("hour,action_count");
        long hourly = lines.subList(breakdownHeader + 2, lines.size()).stream()
                .filter(l -> !l.isEmpty()).mapToLong(l -> Long.parseLong(l.split(",")[1])).sum();
        assertThat(hourly).as("hourly breakdown counts only the filtered user's actions").isEqualTo(totalActions);
    }

    @Test
    void numbersUseAPointRegardlessOfTheDefaultLocale() {
        Locale original = Locale.getDefault();
        Locale.setDefault(Locale.GERMANY);
        try {
            byte[] csv = new InventorySnapshotGenerator(jdbc).generate(ReportParameters.of(ReportType.INVENTORY_SNAPSHOT, Map.of()));
            List<String[]> rows = dataRows(lines(csv));
            assertThat(rows).allSatisfy(r -> {
                assertThat(r[4]).matches("\\d+\\.\\d{2}");
                assertThat(r[5]).matches("\\d+\\.\\d{2}");
            });
        } finally {
            Locale.setDefault(original);
        }
    }
}
