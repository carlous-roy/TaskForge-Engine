package com.taskforge.testsupport;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;

import java.net.URI;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * The AWS emulator that integration tests run against.
 *
 * <p>Resolution order:
 * <ol>
 *   <li>{@code AWS_ENDPOINT_OVERRIDE} (environment) or {@code aws.endpoint.override} (system property):
 *       an emulator that is already running, for example {@code moto_server} on a machine without
 *       Docker. Credentials come from {@code AWS_ACCESS_KEY}/{@code AWS_SECRET_KEY} and default to
 *       {@code test}/{@code test}, the region from {@code AWS_REGION} and defaults to us-east-1.</li>
 *   <li>Otherwise a LocalStack container started through Testcontainers, once per JVM and shared by
 *       every test class in the module.</li>
 * </ol>
 *
 * <p>Tests that need isolated resources use {@link #uniqueName(String)} for table, queue and bucket
 * names so classes sharing one emulator do not see each other's data.
 */
public final class AwsEmulator {

    private static final Logger log = LoggerFactory.getLogger(AwsEmulator.class);

    /** localstack/localstack:2026.8.3, pinned by digest. */
    private static final DockerImageName LOCALSTACK_IMAGE = DockerImageName.parse(
            "localstack/localstack@sha256:4abc29e923e5ed8a63d6c705a9dfa74b15d560e7055845299d87b22dabf9f6e2");

    private static volatile AwsEmulator instance;

    private final URI endpoint;
    private final String accessKey;
    private final String secretKey;
    private final String region;
    private final String description;

    private AwsEmulator(URI endpoint, String accessKey, String secretKey, String region, String description) {
        this.endpoint = endpoint;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.region = region;
        this.description = description;
    }

    public static AwsEmulator get() {
        AwsEmulator local = instance;
        if (local == null) {
            synchronized (AwsEmulator.class) {
                local = instance;
                if (local == null) {
                    local = resolve();
                    instance = local;
                }
            }
        }
        return local;
    }

    private static AwsEmulator resolve() {
        String override = firstNonBlank(System.getenv("AWS_ENDPOINT_OVERRIDE"), System.getProperty("aws.endpoint.override"));
        if (override != null) {
            String accessKey = firstNonBlank(System.getenv("AWS_ACCESS_KEY"), "test");
            String secretKey = firstNonBlank(System.getenv("AWS_SECRET_KEY"), "test");
            String region = firstNonBlank(System.getenv("AWS_REGION"), "us-east-1");
            log.info("Integration tests use the emulator at {} (AWS_ENDPOINT_OVERRIDE)", override);
            return new AwsEmulator(URI.create(override), accessKey, secretKey, region, "endpoint override " + override);
        }
        try {
            LocalStackContainer container = new LocalStackContainer(LOCALSTACK_IMAGE);
            container.start();
            Runtime.getRuntime().addShutdownHook(new Thread(container::stop, "localstack-stop"));
            log.info("Integration tests use LocalStack at {}", container.getEndpoint());
            return new AwsEmulator(container.getEndpoint(), container.getAccessKey(), container.getSecretKey(),
                    container.getRegion(), "LocalStack container " + container.getContainerId());
        } catch (RuntimeException e) {
            throw new IllegalStateException("No AWS emulator available. Either run Docker so Testcontainers can start "
                    + "LocalStack, or set AWS_ENDPOINT_OVERRIDE to a running emulator such as moto_server "
                    + "(for example AWS_ENDPOINT_OVERRIDE=http://127.0.0.1:4566), or skip integration tests with -DskipITs.", e);
        }
    }

    public URI endpoint() { return endpoint; }
    public String accessKey() { return accessKey; }
    public String secretKey() { return secretKey; }
    public String region() { return region; }
    public Region sdkRegion() { return Region.of(region); }
    public String description() { return description; }

    public StaticCredentialsProvider credentials() {
        return StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey));
    }

    /**
     * Spring properties that point the application at this emulator. Callers add them to a
     * {@code DynamicPropertyRegistry} or pass them as {@code properties} of {@code @SpringBootTest}.
     */
    public Map<String, String> springProperties() {
        return Map.of(
                "aws.endpoint", endpoint.toString(),
                "aws.public-endpoint", endpoint.toString(),
                "aws.region", region,
                "aws.access-key", accessKey,
                "aws.secret-key", secretKey);
    }

    /** A lowercase name that is valid for DynamoDB tables, SQS queues and S3 buckets. */
    public static String uniqueName(String prefix) {
        return (prefix + "-" + UUID.randomUUID().toString().substring(0, 8)).toLowerCase(Locale.ROOT);
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) return v;
        }
        return null;
    }
}
