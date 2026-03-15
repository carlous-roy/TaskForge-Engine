package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.exception.ReportGenerationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.util.Map;

@Component
public class InventorySnapshotGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(InventorySnapshotGenerator.class);
    private final JdbcTemplate jdbc;

    public InventorySnapshotGenerator(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public ReportType getType() { return ReportType.INVENTORY_SNAPSHOT; }

    @Override
    public byte[] generate(Map<String, String> params, String correlationId) {
        String warehouse = params.getOrDefault("warehouse", null);
        int lowStockThreshold = parseInt(params.get("lowStockThreshold"), 10);

        log.info("[{}] Generating INVENTORY_SNAPSHOT: warehouse={}, lowStockThreshold={}",
                correlationId, warehouse, lowStockThreshold);

        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            PrintWriter pw = new PrintWriter(out);

            pw.println("product,category,warehouse,stock_quantity,unit_cost,total_value,low_stock");

            String sql = """
                SELECT p.name AS product, p.category, i.warehouse,
                       i.stock_quantity, p.unit_cost,
                       (i.stock_quantity * p.unit_cost) AS total_value
                FROM inventory i
                JOIN products p ON i.product_id = p.id
                """;

            Object[] args;
            if (warehouse != null && !warehouse.isBlank()) {
                sql += " WHERE i.warehouse = ? ORDER BY total_value DESC";
                args = new Object[]{warehouse};
            } else {
                sql += " ORDER BY total_value DESC";
                args = new Object[]{};
            }

            final int threshold = lowStockThreshold;
            jdbc.query(sql, args, rs -> {
                int qty = rs.getInt("stock_quantity");
                pw.printf("%s,%s,%s,%d,%.2f,%.2f,%s%n",
                        escape(rs.getString("product")),
                        rs.getString("category"),
                        rs.getString("warehouse"),
                        qty,
                        rs.getDouble("unit_cost"),
                        rs.getDouble("total_value"),
                        qty < threshold ? "YES" : "no");
            });

            // Summary
            String summSql = """
                SELECT COUNT(*) AS total_items,
                       SUM(i.stock_quantity) AS total_units,
                       SUM(i.stock_quantity * p.unit_cost) AS total_value,
                       SUM(CASE WHEN i.stock_quantity < ? THEN 1 ELSE 0 END) AS low_stock_count
                FROM inventory i
                JOIN products p ON i.product_id = p.id
                """;

            jdbc.query(summSql, new Object[]{lowStockThreshold}, rs -> {
                pw.println();
                pw.printf("# Summary: %d items, %d total units, $%.2f total value, %d low-stock items%n",
                        rs.getInt("total_items"), rs.getInt("total_units"),
                        rs.getDouble("total_value"), rs.getInt("low_stock_count"));
            });

            pw.flush();
            byte[] content = out.toByteArray();
            log.info("[{}] INVENTORY_SNAPSHOT complete: {} bytes", correlationId, content.length);
            return content;

        } catch (Exception e) {
            throw new ReportGenerationException("Inventory snapshot failed: " + e.getMessage(), e, true);
        }
    }

    private static int parseInt(String s, int fallback) {
        if (s == null || s.isBlank()) return fallback;
        try { return Integer.parseInt(s); }
        catch (Exception e) { return fallback; }
    }

    private static String escape(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"")) return "\"" + s.replace("\"", "\"\"") + "\"";
        return s;
    }
}
