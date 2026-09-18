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
public class UserActivityGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(UserActivityGenerator.class);
    private final JdbcTemplate jdbc;

    public UserActivityGenerator(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public ReportType getType() { return ReportType.USER_ACTIVITY; }

    @Override
    public byte[] generate(Map<String, String> params, String correlationId) {
        LocalDate dateFrom = parseDate(params.get("dateFrom"), LocalDate.now().minusDays(7));
        LocalDate dateTo = parseDate(params.get("dateTo"), LocalDate.now());
        String userId = params.getOrDefault("userId", null);

        log.info("[{}] Generating USER_ACTIVITY: {} to {}, userId={}", correlationId, dateFrom, dateTo, userId);

        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            PrintWriter pw = new PrintWriter(out);

            pw.println("username,email,login_count,total_actions,last_active,most_common_action");

            String sql = """
                SELECT u.username, u.email,
                       SUM(CASE WHEN a.action_type = 'LOGIN' THEN 1 ELSE 0 END) AS login_count,
                       COUNT(*) AS total_actions,
                       MAX(a.action_date) AS last_active,
                       (SELECT a2.action_type FROM user_activity a2
                        WHERE a2.user_id = u.id AND a2.action_date BETWEEN ? AND ?
                        GROUP BY a2.action_type ORDER BY COUNT(*) DESC LIMIT 1) AS top_action
                FROM users u
                JOIN user_activity a ON u.id = a.user_id
                WHERE a.action_date BETWEEN ? AND ?
                """;

            Object[] args;
            if (userId != null && !userId.isBlank()) {
                sql += " AND u.id = ? GROUP BY u.username, u.email, u.id ORDER BY total_actions DESC";
                args = new Object[]{dateFrom, dateTo, dateFrom, dateTo, Long.parseLong(userId)};
            } else {
                sql += " GROUP BY u.username, u.email, u.id ORDER BY total_actions DESC";
                args = new Object[]{dateFrom, dateTo, dateFrom, dateTo};
            }

            jdbc.query(sql, rs -> {
                pw.printf("%s,%s,%d,%d,%s,%s%n",
                        rs.getString("username"),
                        rs.getString("email"),
                        rs.getInt("login_count"),
                        rs.getInt("total_actions"),
                        rs.getString("last_active"),
                        rs.getString("top_action"));
            }, args);

            // Hourly breakdown
            pw.println();
            pw.println("# Hourly Activity Breakdown");
            pw.println("hour,action_count");

            jdbc.query("""
                SELECT HOUR(a.action_time) AS hr, COUNT(*) AS cnt
                FROM user_activity a
                WHERE a.action_date BETWEEN ? AND ?
                GROUP BY HOUR(a.action_time) ORDER BY hr
                """, rs -> {
                pw.printf("%02d:00,%d%n", rs.getInt("hr"), rs.getInt("cnt"));
            }, dateFrom, dateTo);

            pw.flush();
            byte[] content = out.toByteArray();
            log.info("[{}] USER_ACTIVITY complete: {} bytes", correlationId, content.length);
            return content;

        } catch (Exception e) {
            throw new ReportGenerationException("User activity report failed: " + e.getMessage(), e, true);
        }
    }

    private static LocalDate parseDate(String s, LocalDate fallback) {
        if (s == null || s.isBlank()) return fallback;
        try { return LocalDate.parse(s); }
        catch (Exception e) { return fallback; }
    }
}
