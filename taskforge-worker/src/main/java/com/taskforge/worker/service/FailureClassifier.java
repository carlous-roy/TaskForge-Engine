package com.taskforge.worker.service;

import com.taskforge.common.exception.InvalidReportParametersException;
import com.taskforge.common.exception.ReportGenerationException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.NonTransientDataAccessException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.dao.RecoverableDataAccessException;
import org.springframework.dao.TransientDataAccessException;
import software.amazon.awssdk.core.exception.AbortedException;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.exception.SdkServiceException;
import tools.jackson.core.JacksonException;

import java.time.format.DateTimeParseException;

/**
 * Decides what a failed attempt means for the job.
 *
 * <ul>
 *   <li>{@link Kind#INTERRUPTED}: the worker is shutting down and interrupted the thread. The
 *       attempt is abandoned and the message handed straight back to SQS.</li>
 *   <li>{@link Kind#PERMANENT}: the same input will fail the same way every time (bad parameters,
 *       parse errors, a missing generator, an SQL error that is a bug, a 4xx from AWS). The job
 *       fails now; retrying would only burn attempts.</li>
 *   <li>{@link Kind#TRANSIENT}: anything that may pass on a later try (timeouts, throttling, 5xx,
 *       connection failures, unknown errors). The job is retried with backoff until the budget is
 *       spent.</li>
 * </ul>
 */
final class FailureClassifier {

    enum Kind { INTERRUPTED, PERMANENT, TRANSIENT }

    private FailureClassifier() {
    }

    static Kind classify(Throwable failure) {
        if (Thread.currentThread().isInterrupted()) {
            return Kind.INTERRUPTED;
        }
        for (Throwable t = failure; t != null; t = t.getCause()) {
            if (t instanceof InterruptedException || t instanceof AbortedException) {
                return Kind.INTERRUPTED;
            }
            if (t instanceof ReportGenerationException rge) {
                return rge.isRetryable() ? Kind.TRANSIENT : Kind.PERMANENT;
            }
            if (t instanceof InvalidReportParametersException
                    || t instanceof IllegalArgumentException
                    || t instanceof DateTimeParseException
                    || t instanceof JacksonException
                    || t instanceof ArithmeticException
                    || t instanceof NullPointerException
                    || t instanceof ClassCastException
                    || t instanceof UnsupportedOperationException) {
                return Kind.PERMANENT;
            }
            if (t instanceof TransientDataAccessException || t instanceof RecoverableDataAccessException
                    || t instanceof QueryTimeoutException || t instanceof DataAccessResourceFailureException) {
                // Spring files a lost connection under "non-transient"; for a job it is worth a retry.
                return Kind.TRANSIENT;
            }
            if (t instanceof NonTransientDataAccessException) {
                return Kind.PERMANENT;
            }
            if (t instanceof SdkServiceException sse) {
                boolean retryable = sse.isThrottlingException() || sse.statusCode() >= 500 || sse.statusCode() == 408;
                return retryable ? Kind.TRANSIENT : Kind.PERMANENT;
            }
            if (t instanceof SdkClientException) {
                return Kind.TRANSIENT;
            }
        }
        return Kind.TRANSIENT;
    }
}
