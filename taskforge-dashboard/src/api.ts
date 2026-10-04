// The console's client for the TaskForge API (ReportController). Requests go to /api/v1; a non-2xx
// answer becomes an ApiError carrying the error body (ErrorResponse) and the Retry-After hint;
// report bodies (ReportResponse) convert to the Job shape of src/sim/types.ts, so the console
// renders one shape for the service and the simulator.

import type { Job, ReportStatus, ReportType } from './sim/types.ts'

const API = '/api/v1'

/** ReportResponse as JSON: the Job fields the API exposes, with ISO-8601 timestamps. */
export type JobResponse = Pick<
  Job,
  | 'id'
  | 'type'
  | 'status'
  | 'parameters'
  | 'correlationId'
  | 'errorMessage'
  | 'attemptCount'
  | 'maxAttempts'
  | 'downloadUrl'
  | 'executionTimeMs'
> & {
  createdAt: string
  updatedAt: string
  completedAt: string | null
  nextAttemptAt: string | null
  deadLetteredAt: string | null
}

/** GET /api/v1/health. A DEGRADED answer is a 503, so it arrives as an ApiError instead. */
export interface HealthResponse {
  service: string
  timestamp: string
  status: 'UP' | 'DEGRADED'
  queueDepth: number | null
  deadLetterDepth: number | null
  detail?: string
}

/** The body of POST /api/v1/reports (CreateReportRequest); unknown fields are rejected with a 400. */
export interface CreateReportRequest {
  type: ReportType
  parameters?: Record<string, string>
  idempotencyKey?: string | null
}

/** ErrorResponse, the one error body of every 4xx and 5xx. */
export interface ErrorBody {
  timestamp?: string
  status?: number
  error?: string
  message?: string
  details?: string[]
  path?: string
  correlationId?: string | null
  /** Only on a 409 for a reused idempotency key. */
  existingReportId?: string
}

export interface ApiErrorOptions {
  retryAfterSeconds?: number | null
  details?: string[]
  correlationId?: string | null
  existingReportId?: string | null
}

/** A non-2xx response, carrying the API's error body and the Retry-After hint when present. */
export class ApiError extends Error {
  readonly status: number
  readonly retryAfterSeconds: number | null
  readonly details: string[]
  readonly correlationId: string | null
  readonly existingReportId: string | null

  constructor(status: number, message: string, options: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.details = options.details ?? []
    this.correlationId = options.correlationId ?? null
    this.existingReportId = options.existingReportId ?? null
  }
}

/**
 * Turns a fetch Response into data or an ApiError. Only `response.ok` responses are parsed as
 * data; a 429 or 5xx body must never reach the component state as if it were a report list.
 */
export async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  if (response.ok) {
    if (response.status === 204) return null
    return isJson ? response.json() : response.text()
  }
  let body: ErrorBody | null = null
  if (isJson) {
    try {
      body = (await response.json()) as ErrorBody | null
    } catch {
      body = null
    }
  }
  const retryAfter = response.headers.get('retry-after')
  const retryAfterSeconds =
    retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null
  throw new ApiError(response.status, body?.message || `HTTP ${response.status}`, {
    retryAfterSeconds,
    details: body?.details || [],
    correlationId: body?.correlationId || null,
    existingReportId: body?.existingReportId || null,
  })
}

/**
 * A request to the API, parsed by parseResponse. The caller's headers are merged over
 * Accept: application/json, so a POST that sets Content-Type keeps the Accept header.
 */
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  const response = await fetch(`${API}${path}`, { ...options, headers })
  return (await parseResponse(response)) as T
}

export const api = {
  listReports: (status?: ReportStatus | 'ALL' | null) =>
    request<JobResponse[]>(status && status !== 'ALL' ? `/reports?status=${status}` : '/reports'),
  getReport: (id: string) => request<JobResponse>(`/reports/${encodeURIComponent(id)}`),
  getHealth: () => request<HealthResponse>('/health'),
  submit: (data: CreateReportRequest) =>
    request<JobResponse>('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  /**
   * GET /reports/{id}/download answers 302 with the presigned S3 URL (404 once the file has
   * expired, 409 before the job is COMPLETED). It is a link for the browser to follow, not a
   * fetch: the redirect leaves the API's origin.
   */
  downloadUrl: (id: string) => `${API}/reports/${encodeURIComponent(id)}/download`,
}

/** Instant.toString prints up to nine fraction digits; Date.parse is specified for three. */
export function toMillis(instant: string): number {
  const millis = Date.parse(instant.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(millis)) throw new RangeError(`not an ISO-8601 instant: ${instant}`)
  return millis
}

function toMillisOrNull(instant: string | null): number | null {
  return instant === null ? null : toMillis(instant)
}

/**
 * A ReportResponse as a Job, with timestamps in epoch milliseconds. The API does not expose the
 * job's version, lock holder, file key or idempotency key: they read as 0 and null here.
 * Simulation times count from SIM_EPOCH_MS, so adding it puts both on one clock.
 */
export function toJob(response: JobResponse): Job {
  return {
    id: response.id,
    type: response.type,
    status: response.status,
    parameters: { ...response.parameters },
    correlationId: response.correlationId,
    idempotencyKey: null,
    errorMessage: response.errorMessage,
    attemptCount: response.attemptCount,
    maxAttempts: response.maxAttempts,
    version: 0,
    lockedBy: null,
    fileKey: null,
    downloadUrl: response.downloadUrl,
    createdAt: toMillis(response.createdAt),
    updatedAt: toMillis(response.updatedAt),
    completedAt: toMillisOrNull(response.completedAt),
    nextAttemptAt: toMillisOrNull(response.nextAttemptAt),
    deadLetteredAt: toMillisOrNull(response.deadLetteredAt),
    executionTimeMs: response.executionTimeMs,
  }
}

/** The dashboard's polling state: the last report list and health, and why a refresh failed. */
export interface PollState<R, H> {
  reports: R[]
  health: H
  error: string | null
  pausedUntil: number | null
}

/** Any thrown error; an ApiError also carries the status and Retry-After. */
export type PollError = Pick<Error, 'message'> & {
  status?: number
  retryAfterSeconds?: number | null
}

export type PollUpdate<R, H> =
  | { reports: R[]; health: H; error?: undefined; now?: number }
  | { error: PollError; health?: H; reports?: undefined; now?: number }

/**
 * Applies a poll result to the previous state. On failure the previous list is kept so the page
 * never blanks; a 429 pauses polling for the Retry-After period.
 */
export function applyPoll<S extends PollState<unknown, unknown>>(
  previous: S,
  update: PollUpdate<S['reports'][number], S['health']>
): S {
  if (update.error) {
    const now = update.now ?? Date.now()
    const { error, health } = update
    const pausedUntil =
      error.status === 429 ? now + (error.retryAfterSeconds || 5) * 1000 : previous.pausedUntil
    return {
      ...previous,
      health: health === undefined ? previous.health : health,
      error: error.message,
      pausedUntil,
    }
  }
  return {
    ...previous,
    reports: update.reports,
    health: update.health,
    error: null,
    pausedUntil: null,
  }
}
