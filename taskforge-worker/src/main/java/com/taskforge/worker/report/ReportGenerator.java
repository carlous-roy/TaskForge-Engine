package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;
import com.taskforge.common.report.ReportParameters;

/**
 * Produces one report type as CSV bytes.
 *
 * <p>Implementations throw {@code ReportGenerationException} to say whether a failure is worth
 * retrying; any other exception is classified by the worker (see {@code FailureClassifier}).
 */
public interface ReportGenerator {

    ReportType getType();

    byte[] generate(ReportParameters parameters);
}
