// Tests for sim/api.ts, the API's handling of a submission: the correlation id, the rate limit,
// the request checks with the handler's messages, the idempotency conflict and the race with a
// worker that locks the job before the QUEUED write. Messages follow ReportControllerTest.

import { describe, expect, it } from 'vitest'
import { RateLimitFilter, submitReport, type ApiContext } from './api.ts'
import { EventLoop } from './events.ts'
import { markProcessing } from './job.ts'
import { Random } from './random.ts'
import { ReportJobRepository } from './store.ts'
import type { SubmitRequest, SubmitResult } from './types.ts'

function setup(options: { limit?: number; enqueue?: ApiContext['enqueue'] } = {}) {
  const loop = new EventLoop()
  const repository = new ReportJobRepository()
  const sent: string[] = []
  const lines: string[] = []
  const ctx: ApiContext = {
    clock: loop,
    random: new Random(8),
    repository,
    rateLimit: new RateLimitFilter(options.limit ?? 60),
    maxAttempts: 3,
    enqueue: options.enqueue ?? ((jobId) => sent.push(jobId)),
    log: (level, cid, message) => lines.push(`${level} [${cid}] ${message}`),
  }
  return { loop, repository, sent, lines, ctx }
}

const sales: SubmitRequest = { type: 'SALES_SUMMARY', parameters: { region: ' North ' } }

function rejected(result: SubmitResult) {
  if (result.status === 202) throw new Error(`expected a rejection, got 202 for ${result.job.id}`)
  return result
}

function badRequest(result: SubmitResult) {
  if (result.status !== 400) throw new Error(`expected 400, got ${result.status}`)
  return result
}

describe('submitReport', () => {
  it('writes ACCEPTED, enqueues, then writes QUEUED: version 0, then 1', () => {
    const seen: string[] = []
    const { ctx, repository, lines } = setup({
      enqueue: (jobId) => {
        const stored = repository.findById(jobId)
        seen.push(`${stored?.status} v${stored?.version}`)
      },
    })
    const result = submitReport(ctx, { ...sales, correlationId: 'client-req-7' })
    expect(seen).toEqual(['ACCEPTED v0'])
    if (result.status !== 202) throw new Error(`expected 202, got ${result.status}`)
    expect(result.job).toMatchObject({
      status: 'QUEUED',
      version: 1,
      correlationId: 'client-req-7',
      parameters: { region: 'North' },
      maxAttempts: 3,
    })
    expect(lines).toEqual([`INFO [client-req-7] Report submitted: SALES_SUMMARY ${result.job.id}`])
  })

  it('keeps a well-formed correlation id and replaces an unsafe or missing one', () => {
    const { ctx } = setup()
    const generated = /^[0-9a-f]{12}$/
    for (const supplied of ['has spaces and "quotes"', 'a'.repeat(65), '', null, undefined]) {
      const result = submitReport(ctx, { ...sales, correlationId: supplied })
      if (result.status !== 202) throw new Error(`expected 202, got ${result.status}`)
      expect(result.job.correlationId).toMatch(generated)
    }
    const kept = submitReport(ctx, { ...sales, correlationId: 'a'.repeat(64) })
    expect(kept.status === 202 && kept.job.correlationId).toBe('a'.repeat(64))
  })

  it('counts every request in a fixed window and computes Retry-After as RateLimitFilter does', () => {
    const { ctx, loop } = setup({ limit: 1 })
    expect(submitReport(ctx, sales).status).toBe(202)
    loop.runUntil(45_500)
    const limited = rejected(submitReport(ctx, { ...sales, correlationId: 'over' }))
    expect(limited).toEqual({
      status: 429,
      message:
        'Rate limit exceeded: at most 1 requests per minute per client. Retry after 15 second(s).',
      retryAfterSeconds: 15,
      correlationId: 'over',
    })
    expect(ctx.rateLimit.current(loop.now)).toEqual({ startedAt: 0, count: 2 })
    loop.runUntil(60_000)
    expect(ctx.rateLimit.current(loop.now)).toEqual({ startedAt: 0, count: 0 })
    expect(submitReport(ctx, sales).status).toBe(202)
    expect(ctx.rateLimit.current(loop.now)).toEqual({ startedAt: 60_000, count: 1 })
  })

  it('limits before it reads the body', () => {
    const { ctx } = setup({ limit: 1 })
    submitReport(ctx, sales)
    const bogus = { type: 'BOGUS', parameters: {} } as unknown as SubmitRequest
    expect(submitReport(ctx, bogus).status).toBe(429)
  })

  it('rejects an unknown type as a malformed body, before any other check', () => {
    const { ctx } = setup()
    const bogus = {
      type: 'BOGUS',
      parameters: { x: '1' },
      idempotencyKey: '',
    } as unknown as SubmitRequest
    expect(rejected(submitReport(ctx, bogus))).toMatchObject({
      status: 400,
      message: 'Malformed request body',
      details: [
        "invalid value 'BOGUS' for field 'type'; allowed: [SALES_SUMMARY, INVENTORY_SNAPSHOT, USER_ACTIVITY]",
      ],
    })
  })

  it('lists the request constraints that fail', () => {
    const { ctx, sent } = setup()
    const missingType = { parameters: {} } as unknown as SubmitRequest
    expect(rejected(submitReport(ctx, missingType))).toMatchObject({
      status: 400,
      message: 'Request validation failed',
      details: ['type: type is required'],
    })
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, 'v']))
    expect(
      badRequest(submitReport(ctx, { type: 'SALES_SUMMARY', parameters: many })).details
    ).toEqual(['parameters: at most 10 parameters are allowed'])
    expect(
      badRequest(submitReport(ctx, { ...sales, idempotencyKey: 'k'.repeat(129) })).details
    ).toEqual(['idempotencyKey: idempotencyKey must be between 1 and 128 characters'])
    expect(badRequest(submitReport(ctx, { ...sales, idempotencyKey: 'a b' })).details).toEqual([
      "idempotencyKey: idempotencyKey may contain letters, digits, '.', '_', ':' and '-'",
    ])
    expect(badRequest(submitReport(ctx, { ...sales, idempotencyKey: '' })).details).toEqual([
      'idempotencyKey: idempotencyKey must be between 1 and 128 characters',
      "idempotencyKey: idempotencyKey may contain letters, digits, '.', '_', ':' and '-'",
    ])
    expect(sent).toEqual([])
  })

  it('answers invalid parameters with every problem and writes nothing', () => {
    const { ctx, repository, sent } = setup()
    const request: SubmitRequest = {
      type: 'USER_ACTIVITY',
      parameters: { userId: 'abc', dateFrom: 'nope', x: '1' },
    }
    const result = badRequest(submitReport(ctx, request))
    expect(result.message).toBe('Invalid report parameters')
    expect(result.details).toHaveLength(3)
    expect(repository.findAll()).toEqual([])
    expect(sent).toEqual([])
  })

  it('answers a reused key with 409, the handler message and the existing id', () => {
    const { ctx, sent } = setup()
    const first = submitReport(ctx, { ...sales, idempotencyKey: 'key-1' })
    if (first.status !== 202) throw new Error(`expected 202, got ${first.status}`)
    const second = rejected(
      submitReport(ctx, { ...sales, idempotencyKey: 'key-1', correlationId: 'c2' })
    )
    expect(second).toEqual({
      status: 409,
      message: "A report with idempotency key 'key-1' already exists",
      existingReportId: first.job.id,
      correlationId: 'c2',
    })
    expect(sent).toEqual([first.job.id])
  })

  it('returns the stored state when a worker locks the job before the QUEUED write', () => {
    const { ctx, repository, lines } = setup({
      enqueue: (jobId) => {
        const job = repository.findById(jobId)
        if (job === undefined) throw new Error('the job should exist when its message is sent')
        markProcessing(job, 'worker-1', 0)
        repository.update(job)
      },
    })
    const result = submitReport(ctx, { ...sales, correlationId: 'raced' })
    if (result.status !== 202) throw new Error(`expected 202, got ${result.status}`)
    expect(result.job).toMatchObject({ status: 'PROCESSING', lockedBy: 'worker-1', version: 1 })
    expect(lines).toEqual([
      `INFO [raced] Job ${result.job.id} was picked up before it was marked QUEUED`,
    ])
  })
})
