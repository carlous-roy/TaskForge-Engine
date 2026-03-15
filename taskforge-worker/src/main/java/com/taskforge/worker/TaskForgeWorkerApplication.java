package com.taskforge.worker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@ComponentScan(basePackages = {"com.taskforge.worker", "com.taskforge.common"})
@EnableScheduling
public class TaskForgeWorkerApplication {
    public static void main(String[] args) {
        SpringApplication.run(TaskForgeWorkerApplication.class, args);
    }
}
