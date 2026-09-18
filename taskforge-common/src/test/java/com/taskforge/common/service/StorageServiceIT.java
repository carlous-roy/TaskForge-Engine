package com.taskforge.common.service;

import com.taskforge.common.EmulatorSupport;
import com.taskforge.common.config.AwsConfig;
import com.taskforge.common.config.AwsProperties;
import com.taskforge.common.config.TaskForgeProperties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.GetBucketLifecycleConfigurationRequest;
import software.amazon.awssdk.services.s3.model.GetObjectTaggingRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.Tag;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/** Runs against LocalStack (Testcontainers) or the emulator named by AWS_ENDPOINT_OVERRIDE. */
class StorageServiceIT {

    private static StorageService storage;
    private static S3Client s3;
    private static TaskForgeProperties properties;
    private static AwsProperties aws;

    @BeforeAll
    static void createBucket() {
        properties = EmulatorSupport.uniqueProperties("storage-it");
        aws = EmulatorSupport.awsProperties();
        // The presigner signs for the public endpoint; here it is the emulator itself.
        aws.setPublicEndpoint(aws.getEndpoint());
        AwsConfig config = new AwsConfig(aws);
        s3 = config.s3Client();
        storage = new StorageService(s3, config.s3Presigner(), properties, aws);
        storage.init();
        storage.init();
    }

    @Test
    void uploadsWithCorrelationTagAndMetadata() {
        String key = "reports/sales_summary/it-" + System.nanoTime() + ".csv";
        storage.upload(key, "a,b\r\n1,2\r\n".getBytes(StandardCharsets.UTF_8), "text/csv", "cid-777");

        assertThat(storage.exists(key)).isTrue();
        assertThat(storage.exists(key + ".missing")).isFalse();
        var tags = s3.getObjectTagging(GetObjectTaggingRequest.builder().bucket(properties.getS3().getBucket()).key(key).build()).tagSet();
        assertThat(tags).extracting(Tag::key, Tag::value).containsExactly(org.assertj.core.groups.Tuple.tuple("correlation-id", "cid-777"));
        var head = s3.headObject(HeadObjectRequest.builder().bucket(properties.getS3().getBucket()).key(key).build());
        assertThat(head.metadata()).containsEntry("correlation-id", "cid-777");
        assertThat(head.contentType()).isEqualTo("text/csv");
    }

    @Test
    void presignedUrlIsPathStyleOnThePublicEndpointAndDownloads() throws Exception {
        String key = "reports/user_activity/it-" + System.nanoTime() + ".csv";
        storage.upload(key, "x,y\r\n".getBytes(StandardCharsets.UTF_8), "text/csv", "cid-1");

        String url = storage.generateDownloadUrl(key);
        URI publicEndpoint = URI.create(aws.effectivePublicEndpoint());
        assertThat(URI.create(url).getHost()).isEqualTo(publicEndpoint.getHost());
        assertThat(URI.create(url).getPath()).startsWith("/" + properties.getS3().getBucket() + "/" + key);
        assertThat(url).contains("X-Amz-Expires=3600");

        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(HttpRequest.newBuilder(URI.create(url)).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEqualTo("x,y\r\n");
    }

    @Test
    void bucketExpiresObjectsAfterTheConfiguredDays() {
        var rules = s3.getBucketLifecycleConfiguration(GetBucketLifecycleConfigurationRequest.builder()
                .bucket(properties.getS3().getBucket()).build()).rules();
        assertThat(rules).hasSize(1);
        assertThat(rules.get(0).expiration().days()).isEqualTo(properties.getS3().getObjectExpiryDays());
    }
}
