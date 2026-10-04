// Scenarios 5, 6 and 7 through the Simulation: a worker killed with a job in flight, a worker
// frozen past the visibility timeout, and the SIGTERM drain; then how a worker polls.

import { describe, expect, it } from 'vitest'
import { formatInstant } from './java.ts'
import { Simulation } from './simulation.ts'
import type { Job, SimState, SubmitResult } from './types.ts'

function accepted(result: SubmitResult): Job {
  if (result.status !== 202)
    throw new Error(`expected 202, got ${result.status}: ${result.message}`)
  return result.job
}

const jobIn = (state: SimState, id: string): Job => {
  const job = state.jobs.find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

const workerIn = (state: SimState, id: string) => state.workers.find((worker) => worker.id === id)
const messagesFrom = (state: SimState, source: string) =>
  state.log.filter((line) => line.source === source).map((line) => line.message)

/** Submits one job at t=0 and lets a worker take it at t=1; returns the job and its holder. */
function started(sim: Simulation) {
  const job = accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: {}, correlationId: 'held' }))
  sim.advance(1)
  const holder = jobIn(sim.state(), job.id).lockedBy ?? ''
  const other = holder === 'worker-1' ? 'worker-2' : 'worker-1'
  return { job, holder, other }
}

describe('scenario 5: a worker killed with a job in flight', () => {
  it('keeps the lock until the visibility timeout, then the other worker takes the job over', () => {
    const sim = new Simulation()
    const { job, holder, other } = started(sim)
    sim.advance(99)
    sim.killWorker(holder)
    expect(workerIn(sim.state(), holder)).toMatchObject({ state: 'dead', slots: [] })

    // Received at t=1, so hidden until 120,001; nothing moves before then.
    sim.advance(120_000 - 100)
    let state = sim.state()
    expect(state.time).toBe(120_000)
    expect(jobIn(state, job.id)).toMatchObject({
      status: 'PROCESSING',
      lockedBy: holder,
      attemptCount: 1,
    })
    expect(state.queue[0]).toMatchObject({ receiveCount: 1, invisibleUntil: 120_001 })
    expect(state.stats.takeovers).toBe(0)

    sim.advance(1)
    expect(sim.state().queue[0]?.invisibleUntil).toBeNull()
    sim.advance(1)
    state = sim.state()
    expect(jobIn(state, job.id)).toMatchObject({
      status: 'PROCESSING',
      lockedBy: other,
      attemptCount: 2,
    })
    expect(state.queue[0]?.receiveCount).toBe(2)
    expect(state.stats.takeovers).toBe(1)
    expect(messagesFrom(state, other)).toContain(
      `Job ${job.id} was left PROCESSING by ${holder} at ${formatInstant(1)}; taking it over`
    )
    expect(state.log.find((line) => line.message.includes('taking it over'))).toMatchObject({
      level: 'WARN',
      cid: 'held',
      t: 120_002,
    })

    sim.advance(2_000)
    state = sim.state()
    expect(jobIn(state, job.id)).toMatchObject({
      status: 'COMPLETED',
      attemptCount: 2,
      lockedBy: null,
    })
    expect(workerIn(state, other)?.completed).toBe(1)
    expect(state.queue).toEqual([])
  })
})

describe('scenario 6: a worker frozen past the visibility timeout', () => {
  it('loses the job to the other worker, and its late result is discarded', () => {
    const sim = new Simulation({ generationMs: [1_000, 1_000] })
    const { job, holder, other } = started(sim)
    sim.advance(99)
    sim.freezeWorker(holder, 150)
    expect(workerIn(sim.state(), holder)).toMatchObject({
      state: 'frozen',
      until: 150_100,
      slots: [{ jobId: job.id, startedAt: 1, finishesAt: 151_001, attempt: 1 }],
    })

    sim.advance(121_002 - 100)
    let state = sim.state()
    expect(jobIn(state, job.id)).toMatchObject({ status: 'COMPLETED', version: 4, attemptCount: 2 })
    const completedByOther = jobIn(state, job.id)
    expect(workerIn(state, other)?.completed).toBe(1)

    sim.advance(151_001 - 121_002)
    state = sim.state()
    expect(workerIn(state, holder)).toMatchObject({ state: 'running', completed: 0, slots: [] })
    expect(state.stats.staleWritesDiscarded).toBe(1)
    expect(messagesFrom(state, holder)).toContain(
      `Job ${job.id} was modified by another process; this worker's result is discarded and the message left alone`
    )
    expect(jobIn(state, job.id)).toBe(completedByOther)
  })
})

describe('scenario 7: SIGTERM', () => {
  it('stops receiving at once, lets the job in flight finish, then stops', () => {
    const sim = new Simulation({ generationMs: [1_000, 1_000] })
    const { job, holder, other } = started(sim)
    sim.advance(99)
    sim.drainWorker(holder)
    let state = sim.state()
    expect(workerIn(state, holder)).toMatchObject({ state: 'draining', until: 60_100 })
    expect(messagesFrom(state, holder).slice(-2)).toEqual([
      'Shutdown requested: 1 job(s) in flight, waiting up to PT1M',
      'Polling stopped',
    ])

    const later = [1, 2, 3].map(() =>
      accepted(sim.submit({ type: 'USER_ACTIVITY', parameters: {} }))
    )
    sim.advance(1_000)
    state = sim.state()
    expect(jobIn(state, job.id).status).toBe('COMPLETED')
    expect(workerIn(state, holder)).toMatchObject({ state: 'stopped', until: null, completed: 1 })
    expect(messagesFrom(state, holder).at(-1)).toBe('Drain complete: all in-flight jobs finished')

    sim.advance(10_000)
    for (const each of later) expect(jobIn(sim.state(), each.id).status).toBe('COMPLETED')
    sim.submit({ type: 'USER_ACTIVITY', parameters: {} })
    sim.advance(5_000)
    state = sim.state()
    const processedBy = state.log
      .filter((line) => line.message.startsWith('Processing'))
      .map((line) => line.source)
    expect(processedBy).toEqual([holder, other, other, other, other])
  })

  it('interrupts a job still running at the deadline and hands its message straight back', () => {
    const sim = new Simulation({ generationMs: [5_000, 5_000], drainTimeoutS: 1 })
    const { job, holder, other } = started(sim)
    sim.drainWorker(holder)
    sim.advance(999)
    expect(jobIn(sim.state(), job.id).status).toBe('PROCESSING')
    sim.advance(1)
    let state = sim.state()
    expect(jobIn(state, job.id)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      errorMessage: 'Attempt 1 was interrupted by a worker shutdown',
      nextAttemptAt: 1_001,
      lockedBy: null,
    })
    expect(state.queue[0]).toMatchObject({ receiveCount: 1, invisibleUntil: null })
    expect(messagesFrom(state, holder).slice(-3)).toEqual([
      'Drain deadline of PT1S reached with 1 job(s) still running; interrupting them',
      `Attempt 1 of job ${job.id} interrupted by shutdown; releasing the message`,
      'Interrupted jobs handed their messages back',
    ])
    expect(workerIn(state, holder)?.state).toBe('stopped')

    sim.advance(1)
    expect(jobIn(sim.state(), job.id)).toMatchObject({
      status: 'PROCESSING',
      lockedBy: other,
      attemptCount: 2,
    })
    sim.advance(5_000)
    state = sim.state()
    expect(jobIn(state, job.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 2 })

    sim.restartWorker(holder)
    expect(workerIn(sim.state(), holder)?.state).toBe('running')
    expect(messagesFrom(sim.state(), holder).slice(-2)).toEqual([
      'Loaded 3 report generators: [SALES_SUMMARY, INVENTORY_SNAPSHOT, USER_ACTIVITY]',
      'Polling started (max-concurrent=3, batch-size=5, drain-timeout=PT1S)',
    ])
  })

  it('drains a frozen worker once it runs again', () => {
    const sim = new Simulation({ generationMs: [1_000, 1_000] })
    const { holder } = started(sim)
    sim.freezeWorker(holder, 10)
    sim.drainWorker(holder)
    expect(workerIn(sim.state(), holder)?.state).toBe('frozen')
    sim.advance(10_000)
    expect(workerIn(sim.state(), holder)?.state).toBe('draining')
    sim.advance(1_000)
    expect(workerIn(sim.state(), holder)?.state).toBe('stopped')
  })
})

describe('polling', () => {
  it('takes no more jobs than its slots and looks again after the idle wait', () => {
    const sim = new Simulation({ workers: 1, maxConcurrent: 2, generationMs: [1_000, 1_000] })
    const jobs = [1, 2, 3].map(() =>
      accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: {} }))
    )
    sim.advance(1)
    let state = sim.state()
    expect(state.workers[0]?.slots.map((slot) => slot.jobId)).toEqual([jobs[0]?.id, jobs[1]?.id])
    expect(state.queue.filter((m) => m.invisibleUntil === null)).toHaveLength(1)
    // Full since t=1, the poller sleeps 500 ms at a time: 501, 1,001. The slots free at 1,001.
    sim.advance(1_000)
    state = sim.state()
    expect(jobIn(state, jobs[2]?.id ?? '')).toMatchObject({
      status: 'PROCESSING',
      updatedAt: 1_001,
    })
  })

  it('polls every idle wait when the long-poll wait is zero', () => {
    const sim = new Simulation({ workers: 1, receiveWaitS: 0 })
    sim.advance(100)
    const job = accepted(sim.submit({ type: 'SALES_SUMMARY', parameters: {} }))
    sim.advance(399)
    expect(jobIn(sim.state(), job.id).status).toBe('QUEUED')
    sim.advance(1)
    expect(jobIn(sim.state(), job.id)).toMatchObject({ status: 'PROCESSING', updatedAt: 500 })
  })

  it('records a point of history every simulated second', () => {
    const sim = new Simulation({ generationMs: [1_500, 1_500] })
    sim.burst(3, { type: 'SALES_SUMMARY', parameters: {} })
    sim.advance(3_000)
    const history = sim.state().history
    expect(history.map((point) => point.t)).toEqual([0, 1_000, 2_000, 3_000])
    expect(history[0]).toEqual({ t: 0, queueDepth: 3, inFlight: 0, dlqDepth: 0 })
    expect(history[1]).toEqual({ t: 1_000, queueDepth: 0, inFlight: 3, dlqDepth: 0 })
  })
})
