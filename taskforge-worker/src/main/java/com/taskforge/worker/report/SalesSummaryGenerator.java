package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportGenerationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.time.LocalDate;
import java.util.Map;

@Component
public class SalesSummaryGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(SalesSummaryGenerator.class);
    private final JdbcTemplate jdbc;

    public SalesSummaryGenerator(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public ReportType getType() { return ReportType.SALES_SUMMARY; }

    @Override
    public byte[] generate(Map<String, String> params, String correlationId) {
        LocalDate dateFrom = parseDate(params.get("dateFrom"), LocalDate.now().minusDays(30));
        LocalDate dateTo = parseDate(params.get("dateTo"), LocalDate.now());
        String region = params.getOrDefault("region", null);

        log.info("[{}] Generating SALES_SUMMARY: {} to {}, region={}", correlationId, dateFrom, dateTo, region);

        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            PrintWriter pw = new PrintWriter(out);

            pw.println("product,region,total_quantity,total_revenue,avg_price,order_count");

            String sql = """
                SELECT p.name AS product, t.region,
                       SUM(t.quantity) AS total_qty,
                       SUM(t.quantity * t.unit_price) AS total_rev,
                       AVG(t.unit_price) AS avg_price,
                       COUNT(*) AS order_count
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                WHERE t.sale_date BETWEEN ? AND ?
                """;

            Object[] args;
            if (region != null && !region.isBlank()) {
                sql += " AND t.region = ?";
                sql += " GROUP BY p.name, t.region ORDER BY total_rev DESC";
                args = new Object[]{dateFrom, dateTo, region};
            } else {
                sql += " GROUP BY p.name, t.region ORDER BY total_rev DESC";
                args = new Object[]{dateFrom, dateTo};
            }

            jdbc.query(sql, args, rs -> {
                pw.printf("%s,%s,%d,%.2f,%.2f,%d%n",
                        escape(rs.getString("product")),
                        rs.getString("region"),
                        rs.getInt("total_qty"),
                        rs.getDouble("total_rev"),
                        rs.getDouble("avg_price"),
                        rs.getInt("order_count"));
            });

            // Summary row
            String summSql = """
                SELECT COUNT(DISTINCT product_id) AS products,
                       SUM(quantity) AS total_qty,
                       SUM(quantity * unit_price) AS total_rev,
                       COUNT(*) AS total_orders
                FROM transactions WHERE sale_date BETWEEN ? AND ?
                """;

            jdbc.query(summSql, new Object[]{dateFrom, dateTo}, rs -> {
                pw.println();
                pw.printf("# Summary: %d products, %d units sold, $%.2f total revenue, %d orders%n",
                        rs.getInt("products"), rs.getInt("total_qty"),
                        rs.getDouble("total_rev"), rs.getInt("total_orders"));
            });

            pw.flush();
            byte[] content = out.toByteArray();
            log.info("[{}] SALES_SUMMARY complete: {} bytes", correlationId, content.length);
            return content;

        } catch (Exception e) {
            throw new ReportGenerationException("Sales summary generation failed: " + e.getMessage(), e, true);
        }
    }

    private static LocalDate parseDate(String s, LocalDate fallback) {
        if (s == null || s.isBlank()) return fallback;
        try { return LocalDate.parse(s); }
        catch (Exception e) { return fallback; }
    }

    private static String escape(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"")) return "\"" + s.replace("\"", "\"\"") + "\"";
        return s;
    }
}
