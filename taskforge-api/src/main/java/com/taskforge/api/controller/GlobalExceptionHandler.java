package com.taskforge.api.controller;

import com.taskforge.common.dto.ErrorResponse;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.ReportNotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ReportNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(ReportNotFoundException ex) {
        return respond(HttpStatus.NOT_FOUND, "Not Found", ex.getMessage());
    }

    @ExceptionHandler(DuplicateReportException.class)
    public ResponseEntity<ErrorResponse> handleDuplicate(DuplicateReportException ex) {
        return respond(HttpStatus.CONFLICT, "Conflict", ex.getMessage());
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ErrorResponse> handleBadState(IllegalStateException ex) {
        return respond(HttpStatus.BAD_REQUEST, "Bad Request", ex.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .reduce((a, b) -> a + "; " + b).orElse("Validation failed");
        return respond(HttpStatus.BAD_REQUEST, "Validation Error", msg);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex) {
        log.error("Unexpected error", ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "Internal Server Error",
                "An unexpected error occurred");
    }

    private ResponseEntity<ErrorResponse> respond(HttpStatus status, String error, String message) {
        return ResponseEntity.status(status).body(new ErrorResponse(status.value(), error, message, null));
    }
}
