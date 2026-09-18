package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.report.ReportParameters;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Stock per product and warehouse with a low-stock flag, then a summary over the same rows: the
 * warehouse filter applies to the summary as well.
 */
@Component
public class InventorySnapshotGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(InventorySnapshotGenerator.class);
    static final int DEFAULT_LOW_STOCK_THRESHOLD = 10;

    private final JdbcTemplate jdbc;

    public InventorySnapshotGenerator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public ReportType getType() {
        return ReportType.INVENTORY_SNAPSHOT;
    }

    @Override
    public byte[] generate(ReportParameters params) {
        String warehouse = params.warehouse().orElse(null);
        int threshold = params.lowStockThreshold(DEFAULT_LOW_STOCK_THRESHOLD);
        log.info("Generating INVENTORY_SNAPSHOT warehouse={} lowStockThreshold={}", warehouse == null ? "all" : warehouse, threshold);

        String where = warehouse == null ? "" : " WHERE i.warehouse = ?";
        List<Object> args = new ArrayList<>();
        if (warehouse != null) args.add(warehouse);

        CsvWriter csv = new CsvWriter().row("product", "category", "warehouse", "stock_quantity", "unit_cost", "total_value", "low_stock");
        jdbc.query("""
                SELECT p.name AS product, p.category, i.warehouse, i.stock_quantity, p.unit_cost,
                       (i.stock_quantity * p.unit_cost) AS total_value
                FROM inventory i
                JOIN products p ON i.product_id = p.id
                """ + where + " ORDER BY total_value DESC, p.name, i.warehouse",
                rs -> {
                    int qty = rs.getInt("stock_quantity");
                    csv.row(rs.getString("product"), rs.getString("category"), rs.getString("warehouse"), qty,
                            rs.getDouble("unit_cost"), rs.getDouble("total_value"), qty < threshold ? "YES" : "no");
                },
                args.toArray());

        List<Object> summaryArgs = new ArrayList<>(List.of(threshold));
        summaryArgs.addAll(args);
        jdbc.query("""
                SELECT COUNT(*) AS total_items,
                       COALESCE(SUM(i.stock_quantity), 0) AS total_units,
                       COALESCE(SUM(i.stock_quantity * p.unit_cost), 0) AS total_value,
                       COALESCE(SUM(CASE WHEN i.stock_quantity < ? THEN 1 ELSE 0 END), 0) AS low_stock_count
                FROM inventory i
                JOIN products p ON i.product_id = p.id
                """ + where,
                rs -> { csv.note("# Summary: %d items, %d total units, $%s total value, %d low-stock items".formatted(
                        rs.getInt("total_items"), rs.getInt("total_units"), CsvWriter.money(rs.getDouble("total_value")),
                        rs.getInt("low_stock_count"))); },
                summaryArgs.toArray());

        byte[] content = csv.toBytes();
        log.info("INVENTORY_SNAPSHOT complete: {} bytes", content.length);
        return content;
    }
}
