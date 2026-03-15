package com.taskforge.common.service;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;

import java.time.Duration;

@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    private final S3Client s3;
    private final S3Presigner presigner;

    @Value("${taskforge.s3.bucket:taskforge-reports}")
    private String bucketName;

    @Value("${taskforge.s3.download-expiry-minutes:60}")
    private int downloadExpiryMinutes;

    public StorageService(S3Client s3, S3Presigner presigner) {
        this.s3 = s3;
        this.presigner = presigner;
    }

    @PostConstruct
    public void init() {
        ensureBucketExists();
    }

    private void ensureBucketExists() {
        try {
            s3.headBucket(HeadBucketRequest.builder().bucket(bucketName).build());
            log.info("S3 bucket '{}' exists", bucketName);
        } catch (S3Exception e) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucketName).build());
            log.info("S3 bucket '{}' created", bucketName);
        }
    }

    public String upload(String key, byte[] content, String contentType) {
        s3.putObject(
                PutObjectRequest.builder()
                        .bucket(bucketName)
                        .key(key)
                        .contentType(contentType)
                        .build(),
                RequestBody.fromBytes(content));
        log.debug("Uploaded {} ({} bytes)", key, content.length);
        return key;
    }

    public String generateDownloadUrl(String key) {
        var presigned = presigner.presignGetObject(GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofMinutes(downloadExpiryMinutes))
                .getObjectRequest(GetObjectRequest.builder()
                        .bucket(bucketName).key(key).build())
                .build());
        return presigned.url().toString();
    }

    public boolean exists(String key) {
        try {
            s3.headObject(HeadObjectRequest.builder()
                    .bucket(bucketName).key(key).build());
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        }
    }
}
