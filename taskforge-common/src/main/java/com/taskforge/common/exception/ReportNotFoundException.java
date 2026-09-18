package com.taskforge.common.exception;

/** The job id is unknown, or the generated file is no longer in S3. Maps to HTTP 404. */
public class ReportNotFoundException extends RuntimeException {

    private final String reportId;

    public ReportNotFoundException(String reportId) {
        this(reportId, "Report not found: " + reportId);
    }

    private ReportNotFoundException(String reportId, String message) {
        super(message);
        this.reportId = reportId;
    }

    public static ReportNotFoundException fileMissing(String reportId) {
        return new ReportNotFoundException(reportId, "The file for report " + reportId + " has expired or been deleted");
    }

    public String getReportId() { return reportId; }
}
