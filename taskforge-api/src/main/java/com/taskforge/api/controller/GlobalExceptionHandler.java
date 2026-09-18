package com.taskforge.api.controller;

import com.taskforge.common.correlation.CorrelationId;
import com.taskforge.common.dto.ErrorResponse;
import com.taskforge.common.exception.DuplicateReportException;
import com.taskforge.common.exception.InvalidReportParametersException;
import com.taskforge.common.exception.QueueUnavailableException;
import com.taskforge.common.exception.ReportNotFoundException;
import com.taskforge.common.exception.ReportNotReadyException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import tools.jackson.core.JacksonException;
import tools.jackson.core.TokenStreamLocation;
import tools.jackson.databind.DatabindException;
import tools.jackson.databind.exc.InvalidFormatException;
import tools.jackson.databind.exc.UnrecognizedPropertyException;

import java.net.URI;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Maps every failure to the {@link ErrorResponse} body with the right status code. Client mistakes
 * are 4xx with a message that says what to fix; only genuinely unexpected errors are 500, and those
 * never expose internal details beyond the correlation id to search the logs with.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private static final Pattern FIELD_IN_PATH = Pattern.compile("\\[\"([^\"]+)\"\\]");

    private final Clock clock;

    public GlobalExceptionHandler(Clock clock) {
        this.clock = clock;
    }

    // ---- 4xx from the domain -----------------------------------------------------------------

    @ExceptionHandler(ReportNotFoundException.class)
    public ResponseEntity<ErrorResponse> notFound(ReportNotFoundException ex, HttpServletRequest req) {
        return respond(HttpStatus.NOT_FOUND, ex.getMessage(), List.of(), req, null);
    }

    @ExceptionHandler(ReportNotReadyException.class)
    public ResponseEntity<ErrorResponse> notReady(ReportNotReadyException ex, HttpServletRequest req) {
        return respond(HttpStatus.CONFLICT, ex.getMessage(), List.of(), req, null);
    }

    @ExceptionHandler(DuplicateReportException.class)
    public ResponseEntity<ErrorResponse> duplicate(DuplicateReportException ex, HttpServletRequest req) {
        ResponseEntity<ErrorResponse> response = respond(HttpStatus.CONFLICT,
                "A report with idempotency key '" + ex.getIdempotencyKey() + "' already exists",
                List.of("existing report: " + ex.getExistingId()), req, ex.getExistingId());
        if (ex.getExistingId() == null) {
            return response;
        }
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .location(URI.create("/api/v1/reports/" + ex.getExistingId()))
                .body(response.getBody());
    }

    @ExceptionHandler(InvalidReportParametersException.class)
    public ResponseEntity<ErrorResponse> invalidParameters(InvalidReportParametersException ex, HttpServletRequest req) {
        return respond(HttpStatus.BAD_REQUEST, "Invalid report parameters", ex.getProblems(), req, null);
    }

    // ---- 4xx from validation and binding ------------------------------------------------------

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> bodyValidation(MethodArgumentNotValidException ex, HttpServletRequest req) {
        List<String> details = new ArrayList<>();
        for (FieldError e : ex.getBindingResult().getFieldErrors()) {
            details.add(e.getField() + ": " + e.getDefaultMessage());
        }
        ex.getBindingResult().getGlobalErrors().forEach(e -> details.add(e.getDefaultMessage()));
        return respond(HttpStatus.BAD_REQUEST, "Request validation failed", details, req, null);
    }

    @ExceptionHandler(HandlerMethodValidationException.class)
    public ResponseEntity<ErrorResponse> parameterValidation(HandlerMethodValidationException ex, HttpServletRequest req) {
        List<String> details = new ArrayList<>();
        ex.getParameterValidationResults().forEach(result -> result.getResolvableErrors()
                .forEach(error -> details.add(result.getMethodParameter().getParameterName() + ": " + error.getDefaultMessage())));
        return respond(HttpStatus.BAD_REQUEST, "Request validation failed", details, req, null);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ErrorResponse> constraintViolation(ConstraintViolationException ex, HttpServletRequest req) {
        List<String> details = ex.getConstraintViolations().stream()
                .map(v -> v.getPropertyPath() + ": " + v.getMessage()).sorted().toList();
        return respond(HttpStatus.BAD_REQUEST, "Request validation failed", details, req, null);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> unreadableBody(HttpMessageNotReadableException ex, HttpServletRequest req) {
        return respond(HttpStatus.BAD_REQUEST, "Malformed request body", List.of(describeJsonProblem(ex)), req, null);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ErrorResponse> typeMismatch(MethodArgumentTypeMismatchException ex, HttpServletRequest req) {
        String detail = "invalid value '" + ex.getValue() + "' for parameter '" + ex.getName() + "'";
        Class<?> required = ex.getRequiredType();
        if (required != null && required.isEnum()) {
            detail += "; allowed: " + Arrays.toString(required.getEnumConstants());
        } else if (required != null) {
            detail += "; expected " + required.getSimpleName();
        }
        return respond(HttpStatus.BAD_REQUEST, "Invalid request parameter", List.of(detail), req, null);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<ErrorResponse> missingParameter(MissingServletRequestParameterException ex, HttpServletRequest req) {
        return respond(HttpStatus.BAD_REQUEST, "Missing request parameter",
                List.of("parameter '" + ex.getParameterName() + "' is required"), req, null);
    }

    // ---- 4xx from routing --------------------------------------------------------------------

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ErrorResponse> methodNotAllowed(HttpRequestMethodNotSupportedException ex, HttpServletRequest req) {
        ResponseEntity<ErrorResponse> response = respond(HttpStatus.METHOD_NOT_ALLOWED,
                "Method " + ex.getMethod() + " is not supported for this resource", List.of(), req, null);
        HttpHeaders headers = new HttpHeaders();
        if (ex.getSupportedHttpMethods() != null) {
            headers.setAllow(ex.getSupportedHttpMethods());
        }
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).headers(headers).body(response.getBody());
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ErrorResponse> unsupportedMediaType(HttpMediaTypeNotSupportedException ex, HttpServletRequest req) {
        return respond(HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "Content type " + ex.getContentType() + " is not supported; send application/json", List.of(), req, null);
    }

    @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
    public ResponseEntity<ErrorResponse> notAcceptable(HttpMediaTypeNotAcceptableException ex, HttpServletRequest req) {
        return respond(HttpStatus.NOT_ACCEPTABLE, "This resource produces application/json", List.of(), req, null);
    }

    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public ResponseEntity<ErrorResponse> noRoute(Exception ex, HttpServletRequest req) {
        return respond(HttpStatus.NOT_FOUND, "No resource at " + req.getRequestURI(), List.of(), req, null);
    }

    // ---- 5xx ---------------------------------------------------------------------------------

    @ExceptionHandler(QueueUnavailableException.class)
    public ResponseEntity<ErrorResponse> queueUnavailable(QueueUnavailableException ex, HttpServletRequest req) {
        log.error("Queue unavailable: {}", ex.getMessage(), ex);
        ResponseEntity<ErrorResponse> response = respond(HttpStatus.SERVICE_UNAVAILABLE,
                "The job queue is unavailable; the request was not accepted. Retry with the same idempotency key.",
                List.of(), req, null);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header(HttpHeaders.RETRY_AFTER, "5")
                .body(response.getBody());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> unexpected(Exception ex, HttpServletRequest req) {
        log.error("Unhandled error on {} {}", req.getMethod(), req.getRequestURI(), ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR,
                "An unexpected error occurred; quote the correlation id when reporting it", List.of(), req, null);
    }

    // ---- helpers -----------------------------------------------------------------------------

    private ResponseEntity<ErrorResponse> respond(HttpStatus status, String message, List<String> details,
                                                  HttpServletRequest req, String existingReportId) {
        ErrorResponse body = new ErrorResponse(clock.instant(), status.value(), status.getReasonPhrase(), message,
                details, req.getRequestURI(), CorrelationId.current(), existingReportId);
        return ResponseEntity.status(status).body(body);
    }

    /** Turns a Jackson failure into one sentence a client can act on, without echoing internal class names. */
    static String describeJsonProblem(HttpMessageNotReadableException ex) {
        Throwable cause = ex.getCause();
        while (cause != null) {
            if (cause instanceof UnrecognizedPropertyException upe) {
                return "unknown field '" + upe.getPropertyName() + "'";
            }
            if (cause instanceof InvalidFormatException ife) {
                String detail = "invalid value '" + ife.getValue() + "' for field '" + fieldOf(ife) + "'";
                Class<?> target = ife.getTargetType();
                if (target != null && target.isEnum()) {
                    detail += "; allowed: " + Arrays.toString(target.getEnumConstants());
                }
                return detail;
            }
            if (cause instanceof DatabindException de) {
                String field = fieldOf(de);
                return field.isEmpty() ? "request body does not match the expected structure"
                        : "field '" + field + "' has the wrong type or structure";
            }
            if (cause instanceof JacksonException je) {
                TokenStreamLocation location = je.getLocation();
                return location == null ? "malformed JSON"
                        : "malformed JSON at line " + location.getLineNr() + ", column " + location.getColumnNr();
            }
            cause = cause.getCause();
        }
        String message = ex.getMessage();
        if (message != null && message.startsWith("Required request body is missing")) {
            return "request body is required";
        }
        return "request body could not be read";
    }

    private static String fieldOf(DatabindException ex) {
        String path = ex.getPathReference();
        if (path == null) return "";
        List<String> fields = new ArrayList<>();
        Matcher m = FIELD_IN_PATH.matcher(path);
        while (m.find()) {
            fields.add(m.group(1));
        }
        return String.join(".", fields);
    }
}
