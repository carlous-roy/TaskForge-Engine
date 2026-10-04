// Scenarios 3 and 4 through the Simulation: a transient poison that spends all three attempts and
// ends in the dead-letter queue, and a permanent failure that ends the job at once. Every error
// text is what JobProcessor passes to markRetryScheduled and markFailed.

import { describe, expect, it } from 'vitest'
import { Simulation } from './simulation.ts'
import type { Job, SimState, SubmitResult } from './types.ts'

const TIMEOUT = 'Unable to execute HTTP request: Read timed out'

function accepted(result: SubmitResult): Job {
  if (result.status !== 202)
    throw new Error(`expected 202, got ${result.status}: ${result.message}`)
  return result.job
}

/** Advances a millisecond at a time until `done` holds, and returns the state at that moment. */
function until(sim: Simulation, done: (state: SimState) => boolean, limitMs = 200_000): SimState {
  for (let step = 0; step <= limitMs; step++) {
    const state = sim.state()
    if (done(state)) return state
    sim.advance(1)
  }
  throw new Error(`not reached within ${limitMs} ms`)
}

const jobIn = (state: SimState, id: string): Job => {
  const job = state.jobs.find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

describe('scenario 3: a transient poison', () => {
  it('fails three attempts with growing windows, then the message is dead-lettered and recorded', () => {
    const sim = new Simulation()
    sim.arm('transient')
    const { id } = accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: { region: 'East' } }))
    const logOf = (state: SimState) => state.log.map((line) => line.message)

    const windows = [4, 8]
    for (const attempt of [1, 2]) {
      const state = until(sim, (s) => {
        const job = jobIn(s, id)
        return job.status === 'RETRY_SCHEDULED' && job.attemptCount === attempt
      })
      const job = jobIn(state, id)
      expect(job).toMatchObject({
        errorMessage: `Attempt ${attempt} failed: ${TIMEOUT}`,
        lockedBy: null,
      })
      expect(job.updatedAt).toBe(state.time)
      const delay = (job.nextAttemptAt ?? -1) - state.time
      expect(delay % 1000).toBe(0)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual((windows[attempt - 1] ?? 0) * 1000)
      expect(logOf(state)).toContain(
        `Attempt ${attempt} of job ${id} failed (${TIMEOUT}); retry in ${delay / 1000} s (window 0-${windows[attempt - 1]} s)`
      )
      // The retry is the same message, hidden until the backoff ends.
      expect(state.queue).toHaveLength(1)
      expect(state.queue[0]?.invisibleUntil).toBe(delay === 0 ? null : job.nextAttemptAt)
    }

    let state = until(sim, (s) => jobIn(s, id).status === 'FAILED')
    const failed = jobIn(state, id)
    expect(failed).toMatchObject({
      attemptCount: 3,
      errorMessage: `Attempt 3 of 3 failed: ${TIMEOUT}. No attempts left; the message was sent to the dead-letter queue.`,
      deadLetteredAt: null,
    })
    expect(logOf(state)).toContain(
      `Attempt 3 of 3 for job ${id} failed (${TIMEOUT}); no attempts left, message goes to the dead-letter queue`
    )
    // Released at once: the next receive finds it at its third delivery and moves it.
    expect(state.queue[0]).toMatchObject({ receiveCount: 3, invisibleUntil: null })
    state = until(sim, (s) => s.stats.deadLettered === 1)
    const movedAt = state.time
    expect(movedAt - (failed.completedAt ?? 0)).toBe(1)
    expect(state.queue).toEqual([])

    state = until(sim, (s) => jobIn(s, id).deadLetteredAt !== null)
    expect(state.time - movedAt).toBeLessThanOrEqual(5_000)
    expect(jobIn(state, id)).toMatchObject({ status: 'FAILED', errorMessage: failed.errorMessage })
    expect(logOf(state)).toContain(
      `Message for failed job ${id} reached the dead-letter queue after 4 deliveries; recorded`
    )
    expect(state.dlq).toEqual([])
    expect(state.stats.deadLettered).toBe(1)
    expect(state.armed).toBeNull()
    const attempts = logOf(state).filter((message) =>
      message.startsWith(`Processing SALES_SUMMARY job ${id}`)
    )
    expect(attempts).toEqual(
      [1, 2, 3].map((n) => `Processing SALES_SUMMARY job ${id} (attempt ${n}/3, delivery ${n})`)
    )
  })

  it('lets the next attempt succeed once disarmed, and strikes only the first job to start', () => {
    const sim = new Simulation()
    sim.arm('transient')
    const poisoned = accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: {} }))
    const healthy = accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: {} }))
    until(sim, (s) => jobIn(s, poisoned.id).status === 'RETRY_SCHEDULED')
    expect(jobIn(sim.state(), healthy.id).status).not.toBe('RETRY_SCHEDULED')
    expect(sim.state().armed).toBe('transient')
    sim.arm(null)
    const state = until(sim, (s) => jobIn(s, poisoned.id).status === 'COMPLETED')
    expect(jobIn(state, poisoned.id)).toMatchObject({ attemptCount: 2, errorMessage: null })
    expect(jobIn(state, healthy.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 1 })
  })
})

describe('scenario 4: a permanent failure', () => {
  it('fails the job on its first attempt, deletes the message and leaves the dead-letter queue empty', () => {
    const sim = new Simulation()
    sim.arm('permanent')
    const { id } = accepted(
      sim.submit({
        type: 'SALES_SUMMARY',
        parameters: { dateTo: '2026-09-01' },
        correlationId: 'perm-1',
      })
    )
    sim.advance(1)
    let state = sim.state()
    const reason =
      "Invalid report parameters: parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'yesterday'"
    expect(jobIn(state, id)).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      errorMessage: `Attempt 1 failed with a non-retryable error: ${reason}`,
      completedAt: 1,
    })
    expect(state.queue).toEqual([])
    expect(
      state.log
        .filter((line) => line.cid === 'perm-1')
        .map((line) => `${line.level} ${line.message}`)
    ).toEqual([
      `INFO Report submitted: SALES_SUMMARY ${id}`,
      `INFO Processing SALES_SUMMARY job ${id} (attempt 1/3, delivery 1)`,
      `ERROR Attempt 1 of job ${id} failed with a non-retryable error: ${reason}`,
    ])
    expect(state.armed).toBeNull()
    expect(state.workers[0]?.failed).toBe(1)

    sim.advance(60_000)
    state = sim.state()
    expect(state.dlq).toEqual([])
    expect(state.stats).toMatchObject({ deadLettered: 0, failed: 1 })
    expect(jobIn(state, id).deadLetteredAt).toBeNull()
    const next = accepted(sim.submit({ type: 'USER_ACTIVITY', parameters: {} }))
    sim.advance(2_000)
    expect(jobIn(sim.state(), next.id).status).toBe('COMPLETED')
  })

  it('uses a value each type rejects, with the message its rule produces', () => {
    const reasons: Record<string, string> = {
      INVENTORY_SNAPSHOT: "parameter 'lowStockThreshold' must be between 0 and 1000000, got -1",
      USER_ACTIVITY: "parameter 'userId' must be a positive integer, got 0",
    }
    for (const [type, problem] of Object.entries(reasons)) {
      const sim = new Simulation()
      sim.arm('permanent')
      const job = accepted(sim.submit({ type: type as Job['type'], parameters: {} }))
      sim.advance(1)
      expect(jobIn(sim.state(), job.id).errorMessage).toBe(
        `Attempt 1 failed with a non-retryable error: Invalid report parameters: ${problem}`
      )
    }
  })
})
