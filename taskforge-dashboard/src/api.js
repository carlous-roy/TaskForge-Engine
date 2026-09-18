const API = '/api/v1';

/** A non-2xx response, carrying the API's error body and the Retry-After hint when present. */
export class ApiError extends Error {
  constructor(status, message, { retryAfterSeconds = null, details = [], correlationId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
    this.correlationId = correlationId;
  }
}

/**
 * Turns a fetch Response into data or an ApiError. Only `response.ok` responses are parsed as data;
 * a 429 or 5xx body must never reach the component state as if it were a report list.
 */
export async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  if (response.ok) {
    if (response.status === 204) return null;
    return isJson ? response.json() : response.text();
  }
  let body = null;
  if (isJson) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  const retryAfter = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const message = (body && body.message) || `HTTP ${response.status}`;
  throw new ApiError(response.status, message, {
    retryAfterSeconds,
    details: (body && body.details) || [],
    correlationId: (body && body.correlationId) || null,
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return parseResponse(response);
}

export const api = {
  listReports: (status) => request(status && status !== 'ALL' ? `/reports?status=${status}` : '/reports'),
  getReport: (id) => request(`/reports/${id}`),
  getHealth: () => request('/health'),
  submit: (data) =>
    request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
};

/**
 * Applies a poll result to the previous state. On failure the previous list is kept so the page
 * never blanks; a 429 pauses polling for the Retry-After period.
 */
export function applyPoll(previous, { reports, health, error, now = Date.now() }) {
  if (error) {
    const pausedUntil = error.status === 429 ? now + (error.retryAfterSeconds || 5) * 1000 : previous.pausedUntil;
    return {
      ...previous,
      health: health === undefined ? previous.health : health,
      error: error.message,
      pausedUntil,
    };
  }
  return { ...previous, reports, health, error: null, pausedUntil: null };
}
