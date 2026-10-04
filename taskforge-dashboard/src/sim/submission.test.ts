// Scenarios 1, 2, 8 and 9 through the Simulation: a submission from ACCEPTED to COMPLETED, the
// same idempotency key twice, a burst against the rate limit, and correlation ids end to end.

import { describe, expect, it } from 'vitest'
import { Simulation } from './simulation.ts'
import type { Job, SubmitResult } from './types.ts'

function accepted(result: SubmitResult): Job {
  if (result.status !== 202)
    throw new Error(`expected 202, got ${result.status}: ${result.message}`)
  return result.job
}

function jobOf(sim: Simulation, id: string): Job {
  const job = sim.state().jobs.find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

describe('scenario 1: one submission, start to finish', () => {
  it('is QUEUED, picked up, PROCESSING, then COMPLETED, with one version per write', () => {
    const sim = new Simulation()
    const submitted = accepted(
      sim.submit({ type: 'SALES_SUMMARY', parameters: { region: ' North ' } })
    )
    // create wrote version 0 as ACCEPTED, the message went out, markQueued wrote version 1.
    expect(submitted).toMatchObject({
      status: 'QUEUED',
      version: 1,
      attemptCount: 0,
      lockedBy: null,
      maxAttempts: 3,
      parameters: { region: 'North' },
      createdAt: 0,
    })
    expect(sim.state().queue).toEqual([
      expect.objectContaining({
        jobId: submitted.id,
        receiveCount: 0,
        invisibleUntil: null,
        sentAt: 0,
      }),
    ])

    // A waiting long poll returns the message one millisecond later.
    sim.advance(1)
    let state = sim.state()
    expect(state.jobs[0]).toMatchObject({
      status: 'PROCESSING',
      version: 2,
      attemptCount: 1,
      lockedBy: 'worker-1',
    })
    expect(state.queue[0]).toMatchObject({ receiveCount: 1, invisibleUntil: 120_001 })
    const slot = state.workers[0]?.slots[0]
    expect(slot).toMatchObject({ jobId: submitted.id, startedAt: 1, attempt: 1 })
    const finishesAt = slot?.finishesAt ?? 0
    expect(finishesAt - 1).toBeGreaterThanOrEqual(600)
    expect(finishesAt - 1).toBeLessThanOrEqual(1_800)

    sim.advance(finishesAt - 2)
    expect(jobOf(sim, submitted.id).status).toBe('PROCESSING')
    sim.advance(1)
    state = sim.state()
    const fileKey = `reports/sales_summary/${submitted.id}.csv`
    expect(state.jobs[0]).toMatchObject({
      status: 'COMPLETED',
      version: 3,
      attemptCount: 1,
      lockedBy: null,
      fileKey,
      completedAt: finishesAt,
      executionTimeMs: finishesAt - 1,
    })
    expect(state.queue).toEqual([])
    expect(state.workers[0]).toMatchObject({ completed: 1, slots: [] })
    expect(state.stats).toMatchObject({ accepted: 1, completed: 1, queued: 0, processing: 0 })

    const lines = state.log
      .filter((line) => line.cid === submitted.correlationId)
      .map((line) => line.message)
    expect(lines).toEqual([
      `Report submitted: SALES_SUMMARY ${submitted.id}`,
      `Processing SALES_SUMMARY job ${submitted.id} (attempt 1/3, delivery 1)`,
      'Generating SALES_SUMMARY 2026-08-19..2026-09-18 region=North',
      expect.stringMatching(/^SALES_SUMMARY complete: \d+ bytes$/),
      expect.stringMatching(
        new RegExp(`^Uploaded s3://taskforge-reports/${fileKey} \\(\\d+ bytes\\)$`)
      ),
      `Job ${submitted.id} completed in ${finishesAt - 1} ms: ${fileKey}`,
    ])
  })
})

describe('scenario 2: the same idempotency key twice', () => {
  it('answers 409 with the first job id and the handler text, and leaves the first job as it was', () => {
    const sim = new Simulation()
    const first = accepted(
      sim.submit({ type: 'USER_ACTIVITY', parameters: {}, idempotencyKey: 'order-7' })
    )
    const before = jobOf(sim, first.id)
    const second = sim.submit({
      type: 'USER_ACTIVITY',
      parameters: { userId: '42' },
      idempotencyKey: 'order-7',
    })
    expect(second).toEqual({
      status: 409,
      message: "A report with idempotency key 'order-7' already exists",
      existingReportId: first.id,
      correlationId: expect.stringMatching(/^[0-9a-f]{12}$/),
    })
    const state = sim.state()
    expect(state.jobs).toHaveLength(1)
    expect(state.jobs[0]).toBe(before)
    expect(state.queue).toHaveLength(1)
    expect(state.stats.rejectedDuplicates).toBe(1)

    const other = accepted(
      sim.submit({ type: 'USER_ACTIVITY', parameters: {}, idempotencyKey: 'order-8' })
    )
    expect(other.id).not.toBe(first.id)
    expect(sim.state().jobs.map((job) => job.idempotencyKey)).toEqual(['order-8', 'order-7'])
  })
})

describe('scenario 8: a burst against the rate limit', () => {
  it('accepts 60 of 70 in one instant and refuses 10 with the Retry-After the filter computes', () => {
    const sim = new Simulation()
    const results = sim.burst(70, { type: 'INVENTORY_SNAPSHOT', parameters: {} })
    expect(results.filter((r) => r.status === 202)).toHaveLength(60)
    const refused = results.filter((r) => r.status === 429)
    expect(refused).toHaveLength(10)
    // max(1, (startedAt + 60,000 - now + 999) / 1000) with integer division: 60,999 / 1000 = 60.
    for (const result of refused) {
      expect(result).toMatchObject({
        retryAfterSeconds: 60,
        message:
          'Rate limit exceeded: at most 60 requests per minute per client. Retry after 60 second(s).',
      })
    }
    expect(results.slice(60).every((r) => r.status === 429)).toBe(true)
    let state = sim.state()
    expect(state.stats).toMatchObject({ accepted: 60, rateLimited: 10 })
    expect(state.rateWindow).toEqual({ startedAt: 0, count: 70 })
    expect(state.jobs).toHaveLength(60)

    sim.advance(59_999)
    expect(sim.submit({ type: 'INVENTORY_SNAPSHOT', parameters: {} })).toMatchObject({
      status: 429,
      retryAfterSeconds: 1,
    })
    sim.advance(1)
    expect(sim.submit({ type: 'INVENTORY_SNAPSHOT', parameters: {} }).status).toBe(202)
    state = sim.state()
    expect(state.rateWindow).toEqual({ startedAt: 60_000, count: 1 })
    expect(state.stats.rateLimited).toBe(11)
  })
})

describe('scenario 9: correlation ids', () => {
  it('keeps a valid supplied id on the job, the message and every log line of the job', () => {
    const sim = new Simulation()
    const job = accepted(
      sim.submit({
        type: 'INVENTORY_SNAPSHOT',
        parameters: { warehouse: 'WH-EAST' },
        correlationId: 'client-req-7',
      })
    )
    expect(job.correlationId).toBe('client-req-7')
    expect(sim.state().queue[0]?.correlationId).toBe('client-req-7')
    sim.advance(5_000)
    const state = sim.state()
    expect(jobOf(sim, job.id).status).toBe('COMPLETED')
    const aboutTheJob = state.log.filter((line) => line.message.includes(job.id))
    expect(aboutTheJob.length).toBeGreaterThanOrEqual(4)
    for (const line of aboutTheJob) expect(line.cid).toBe('client-req-7')
    const tagged = state.log.filter((line) => line.cid === 'client-req-7')
    expect(tagged.map((line) => line.source)).toEqual([
      'api',
      'worker-1',
      'worker-1',
      'worker-1',
      'worker-1',
      'worker-1',
    ])
    expect(tagged[2]?.message).toBe(
      'Generating INVENTORY_SNAPSHOT warehouse=WH-EAST lowStockThreshold=10'
    )
  })

  it('replaces an invalid id with a generated one, and answers every rejection with one too', () => {
    const sim = new Simulation({ rateLimitPerMinute: 3 })
    const replaced = accepted(
      sim.submit({
        type: 'SALES_SUMMARY',
        parameters: {},
        correlationId: 'has spaces and "quotes"',
      })
    )
    expect(replaced.correlationId).toMatch(/^[0-9a-f]{12}$/)
    expect(sim.state().queue[0]?.correlationId).toBe(replaced.correlationId)
    const invalid = sim.submit({
      type: 'SALES_SUMMARY',
      parameters: { bogus: '1' },
      correlationId: 'bad-params',
    })
    expect(invalid).toMatchObject({ status: 400, correlationId: 'bad-params' })
    const generated = sim.submit({
      type: 'SALES_SUMMARY',
      parameters: {},
      correlationId: 'x'.repeat(65),
    })
    expect(generated.status === 202 && generated.job.correlationId).toMatch(/^[0-9a-f]{12}$/)
    const limited = sim.submit({
      type: 'SALES_SUMMARY',
      parameters: {},
      correlationId: 'over-the-limit',
    })
    expect(limited).toMatchObject({ status: 429, correlationId: 'over-the-limit' })
  })
})
