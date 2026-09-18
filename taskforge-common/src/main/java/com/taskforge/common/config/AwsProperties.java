package com.taskforge.common.config;

import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Where the AWS clients connect.
 *
 * <p>With {@code endpoint} empty the SDK talks to AWS itself and finds credentials through its
 * default chain (environment, profile, instance or task role). With {@code endpoint} set, every
 * client is pointed at that URL (LocalStack, moto) and the static {@code access-key}/{@code secret-key}
 * pair is used, because emulators require a credential but do not check it.
 */
@Validated
@ConfigurationProperties(prefix = "aws")
public class AwsProperties {

    @NotBlank private String region = "us-east-1";
    /** Emulator endpoint for every service client; empty for real AWS. */
    private String endpoint = "";
    /**
     * Endpoint written into presigned URLs. Under Docker Compose the API reaches the emulator as
     * {@code http://localstack:4566} while a browser reaches it as {@code http://localhost:4566};
     * this setting lets a download link work from the browser. Empty means same as {@code endpoint}.
     */
    private String publicEndpoint = "";
    private String accessKey = "test";
    private String secretKey = "test";

    public boolean hasEndpoint() { return endpoint != null && !endpoint.isBlank(); }

    public String effectivePublicEndpoint() {
        return (publicEndpoint != null && !publicEndpoint.isBlank()) ? publicEndpoint : endpoint;
    }

    public String getRegion() { return region; }
    public void setRegion(String region) { this.region = region; }
    public String getEndpoint() { return endpoint; }
    public void setEndpoint(String endpoint) { this.endpoint = endpoint; }
    public String getPublicEndpoint() { return publicEndpoint; }
    public void setPublicEndpoint(String publicEndpoint) { this.publicEndpoint = publicEndpoint; }
    public String getAccessKey() { return accessKey; }
    public void setAccessKey(String accessKey) { this.accessKey = accessKey; }
    public String getSecretKey() { return secretKey; }
    public void setSecretKey(String secretKey) { this.secretKey = secretKey; }
}
