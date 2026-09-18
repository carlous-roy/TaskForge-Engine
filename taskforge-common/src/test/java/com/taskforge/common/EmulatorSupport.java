package com.taskforge.common;

import com.taskforge.common.config.AwsConfig;
import com.taskforge.common.config.AwsProperties;
import com.taskforge.common.config.TaskForgeProperties;
import com.taskforge.testsupport.AwsEmulator;

/**
 * Builds the production AWS clients ({@link AwsConfig}) against the test emulator, with resource
 * names unique to one test class so classes sharing the emulator stay isolated.
 */
public final class EmulatorSupport {

    private EmulatorSupport() {
    }

    public static AwsProperties awsProperties() {
        AwsEmulator emulator = AwsEmulator.get();
        AwsProperties aws = new AwsProperties();
        aws.setRegion(emulator.region());
        aws.setEndpoint(emulator.endpoint().toString());
        aws.setAccessKey(emulator.accessKey());
        aws.setSecretKey(emulator.secretKey());
        return aws;
    }

    public static AwsConfig awsConfig() {
        return new AwsConfig(awsProperties());
    }

    /** Properties with unique table, queue and bucket names for the calling test class. */
    public static TaskForgeProperties uniqueProperties(String prefix) {
        TaskForgeProperties props = new TaskForgeProperties();
        props.getDynamodb().setTable(AwsEmulator.uniqueName(prefix));
        props.getSqs().setQueue(AwsEmulator.uniqueName(prefix));
        props.getSqs().setDlq(AwsEmulator.uniqueName(prefix + "-dlq"));
        props.getS3().setBucket(AwsEmulator.uniqueName(prefix));
        return props;
    }
}
