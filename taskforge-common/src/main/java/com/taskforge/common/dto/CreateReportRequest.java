package com.taskforge.common.dto;

import com.taskforge.common.enums.ReportType;
import jakarta.validation.constraints.NotNull;

import java.util.Map;

public class CreateReportRequest {

    @NotNull(message = "Report type is required")
    private ReportType type;

    private Map<String, String> parameters;

    private String idempotencyKey;

    public ReportType getType() { return type; }
    public void setType(ReportType type) { this.type = type; }
    public Map<String, String> getParameters() { return parameters; }
    public void setParameters(Map<String, String> parameters) { this.parameters = parameters; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
}
