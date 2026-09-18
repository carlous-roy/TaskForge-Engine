package com.taskforge.common.dto;

import com.taskforge.common.enums.ReportType;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.Map;

/**
 * Body of {@code POST /api/v1/reports}.
 *
 * <p>Bean Validation covers shape and size; which parameter names and values a type accepts is
 * checked by {@code ReportParameters} in the service, so one error response can list every problem.
 */
public class CreateReportRequest {

    public static final int MAX_PARAMETERS = 10;
    public static final int MAX_IDEMPOTENCY_KEY_LENGTH = 128;

    @NotNull(message = "type is required")
    private ReportType type;

    @Size(max = MAX_PARAMETERS, message = "at most " + MAX_PARAMETERS + " parameters are allowed")
    private Map<String, String> parameters;

    @Size(min = 1, max = MAX_IDEMPOTENCY_KEY_LENGTH,
            message = "idempotencyKey must be between 1 and " + MAX_IDEMPOTENCY_KEY_LENGTH + " characters")
    @Pattern(regexp = "[A-Za-z0-9._:-]+", message = "idempotencyKey may contain letters, digits, '.', '_', ':' and '-'")
    private String idempotencyKey;

    public ReportType getType() { return type; }
    public void setType(ReportType type) { this.type = type; }
    public Map<String, String> getParameters() { return parameters; }
    public void setParameters(Map<String, String> parameters) { this.parameters = parameters; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
}
