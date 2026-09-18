package com.taskforge.common.exception;

import java.util.List;

/**
 * The parameters of a report request do not fit its type. Raised at submission (HTTP 400) and, as a
 * belt-and-braces check, by the worker, where it is a non-retryable failure.
 */
public class InvalidReportParametersException extends RuntimeException {

    private final List<String> problems;

    public InvalidReportParametersException(List<String> problems) {
        super("Invalid report parameters: " + String.join("; ", problems));
        this.problems = List.copyOf(problems);
    }

    public List<String> getProblems() { return problems; }
}
