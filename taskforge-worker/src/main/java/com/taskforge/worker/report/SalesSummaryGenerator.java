package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.report.ReportParameters;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Sales by product and region over a date range: one row per (product, region), then a summary line
 * computed over exactly the rows above it, so the same date and region filters apply to both.
 */
@Component
public class SalesSummaryGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(SalesSummaryGenerator.class);

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public SalesSummaryGenerator(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override
    public ReportType getType() {
        return ReportType.SALES_SUMMARY;
    }

    @Override
    public byte[] generate(ReportParameters params) {
        LocalDate today = LocalDate.now(clock);
        LocalDate dateFrom = params.dateFrom(today.minusDays(30));
        LocalDate dateTo = params.dateTo(today);
        String region = params.region().orElse(null);
        log.info("Generating SALES_SUMMARY {}..{} region={}", dateFrom, dateTo, region == null ? "all" : region);

        String where = " WHERE t.sale_date BETWEEN ? AND ?" + (region == null ? "" : " AND t.region = ?");
        List<Object> args = new ArrayList<>(List.of(dateFrom, dateTo));
        if (region != null) args.add(region);

        CsvWriter csv = new CsvWriter().row("product", "region", "total_quantity", "total_revenue", "avg_price", "order_count");
        jdbc.query("""
                SELECT p.name AS product, t.region,
                       SUM(t.quantity) AS total_qty,
                       SUM(t.quantity * t.unit_price) AS total_rev,
                       AVG(t.unit_price) AS avg_price,
                       COUNT(*) AS order_count
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                """ + where + " GROUP BY p.name, t.region ORDER BY total_rev DESC, p.name, t.region",
                rs -> { csv.row(rs.getString("product"), rs.getString("region"), rs.getInt("total_qty"),
                        rs.getDouble("total_rev"), rs.getDouble("avg_price"), rs.getInt("order_count")); },
                args.toArray());

        jdbc.query("""
                SELECT COUNT(DISTINCT t.product_id) AS products,
                       COALESCE(SUM(t.quantity), 0) AS total_qty,
                       COALESCE(SUM(t.quantity * t.unit_price), 0) AS total_rev,
                       COUNT(*) AS total_orders
                FROM transactions t
                """ + where,
                rs -> { csv.note("# Summary: %d products, %d units sold, $%s total revenue, %d orders".formatted(
                        rs.getInt("products"), rs.getInt("total_qty"), CsvWriter.money(rs.getDouble("total_rev")),
                        rs.getInt("total_orders"))); },
                args.toArray());

        byte[] content = csv.toBytes();
        log.info("SALES_SUMMARY complete: {} bytes", content.length);
        return content;
    }
}
