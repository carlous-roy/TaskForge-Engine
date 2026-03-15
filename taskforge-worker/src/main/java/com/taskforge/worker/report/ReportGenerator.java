package com.taskforge.worker.report;

import com.taskforge.common.enums.ReportType;

import java.util.Map;

public interface ReportGenerator {

    ReportType getType();

    byte[] generate(Map<String, String> parameters, String correlationId);
}
