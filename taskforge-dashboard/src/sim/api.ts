// The API's handling of POST /api/v1/reports, in the order a request meets it: CorrelationIdFilter,
// RateLimitFilter, Jackson's binding and the Bean Validation of CreateReportRequest,
// ReportService.submit (ReportParameters, the idempotency transaction, the enqueue, the QUEUED
// write), and GlobalExceptionHandler's mapping of each failure to a status and a message.

import type { Clock } from './events.ts'
import { createJob, markQueued } from './job.ts'
import type { Log } from './log.ts'
import { InvalidReportParametersException, normalize } from './parameters.ts'
import type { Random } from './random.ts'
import { DuplicateReportException, StaleJobException, type ReportJobRepository } from './store.ts'
import { REPORT_TYPES, type Job, type SubmitRequest, type SubmitResult } from './types.ts'

/** CreateReportRequest.MAX_PARAMETERS and MAX_IDEMPOTENCY_KEY_LENGTH. */
export const MAX_PARAMETERS = 10
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128

const CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]+$/

/** CorrelationId.isValid: what is safe to accept from X-Correlation-ID and write into a log. */
export function isValidCorrelationId(candidate: string | null | undefined): candidate is string {
  return typeof candidate === 'string' && CORRELATION_ID.test(candidate)
}

/** CorrelationId.generate: twelve hexadecimal characters, 48 random bits. */
export function generateCorrelationId(random: Random): string {
  return random.hex(6)
}

/**
 * RateLimitFilter for the simulation's one client: a fixed one-minute window that opens with the
 * first request after the previous one expired. Every request is counted, refused ones included.
 */
export class RateLimitFilter {
  static readonly WINDOW_MS = 60_000
  readonly requestsPerMinute: number
  private window: { startedAt: number; count: number } | null = null
  private requests = 0

  constructor(requestsPerMinute: number) {
    this.requestsPerMinute = requestsPerMinute
  }

  get revision(): number {
    return this.requests
  }

  /** Counts a request; returns the Retry-After seconds when it is over the limit, null otherwise. */
  admit(now: number): number | null {
    if (this.window === null || now - this.window.startedAt >= RateLimitFilter.WINDOW_MS) {
      this.window = { startedAt: now, count: 0 }
    }
    const used = ++this.window.count
    this.requests++
    if (used <= this.requestsPerMinute) return null
    return Math.max(
      1,
      Math.floor((this.window.startedAt + RateLimitFilter.WINDOW_MS - now + 999) / 1000)
    )
  }

  /** The window the next request would be counted in; its count reads 0 once it has expired. */
  current(now: number): { startedAt: number; count: number } {
    if (this.window === null) return { startedAt: 0, count: 0 }
    const open = now - this.window.startedAt < RateLimitFilter.WINDOW_MS
    return { startedAt: this.window.startedAt, count: open ? this.window.count : 0 }
  }
}

/** What a submission needs from the rest of the system. */
export interface ApiContext {
  readonly clock: Clock
  readonly random: Random
  readonly repository: ReportJobRepository
  readonly rateLimit: RateLimitFilter
  readonly maxAttempts: number
  /** QueueService.enqueue. */
  readonly enqueue: (jobId: string, correlationId: string) => void
  /** The API process's logger. */
  readonly log: Log
}

type Rejection = { message: string; details: string[] }

/**
 * Jackson then Bean Validation. An unknown report type fails the binding of the whole body, so it
 * is reported alone, as "Malformed request body"; the constraints are checked together and listed
 * in declaration order (Hibernate Validator does not promise one).
 */
function checkBody(request: SubmitRequest): Rejection | null {
  const type: unknown = request.type
  if (type !== null && type !== undefined && !REPORT_TYPES.some((known) => known === type)) {
    return {
      message: 'Malformed request body',
      details: [
        `invalid value '${String(type)}' for field 'type'; allowed: [${REPORT_TYPES.join(', ')}]`,
      ],
    }
  }
  const details: string[] = []
  if (type === null || type === undefined) details.push('type: type is required')
  if (Object.keys(request.parameters ?? {}).length > MAX_PARAMETERS) {
    details.push(`parameters: at most ${MAX_PARAMETERS} parameters are allowed`)
  }
  const key = request.idempotencyKey
  if (key !== null && key !== undefined) {
    // An empty key fails both constraints, as it does in the Java; send null for "no key".
    if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      details.push(
        `idempotencyKey: idempotencyKey must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
      )
    }
    if (!IDEMPOTENCY_KEY.test(key)) {
      details.push(
        "idempotencyKey: idempotencyKey may contain letters, digits, '.', '_', ':' and '-'"
      )
    }
  }
  return details.length > 0 ? { message: 'Request validation failed', details } : null
}

/** POST /api/v1/reports, from the filters to the response. */
export function submitReport(ctx: ApiContext, request: SubmitRequest): SubmitResult {
  const now = ctx.clock.now
  const correlationId = isValidCorrelationId(request.correlationId)
    ? request.correlationId
    : generateCorrelationId(ctx.random)

  const retryAfterSeconds = ctx.rateLimit.admit(now)
  if (retryAfterSeconds !== null) {
    return {
      status: 429,
      message: `Rate limit exceeded: at most ${ctx.rateLimit.requestsPerMinute} requests per minute per client. Retry after ${retryAfterSeconds} second(s).`,
      retryAfterSeconds,
      correlationId,
    }
  }

  const rejected = checkBody(request)
  if (rejected !== null) return { status: 400, ...rejected, correlationId }

  try {
    return { status: 202, job: submit(ctx, request, correlationId, now) }
  } catch (error) {
    if (error instanceof InvalidReportParametersException) {
      return {
        status: 400,
        message: 'Invalid report parameters',
        details: [...error.problems],
        correlationId,
      }
    }
    if (error instanceof DuplicateReportException) {
      return {
        status: 409,
        message: `A report with idempotency key '${error.idempotencyKey}' already exists`,
        existingReportId: error.existingId,
        correlationId,
      }
    }
    throw error
  }
}

/**
 * ReportService.submit: validate, write ACCEPTED (with the key marker), send the message, then
 * write QUEUED. A worker that locks the job between the send and the QUEUED write wins; the
 * stored state is returned then. In the simulation the API's three writes happen in one instant,
 * before any worker event of that instant, so that branch is reached only when the enqueue itself
 * moves the job on (as a test can arrange).
 */
function submit(ctx: ApiContext, request: SubmitRequest, correlationId: string, now: number): Job {
  const parameters = normalize(request.type, request.parameters)
  const job = createJob(
    ctx.random.uuid(),
    request.type,
    parameters,
    correlationId,
    request.idempotencyKey ?? null,
    ctx.maxAttempts,
    now
  )
  ctx.repository.create(job)
  ctx.enqueue(job.id, correlationId)
  try {
    markQueued(job, ctx.clock.now)
    ctx.repository.update(job)
  } catch (error) {
    if (!(error instanceof StaleJobException)) throw error
    ctx.log('INFO', correlationId, `Job ${job.id} was picked up before it was marked QUEUED`)
    return ctx.repository.record(job.id) ?? Object.freeze(job)
  }
  ctx.log('INFO', correlationId, `Report submitted: ${job.type} ${job.id}`)
  return ctx.repository.record(job.id) ?? Object.freeze(job)
}
