package com.taskforge.worker.service;

import com.taskforge.common.exception.InvalidReportParametersException;
import com.taskforge.common.exception.ReportGenerationException;
import com.taskforge.worker.service.FailureClassifier.Kind;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.BadSqlGrammarException;
import software.amazon.awssdk.core.exception.AbortedException;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.sql.SQLException;
import java.time.format.DateTimeParseException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class FailureClassifierTest {

    @AfterEach
    void clearInterrupt() {
        Thread.interrupted();
    }

    @Test
    void badInputIsPermanent() {
        assertThat(FailureClassifier.classify(new InvalidReportParametersException(List.of("x")))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(new NumberFormatException("abc"))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(new DateTimeParseException("bad", "x", 0))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(new ReportGenerationException("no generator", false))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(new BadSqlGrammarException("q", "SELECT", new SQLException("syntax")))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(S3Exception.builder().statusCode(403).message("denied").build())).isEqualTo(Kind.PERMANENT);
    }

    @Test
    void transientProblemsAreRetried() {
        assertThat(FailureClassifier.classify(new ReportGenerationException("timeout", true))).isEqualTo(Kind.TRANSIENT);
        assertThat(FailureClassifier.classify(new QueryTimeoutException("slow"))).isEqualTo(Kind.TRANSIENT);
        assertThat(FailureClassifier.classify(new DataAccessResourceFailureException("db gone"))).isEqualTo(Kind.TRANSIENT);
        assertThat(FailureClassifier.classify(S3Exception.builder().statusCode(503).message("slow down").build())).isEqualTo(Kind.TRANSIENT);
        assertThat(FailureClassifier.classify(SdkClientException.create("connection reset"))).isEqualTo(Kind.TRANSIENT);
        assertThat(FailureClassifier.classify(new RuntimeException("unknown"))).isEqualTo(Kind.TRANSIENT);
    }

    @Test
    void wrappedCausesAreInspected() {
        assertThat(FailureClassifier.classify(new RuntimeException("wrapper", new NumberFormatException("x")))).isEqualTo(Kind.PERMANENT);
        assertThat(FailureClassifier.classify(new RuntimeException("wrapper", new InterruptedException()))).isEqualTo(Kind.INTERRUPTED);
    }

    @Test
    void interruptionWinsOverEverything() {
        assertThat(FailureClassifier.classify(AbortedException.builder().message("aborted").build())).isEqualTo(Kind.INTERRUPTED);
        Thread.currentThread().interrupt();
        assertThat(FailureClassifier.classify(new NumberFormatException("x"))).isEqualTo(Kind.INTERRUPTED);
    }
}
