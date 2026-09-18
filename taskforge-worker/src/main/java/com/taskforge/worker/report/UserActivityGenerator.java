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
import java.util.OptionalLong;

/**
 * Per-user activity over a date range, optionally for one user, followed by an hourly breakdown of
 * the same rows: the date range and the user filter apply to both sections.
 */
@Component
public class UserActivityGenerator implements ReportGenerator {

    private static final Logger log = LoggerFactory.getLogger(UserActivityGenerator.class);

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public UserActivityGenerator(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override
    public ReportType getType() {
        return ReportType.USER_ACTIVITY;
    }

    @Override
    public byte[] generate(ReportParameters params) {
        LocalDate today = LocalDate.now(clock);
        LocalDate dateFrom = params.dateFrom(today.minusDays(7));
        LocalDate dateTo = params.dateTo(today);
        OptionalLong userId = params.userId();
        log.info("Generating USER_ACTIVITY {}..{} userId={}", dateFrom, dateTo, userId.isPresent() ? userId.getAsLong() : "all");

        String userFilter = userId.isPresent() ? " AND a.user_id = ?" : "";
        List<Object> filterArgs = new ArrayList<>(List.of(dateFrom, dateTo));
        userId.ifPresent(filterArgs::add);

        CsvWriter csv = new CsvWriter().row("username", "email", "login_count", "total_actions", "last_active", "most_common_action");
        List<Object> args = new ArrayList<>(filterArgs);   // sub-select
        args.addAll(filterArgs);                             // outer query
        jdbc.query("""
                SELECT u.username, u.email,
                       SUM(CASE WHEN a.action_type = 'LOGIN' THEN 1 ELSE 0 END) AS login_count,
                       COUNT(*) AS total_actions,
                       MAX(a.action_date) AS last_active,
                       (SELECT a2.action_type FROM user_activity a2
                        WHERE a2.user_id = u.id AND a2.action_date BETWEEN ? AND ?
                        GROUP BY a2.action_type ORDER BY COUNT(*) DESC, a2.action_type LIMIT 1) AS top_action
                FROM users u
                JOIN user_activity a ON u.id = a.user_id
                WHERE a.action_date BETWEEN ? AND ?
                """ + userFilter.replace("a.user_id", "u.id") + """
                 GROUP BY u.id, u.username, u.email
                ORDER BY total_actions DESC, u.username
                """,
                rs -> { csv.row(rs.getString("username"), rs.getString("email"), rs.getInt("login_count"),
                        rs.getInt("total_actions"), rs.getString("last_active"), rs.getString("top_action")); },
                args.toArray());

        csv.note("# Hourly Activity Breakdown");
        csv.row("hour", "action_count");
        jdbc.query("""
                SELECT HOUR(a.action_time) AS hr, COUNT(*) AS cnt
                FROM user_activity a
                WHERE a.action_date BETWEEN ? AND ?
                """ + userFilter + " GROUP BY HOUR(a.action_time) ORDER BY hr",
                rs -> { csv.row(String.format("%02d:00", rs.getInt("hr")), rs.getInt("cnt")); },
                filterArgs.toArray());

        byte[] content = csv.toBytes();
        log.info("USER_ACTIVITY complete: {} bytes", content.length);
        return content;
    }
}
