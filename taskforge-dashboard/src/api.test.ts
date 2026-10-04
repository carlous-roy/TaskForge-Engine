// Tests for api.ts: response parsing, the poll state, the request helpers, the download link and
// the ReportResponse to Job conversion.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  ApiError,
  applyPoll,
  parseResponse,
  request,
  toJob,
  toMillis,
  type HealthResponse,
  type JobResponse,
  type PollState,
} from './api.ts'

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Replaces fetch with one that answers `answer` and records what it was asked. */
function stubFetch(answer: () => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer()
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseResponse', () => {
  it('returns the body of a successful response', async () => {
    await expect(parseResponse(response(200, [{ id: 'a' }]))).resolves.toEqual([{ id: 'a' }])
  })

  it('turns a 429 into an ApiError carrying Retry-After instead of data', async () => {
    const r = response(
      429,
      { message: 'Rate limit exceeded', correlationId: 'abc' },
      { 'retry-after': '17' }
    )
    const error = await parseResponse(r).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(429)
    expect(apiError.retryAfterSeconds).toBe(17)
    expect(apiError.message).toBe('Rate limit exceeded')
    expect(apiError.correlationId).toBe('abc')
  })

  it('copes with error responses that are not JSON', async () => {
    const r = new Response('<html>bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })
    const error = (await parseResponse(r).catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(502)
    expect(error.message).toBe('HTTP 502')
    expect(error.retryAfterSeconds).toBeNull()
  })

  it('keeps the existing report id and details of a 409', async () => {
    const r = response(409, {
      status: 409,
      message: "A report with idempotency key 'k' already exists",
      details: ['existing report: 1f'],
      existingReportId: '1f',
    })
    const error = (await parseResponse(r).catch((e: unknown) => e)) as ApiError
    expect(error.existingReportId).toBe('1f')
    expect(error.details).toEqual(['existing report: 1f'])
  })

  it('answers 204 with null and a non-JSON body as text', async () => {
    await expect(parseResponse(new Response(null, { status: 204 }))).resolves.toBeNull()
    const text = new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    await expect(parseResponse(text)).resolves.toBe('ok')
  })
})

describe('request and api', () => {
  it('prefixes /api/v1 and asks for JSON', async () => {
    const calls = stubFetch(() => response(200, []))
    await request('/reports')
    expect(calls[0]?.url).toBe('/api/v1/reports')
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('application/json')
  })

  it('keeps Accept next to the headers a call adds', async () => {
    const calls = stubFetch(() => response(202, { id: 'x' }))
    await api.submit({
      type: 'SALES_SUMMARY',
      parameters: { region: 'North' },
      idempotencyKey: 'k-1',
    })
    const init = calls[0]?.init
    const headers = new Headers(init?.headers)
    expect(calls[0]?.url).toBe('/api/v1/reports')
    expect(init?.method).toBe('POST')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'SALES_SUMMARY',
      parameters: { region: 'North' },
      idempotencyKey: 'k-1',
    })
  })

  it('filters the list by status except for ALL', async () => {
    const calls = stubFetch(() => response(200, []))
    await api.listReports('FAILED')
    await api.listReports('ALL')
    await api.listReports()
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/reports?status=FAILED',
      '/api/v1/reports',
      '/api/v1/reports',
    ])
  })

  it('reads one report and the health endpoint', async () => {
    const health: HealthResponse = {
      service: 'taskforge-api',
      timestamp: '2026-09-18T12:00:00Z',
      status: 'UP',
      queueDepth: 2,
      deadLetterDepth: 0,
    }
    const calls = stubFetch(() => response(200, health))
    await expect(api.getHealth()).resolves.toEqual(health)
    await api.getReport('3f1c9a2e-0000-4000-8000-000000000000')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/health',
      '/api/v1/reports/3f1c9a2e-0000-4000-8000-000000000000',
    ])
  })

  it('links the download route, which redirects to the presigned URL', () => {
    expect(api.downloadUrl('3f1c9a2e-0000-4000-8000-000000000000')).toBe(
      '/api/v1/reports/3f1c9a2e-0000-4000-8000-000000000000/download'
    )
    expect(api.downloadUrl('../health')).toBe('/api/v1/reports/..%2Fhealth/download')
  })
})

describe('toJob', () => {
  const body: JobResponse = {
    id: '3f1c9a2e-0000-4000-8000-000000000000',
    type: 'SALES_SUMMARY',
    status: 'COMPLETED',
    parameters: { region: 'North' },
    correlationId: 'client-req-7',
    errorMessage: null,
    attemptCount: 1,
    maxAttempts: 3,
    downloadUrl: 'http://localhost:4566/taskforge-reports/reports/x.csv?sig',
    createdAt: '2026-09-18T12:00:00Z',
    updatedAt: '2026-09-18T12:00:01.250Z',
    completedAt: '2026-09-18T12:00:01.250123456Z',
    nextAttemptAt: null,
    deadLetteredAt: null,
    executionTimeMs: 1250,
  }

  it('gives the console the Job shape with epoch milliseconds', () => {
    const job = toJob(body)
    expect(job).toMatchObject({
      id: body.id,
      status: 'COMPLETED',
      parameters: { region: 'North' },
      downloadUrl: body.downloadUrl,
      createdAt: Date.UTC(2026, 8, 18, 12, 0, 0),
      updatedAt: Date.UTC(2026, 8, 18, 12, 0, 1, 250),
      completedAt: Date.UTC(2026, 8, 18, 12, 0, 1, 250),
      nextAttemptAt: null,
      executionTimeMs: 1250,
    })
    expect(job).toMatchObject({ version: 0, lockedBy: null, fileKey: null, idempotencyKey: null })
  })

  it('reads Instant.toString at every precision and refuses anything else', () => {
    expect(toMillis('2026-09-18T12:00:00.123456Z')).toBe(Date.UTC(2026, 8, 18, 12, 0, 0, 123))
    expect(toMillis('2026-09-18T12:00:00.1Z')).toBe(Date.UTC(2026, 8, 18, 12, 0, 0, 100))
    expect(() => toMillis('yesterday')).toThrow(RangeError)
  })
})

describe('applyPoll', () => {
  type Report = { id: string }
  type Health = { status: string; queueDepth?: number }
  const previous: PollState<Report, Health | null> = {
    reports: [{ id: 'kept' }],
    health: { status: 'UP' },
    error: null,
    pausedUntil: null,
  }

  it('replaces the list and clears errors on success', () => {
    const next = applyPoll(previous, {
      reports: [{ id: 'new' }],
      health: { status: 'UP', queueDepth: 1 },
    })
    expect(next.reports).toEqual([{ id: 'new' }])
    expect(next.error).toBeNull()
    expect(next.pausedUntil).toBeNull()
  })

  it('keeps the previous list when the refresh fails', () => {
    const next = applyPoll(previous, { error: new ApiError(500, 'boom'), now: 1000 })
    expect(next.reports).toEqual([{ id: 'kept' }])
    expect(next.error).toBe('boom')
    expect(next.pausedUntil).toBeNull()
  })

  it('pauses polling for Retry-After seconds on a 429', () => {
    const next = applyPoll(previous, {
      error: new ApiError(429, 'slow down', { retryAfterSeconds: 30 }),
      now: 1000,
    })
    expect(next.reports).toEqual([{ id: 'kept' }])
    expect(next.pausedUntil).toBe(31000)
  })

  it('never stores a non-array as the report list', () => {
    const next = applyPoll(previous, { error: new ApiError(429, 'x'), now: 0 })
    expect(Array.isArray(next.reports)).toBe(true)
    expect(next.pausedUntil).toBe(5000)
  })

  it('takes the health that came with a failed refresh, and plain errors too', () => {
    const next = applyPoll(previous, {
      error: new TypeError('Failed to fetch'),
      health: { status: 'UNREACHABLE' },
      now: 0,
    })
    expect(next.health).toEqual({ status: 'UNREACHABLE' })
    expect(next.error).toBe('Failed to fetch')
  })
})
