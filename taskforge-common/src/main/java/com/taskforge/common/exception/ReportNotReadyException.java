package com.taskforge.common.exception;

import com.taskforge.common.enums.ReportStatus;

/** A download was requested for a job that has no file yet. Maps to HTTP 409. */
public class ReportNotReadyException extends RuntimeException {

    private final String reportId;
    private final ReportStatus status;

    public ReportNotReadyException(String reportId, ReportStatus status) {
        super("Report " + reportId + " is not ready for download (status: " + status + ")");
        this.reportId = reportId;
        this.status = status;
    }

    public String getReportId() { return reportId; }
    public ReportStatus getStatus() { return status; }
}
