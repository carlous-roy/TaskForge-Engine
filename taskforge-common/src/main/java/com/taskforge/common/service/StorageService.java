package com.taskforge.common.service;

import com.taskforge.common.config.AwsProperties;
import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.common.correlation.CorrelationId;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.BucketAlreadyExistsException;
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException;
import software.amazon.awssdk.services.s3.model.BucketLifecycleConfiguration;
import software.amazon.awssdk.services.s3.model.CreateBucketConfiguration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.ExpirationStatus;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.LifecycleExpiration;
import software.amazon.awssdk.services.s3.model.LifecycleRule;
import software.amazon.awssdk.services.s3.model.LifecycleRuleFilter;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.PublicAccessBlockConfiguration;
import software.amazon.awssdk.services.s3.model.PutBucketLifecycleConfigurationRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutPublicAccessBlockRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.model.Tag;
import software.amazon.awssdk.services.s3.model.Tagging;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;

import java.util.Map;

/**
 * Report files in one S3 bucket. Objects are tagged with the job's correlation id and expire through
 * a bucket lifecycle rule on the same schedule as the job records' DynamoDB TTL.
 */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    private final S3Client s3;
    private final S3Presigner presigner;
    private final TaskForgeProperties.S3 config;
    private final String region;

    public StorageService(S3Client s3, S3Presigner presigner, TaskForgeProperties properties, AwsProperties aws) {
        this.s3 = s3;
        this.presigner = presigner;
        this.config = properties.getS3();
        this.region = aws.getRegion();
    }

    @PostConstruct
    public void init() {
        ensureBucketExists();
    }

    private void ensureBucketExists() {
        String bucket = config.getBucket();
        try {
            s3.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
            log.info("S3 bucket '{}' exists", bucket);
        } catch (S3Exception e) {
            if (e.statusCode() != 404) {
                throw new IllegalStateException("Cannot access S3 bucket '" + bucket + "' (HTTP " + e.statusCode() + ")", e);
            }
            createBucket(bucket);
        }
        configureBucket(bucket);
    }

    private void createBucket(String bucket) {
        try {
            var request = CreateBucketRequest.builder().bucket(bucket);
            if (!"us-east-1".equals(region)) {
                request.createBucketConfiguration(CreateBucketConfiguration.builder().locationConstraint(region).build());
            }
            s3.createBucket(request.build());
            log.info("S3 bucket '{}' created", bucket);
        } catch (BucketAlreadyOwnedByYouException | BucketAlreadyExistsException e) {
            log.info("S3 bucket '{}' was created by another process", bucket);
        }
    }

    private void configureBucket(String bucket) {
        try {
            s3.putBucketLifecycleConfiguration(PutBucketLifecycleConfigurationRequest.builder()
                    .bucket(bucket)
                    .lifecycleConfiguration(BucketLifecycleConfiguration.builder()
                            .rules(LifecycleRule.builder()
                                    .id("expire-reports")
                                    .status(ExpirationStatus.ENABLED)
                                    .filter(LifecycleRuleFilter.builder().prefix("").build())
                                    .expiration(LifecycleExpiration.builder().days(config.getObjectExpiryDays()).build())
                                    .build())
                            .build())
                    .build());
            s3.putPublicAccessBlock(PutPublicAccessBlockRequest.builder()
                    .bucket(bucket)
                    .publicAccessBlockConfiguration(PublicAccessBlockConfiguration.builder()
                            .blockPublicAcls(true).ignorePublicAcls(true)
                            .blockPublicPolicy(true).restrictPublicBuckets(true).build())
                    .build());
            log.info("S3 bucket '{}': objects expire after {} day(s), public access blocked", bucket, config.getObjectExpiryDays());
        } catch (S3Exception e) {
            log.warn("Could not configure S3 bucket '{}': {}", bucket, e.getMessage());
        }
    }

    /** Uploads a report and tags it with the correlation id so the object can be traced back to its job. */
    public String upload(String key, byte[] content, String contentType, String correlationId) {
        s3.putObject(PutObjectRequest.builder()
                        .bucket(config.getBucket())
                        .key(key)
                        .contentType(contentType)
                        .metadata(Map.of(CorrelationId.S3_TAG, correlationId))
                        .tagging(Tagging.builder().tagSet(Tag.builder().key(CorrelationId.S3_TAG).value(correlationId).build()).build())
                        .build(),
                RequestBody.fromBytes(content));
        log.info("Uploaded s3://{}/{} ({} bytes)", config.getBucket(), key, content.length);
        return key;
    }

    public String generateDownloadUrl(String key) {
        var presigned = presigner.presignGetObject(GetObjectPresignRequest.builder()
                .signatureDuration(config.getDownloadExpiry())
                .getObjectRequest(GetObjectRequest.builder().bucket(config.getBucket()).key(key).build())
                .build());
        return presigned.url().toString();
    }

    public boolean exists(String key) {
        try {
            s3.headObject(HeadObjectRequest.builder().bucket(config.getBucket()).key(key).build());
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        } catch (S3Exception e) {
            if (e.statusCode() == 404) return false;
            throw e;
        }
    }
}
