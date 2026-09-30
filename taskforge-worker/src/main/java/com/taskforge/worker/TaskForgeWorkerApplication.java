package com.taskforge.worker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

@SpringBootApplication
@ComponentScan(basePackages = {"com.taskforge.worker", "com.taskforge.common"})
public class TaskForgeWorkerApplication {
    public static void main(String[] args) {
        SpringApplication.run(TaskForgeWorkerApplication.class, args);
    }
}
