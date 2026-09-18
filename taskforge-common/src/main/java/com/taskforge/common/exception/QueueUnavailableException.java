package com.taskforge.common.exception;

/** SQS refused or failed a request. On submission this maps to HTTP 503 so the client retries later. */
public class QueueUnavailableException extends RuntimeException {

    public QueueUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
