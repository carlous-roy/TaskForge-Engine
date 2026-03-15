package com.taskforge.common.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.sqs.SqsClient;

import java.net.URI;

@Configuration
public class AwsConfig {

    private static final Logger log = LoggerFactory.getLogger(AwsConfig.class);

    @Value("${aws.region:us-east-1}")
    private String region;

    @Value("${aws.endpoint:}")
    private String endpoint;

    @Value("${aws.access-key:changeme}")
    private String accessKey;

    @Value("${aws.secret-key:changeme}")
    private String secretKey;

    private StaticCredentialsProvider credentials() {
        return StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey));
    }

    private boolean hasEndpoint() {
        return endpoint != null && !endpoint.isBlank();
    }

    @Bean
    public DynamoDbClient dynamoDbClient() {
        var builder = DynamoDbClient.builder()
                .region(Region.of(region))
                .credentialsProvider(credentials());
        if (hasEndpoint()) builder.endpointOverride(URI.create(endpoint));
        log.info("DynamoDB client configured (endpoint={})", hasEndpoint() ? endpoint : "AWS default");
        return builder.build();
    }

    @Bean
    public SqsClient sqsClient() {
        var builder = SqsClient.builder()
                .region(Region.of(region))
                .credentialsProvider(credentials());
        if (hasEndpoint()) builder.endpointOverride(URI.create(endpoint));
        log.info("SQS client configured (endpoint={})", hasEndpoint() ? endpoint : "AWS default");
        return builder.build();
    }

    @Bean
    public S3Client s3Client() {
        var builder = S3Client.builder()
                .region(Region.of(region))
                .credentialsProvider(credentials())
                .forcePathStyle(true);  // Required for LocalStack
        if (hasEndpoint()) builder.endpointOverride(URI.create(endpoint));
        log.info("S3 client configured (endpoint={})", hasEndpoint() ? endpoint : "AWS default");
        return builder.build();
    }

    @Bean
    public S3Presigner s3Presigner() {
        var builder = S3Presigner.builder()
                .region(Region.of(region))
                .credentialsProvider(credentials());
        if (hasEndpoint()) builder.endpointOverride(URI.create(endpoint));
        return builder.build();
    }
}
