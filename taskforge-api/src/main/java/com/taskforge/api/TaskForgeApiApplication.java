package com.taskforge.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

@SpringBootApplication
@ComponentScan(basePackages = {"com.taskforge.api", "com.taskforge.common"})
public class TaskForgeApiApplication {
    public static void main(String[] args) {
        SpringApplication.run(TaskForgeApiApplication.class, args);
    }
}
