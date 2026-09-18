package com.taskforge.common.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.sqs.SqsClient;

import java.net.URI;

@Configuration
@EnableConfigurationProperties({AwsProperties.class, TaskForgeProperties.class})
public class AwsConfig {

    private static final Logger log = LoggerFactory.getLogger(AwsConfig.class);

    private final AwsProperties aws;

    public AwsConfig(AwsProperties aws) {
        this.aws = aws;
        log.info("AWS clients: region={}, endpoint={}, presign-endpoint={}, credentials={}",
                aws.getRegion(),
                aws.hasEndpoint() ? aws.getEndpoint() : "AWS",
                aws.hasEndpoint() ? aws.effectivePublicEndpoint() : "AWS",
                aws.hasEndpoint() ? "static (emulator)" : "default provider chain");
    }

    private AwsCredentialsProvider credentials() {
        if (aws.hasEndpoint()) {
            return StaticCredentialsProvider.create(AwsBasicCredentials.create(aws.getAccessKey(), aws.getSecretKey()));
        }
        return DefaultCredentialsProvider.builder().build();
    }

    private Region region() {
        return Region.of(aws.getRegion());
    }

    @Bean
    public DynamoDbClient dynamoDbClient() {
        var builder = DynamoDbClient.builder().region(region()).credentialsProvider(credentials());
        if (aws.hasEndpoint()) builder.endpointOverride(URI.create(aws.getEndpoint()));
        return builder.build();
    }

    @Bean
    public SqsClient sqsClient() {
        var builder = SqsClient.builder().region(region()).credentialsProvider(credentials());
        if (aws.hasEndpoint()) builder.endpointOverride(URI.create(aws.getEndpoint()));
        return builder.build();
    }

    @Bean
    public S3Client s3Client() {
        var builder = S3Client.builder().region(region()).credentialsProvider(credentials());
        if (aws.hasEndpoint()) {
            // Emulators serve buckets under a path, not as a virtual host.
            builder.endpointOverride(URI.create(aws.getEndpoint())).forcePathStyle(true);
        }
        return builder.build();
    }

    /**
     * Presigned URLs are opened by a browser, so they are signed for the public endpoint and, when an
     * emulator is used, in path style: {@code http://localhost:4566/bucket/key} resolves everywhere,
     * whereas {@code http://bucket.localstack:4566/key} does not resolve outside the Compose network.
     */
    @Bean
    public S3Presigner s3Presigner() {
        var builder = S3Presigner.builder().region(region()).credentialsProvider(credentials());
        if (aws.hasEndpoint()) {
            builder.endpointOverride(URI.create(aws.effectivePublicEndpoint()))
                    .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build());
        }
        return builder.build();
    }
}
