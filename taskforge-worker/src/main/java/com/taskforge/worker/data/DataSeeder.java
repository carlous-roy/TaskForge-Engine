package com.taskforge.worker.data;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Random;

@Component
public class DataSeeder {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);
    private final JdbcTemplate jdbc;
    private final Random rng = new Random(42); // Fixed seed for reproducibility

    private static final String[] CATEGORIES = {"Electronics", "Clothing", "Food", "Office", "Tools"};
    private static final String[] REGIONS = {"North", "South", "East", "West"};
    private static final String[] WAREHOUSES = {"WH-NORTH", "WH-SOUTH", "WH-EAST", "WH-WEST"};
    private static final String[] ACTIONS = {"LOGIN", "VIEW_PAGE", "SEARCH", "ADD_TO_CART", "PURCHASE", "LOGOUT"};

    private static final String[][] PRODUCTS = {
            {"Wireless Mouse", "Electronics"}, {"USB-C Hub", "Electronics"}, {"Mechanical Keyboard", "Electronics"},
            {"Monitor Stand", "Office"}, {"Desk Lamp", "Office"}, {"Notebook Set", "Office"},
            {"Running Shoes", "Clothing"}, {"Winter Jacket", "Clothing"}, {"Cotton T-Shirt", "Clothing"},
            {"Protein Bars", "Food"}, {"Coffee Beans", "Food"}, {"Green Tea", "Food"},
            {"Power Drill", "Tools"}, {"Screwdriver Set", "Tools"}, {"Tape Measure", "Tools"},
            {"Webcam HD", "Electronics"}, {"Headphones", "Electronics"}, {"Phone Case", "Electronics"},
            {"Yoga Mat", "Clothing"}, {"Hiking Backpack", "Clothing"},
    };

    public DataSeeder(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @PostConstruct
    public void seed() {
        createTables();
        seedProducts();
        seedTransactions();
        seedInventory();
        seedUsers();
        seedUserActivity();
        log.info("Database seeded successfully");
    }

    private void createTables() {
        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                category VARCHAR(50) NOT NULL,
                unit_cost DECIMAL(10,2) NOT NULL
            )""");

        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                product_id BIGINT NOT NULL,
                region VARCHAR(20) NOT NULL,
                quantity INT NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                sale_date DATE NOT NULL,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )""");

        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS inventory (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                product_id BIGINT NOT NULL,
                warehouse VARCHAR(20) NOT NULL,
                stock_quantity INT NOT NULL,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )""");

        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                email VARCHAR(100) NOT NULL
            )""");

        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS user_activity (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                action_type VARCHAR(30) NOT NULL,
                action_date DATE NOT NULL,
                action_time TIME NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )""");
    }

    private void seedProducts() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM products", Integer.class);
        if (count != null && count > 0) return;

        for (String[] p : PRODUCTS) {
            double cost = 5.0 + rng.nextDouble() * 195.0;
            jdbc.update("INSERT INTO products (name, category, unit_cost) VALUES (?, ?, ?)",
                    p[0], p[1], Math.round(cost * 100.0) / 100.0);
        }
        log.info("Seeded {} products", PRODUCTS.length);
    }

    private void seedTransactions() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM transactions", Integer.class);
        if (count != null && count > 0) return;

        LocalDate start = LocalDate.now().minusDays(90);
        int numTransactions = 800;

        for (int i = 0; i < numTransactions; i++) {
            long productId = 1 + rng.nextInt(PRODUCTS.length);
            String region = REGIONS[rng.nextInt(REGIONS.length)];
            int qty = 1 + rng.nextInt(20);
            double price = 10.0 + rng.nextDouble() * 190.0;
            LocalDate date = start.plusDays(rng.nextInt(90));

            jdbc.update("INSERT INTO transactions (product_id, region, quantity, unit_price, sale_date) VALUES (?, ?, ?, ?, ?)",
                    productId, region, qty, Math.round(price * 100.0) / 100.0, date);
        }
        log.info("Seeded {} transactions", numTransactions);
    }

    private void seedInventory() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM inventory", Integer.class);
        if (count != null && count > 0) return;

        for (int pid = 1; pid <= PRODUCTS.length; pid++) {
            for (String wh : WAREHOUSES) {
                int qty = rng.nextInt(200);
                jdbc.update("INSERT INTO inventory (product_id, warehouse, stock_quantity) VALUES (?, ?, ?)",
                        pid, wh, qty);
            }
        }
        log.info("Seeded inventory ({} products x {} warehouses)", PRODUCTS.length, WAREHOUSES.length);
    }

    private void seedUsers() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM users", Integer.class);
        if (count != null && count > 0) return;

        String[] firstNames = {"Alice", "Bob", "Carol", "David", "Eve", "Frank", "Grace", "Henry",
                "Iris", "Jack", "Kate", "Leo", "Mia", "Noah", "Olivia", "Paul", "Quinn", "Rose",
                "Sam", "Tina", "Uma", "Victor", "Wendy", "Xander", "Yara"};

        for (String name : firstNames) {
            String username = name.toLowerCase();
            jdbc.update("INSERT INTO users (username, email) VALUES (?, ?)",
                    username, username + "@example.com");
        }
        log.info("Seeded {} users", firstNames.length);
    }

    private void seedUserActivity() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM user_activity", Integer.class);
        if (count != null && count > 0) return;

        LocalDate start = LocalDate.now().minusDays(30);
        int numActivities = 500;

        for (int i = 0; i < numActivities; i++) {
            long userId = 1 + rng.nextInt(25);
            String action = ACTIONS[rng.nextInt(ACTIONS.length)];
            LocalDate date = start.plusDays(rng.nextInt(30));
            LocalTime time = LocalTime.of(rng.nextInt(24), rng.nextInt(60), rng.nextInt(60));

            jdbc.update("INSERT INTO user_activity (user_id, action_type, action_date, action_time) VALUES (?, ?, ?, ?)",
                    userId, action, date, time);
        }
        log.info("Seeded {} user activities", numActivities);
    }
}
