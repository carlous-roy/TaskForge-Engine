// Tests for processor.ts, JobProcessor and FailureClassifier, case by case after JobProcessorTest:
// every branch of acquire, the three kinds of failure, and the stale writes that are discarded.

import { describe, expect, it } from 'vitest'
import { BackoffPolicy } from './backoff.ts'
import { EventLoop } from './events.ts'
import { INTERRUPTION, UPLOAD_TIMEOUT, type Failure } from './faults.ts'
import { formatInstant } from './java.ts'
import { createJob, markFailed, markQueued } from './job.ts'
import type { Log } from './log.ts'
import { acquire, classify, complete, handleFailure, type ProcessorContext } from './processor.ts'
import { SqsQueue, type ReceivedMessage } from './queue.ts'
import { Random } from './random.ts'
import { ReportJobRepository, StaleJobException } from './store.ts'
import type { Job } from './types.ts'

/** Lets a test run something just after the next read, or refuse every write. */
class RacingRepository extends ReportJobRepository {
  afterNextRead: (() => void) | null = null
  refuseWrites = false
  reads = 0

  override findById(id: string): Job | undefined {
    const found = super.findById(id)
    this.reads++
    const race = this.afterNextRead
    this.afterNextRead = null
    race?.()
    return found
  }

  override update(job: Job): void {
    if (this.refuseWrites) throw new StaleJobException(job.id, job.version)
    super.update(job)
  }
}

function setup(seed = 5) {
  const loop = new EventLoop()
  const random = new Random(seed)
  const lines: string[] = []
  const log: Log = (level, cid, message) => lines.push(`${level} [${cid}] ${message}`)
  const repository = new RacingRepository()
  const queue = new SqsQueue({
    name: 'taskforge-reports',
    visibilityTimeoutS: 120,
    maxReceiveCount: 3,
    deadLetterQueue: null,
    scheduler: loop,
    random,
    log,
  })
  const counters = { takeovers: 0, staleWritesDiscarded: 0 }
  const ctx: ProcessorContext = {
    workerId: 'worker-test',
    clock: loop,
    repository,
    queue,
    backoff: new BackoffPolicy(2, 60, random),
    maxAttempts: 3,
    staleLockAfterMs: 120_000,
    log,
    counters,
  }
  /** A job written as `status` (QUEUED at version 1 by default), with its message in the queue. */
  const stored = (change: (job: Job) => void = () => {}): Job => {
    const job = createJob(
      random.uuid(),
      'SALES_SUMMARY',
      { region: 'North' },
      'cid-job',
      null,
      3,
      0
    )
    job.status = 'QUEUED'
    job.version = 1
    change(job)
    repository.create(job)
    queue.send(job.id, 'cid-msg')
    return job
  }
  /** The next delivery, after `earlier` receives that were handed straight back. */
  const deliver = (earlier = 0): ReceivedMessage => {
    for (let i = 0; i < earlier; i++) {
      const handed = queue.receive(1, 'other')[0]
      if (handed !== undefined) queue.changeVisibility(handed.receiptHandle, 0)
    }
    const message = queue.receive(1, 'worker-test')[0]
    if (message === undefined) throw new Error('nothing to deliver')
    return message
  }
  const locked = (message: ReceivedMessage): Job => {
    const job = acquire(ctx, message)
    if (job === null) throw new Error('the lock was expected to succeed')
    return job
  }
  return { loop, lines, repository, queue, ctx, counters, stored, deliver, locked }
}

const failure = (message: string): Failure => ({ exception: 'SdkClientException', message })

describe('acquire and complete', () => {
  it('completes the job, uploads under the job correlation id and deletes the message', () => {
    const { ctx, lines, queue, repository, stored, deliver, locked } = setup()
    const job = stored()
    const message = deliver()
    const processing = locked(message)
    expect(processing).toMatchObject({
      status: 'PROCESSING',
      attemptCount: 1,
      lockedBy: 'worker-test',
      version: 2,
    })
    expect(complete(ctx, processing, message, 0, 120)).toEqual({
      outcome: 'COMPLETED',
      recorded: true,
    })
    const fileKey = `reports/sales_summary/${job.id}.csv`
    expect(repository.findById(job.id)).toMatchObject({
      status: 'COMPLETED',
      fileKey,
      version: 3,
      lockedBy: null,
    })
    expect(queue.size()).toBe(0)
    expect(lines).toEqual([
      `INFO [cid-job] Uploaded s3://taskforge-reports/${fileKey} (120 bytes)`,
      `INFO [cid-job] Job ${job.id} completed in 0 ms: ${fileKey}`,
    ])
  })

  it('leaves a job another worker holds, without touching the message', () => {
    const { loop, lines, queue, repository, stored, deliver, ctx } = setup()
    loop.runUntil(30_000)
    const job = stored((j) =>
      Object.assign(j, { status: 'PROCESSING', lockedBy: 'worker-other', updatedAt: 0 })
    )
    expect(acquire(ctx, deliver(1))).toBeNull()
    expect(repository.findById(job.id)?.version).toBe(1)
    expect(queue.messages()[0]).toMatchObject({ receiveCount: 2, invisibleUntil: 150_000 })
    expect(lines).toEqual([
      `INFO [cid-job] Job ${job.id} is being processed by worker-other since ${formatInstant(0)}; leaving the message for redelivery`,
    ])
  })

  it('takes over a job whose holder went silent for longer than the visibility timeout', () => {
    const { loop, lines, counters, ctx, queue, stored, deliver, locked } = setup()
    loop.runUntil(200_000)
    const job = stored((j) =>
      Object.assign(j, { status: 'PROCESSING', lockedBy: 'worker-dead', attemptCount: 1 })
    )
    const message = deliver(1)
    const taken = locked(message)
    expect(taken).toMatchObject({ attemptCount: 2, lockedBy: 'worker-test' })
    expect(counters.takeovers).toBe(1)
    expect(lines[0]).toBe(
      `WARN [cid-job] Job ${job.id} was left PROCESSING by worker-dead at ${formatInstant(0)}; taking it over`
    )
    expect(complete(ctx, taken, message, 200_000, 1).outcome).toBe('COMPLETED')
    expect(queue.size()).toBe(0)
  })

  it('retries a lock lost to the API QUEUED write on a fresh copy', () => {
    const { lines, repository, stored, deliver, locked } = setup()
    const job = stored((j) => Object.assign(j, { status: 'ACCEPTED', version: 0 }))
    repository.afterNextRead = () => {
      const api = repository.findById(job.id) as Job
      markQueued(api, 0)
      repository.update(api)
    }
    const taken = locked(deliver())
    expect(taken).toMatchObject({ status: 'PROCESSING', attemptCount: 1, version: 2 })
    expect(lines).toEqual([
      `INFO [cid-job] Job ${job.id} changed while locking it (try 1 of 3); reloading`,
    ])
  })

  it('leaves the message alone after losing the race for the lock three times', () => {
    const { lines, repository, queue, stored, deliver, ctx } = setup()
    const job = stored()
    repository.refuseWrites = true
    expect(acquire(ctx, deliver())).toBeNull()
    expect(lines.at(-1)).toBe(
      `WARN [cid-job] Job ${job.id} kept changing; leaving the message for redelivery`
    )
    expect(lines.filter((line) => line.includes('changed while locking it'))).toHaveLength(3)
    expect(queue.messages()[0]?.receiveCount).toBe(1)
  })

  it('discards a stale completion instead of overwriting newer state', () => {
    const { ctx, counters, lines, queue, repository, stored, deliver, locked } = setup()
    const job = stored()
    const message = deliver()
    const mine = locked(message)
    const other = repository.findById(job.id) as Job
    markFailed(other, 'decided elsewhere', 0)
    repository.update(other)
    expect(complete(ctx, mine, message, 0, 1)).toEqual({ outcome: 'SKIPPED', recorded: false })
    expect(counters.staleWritesDiscarded).toBe(1)
    expect(lines.at(-1)).toBe(
      `WARN [cid-job] Job ${job.id} was modified by another process; this worker's result is discarded and the message left alone`
    )
    expect(queue.size()).toBe(1)
    expect(repository.findById(job.id)?.status).toBe('FAILED')
  })

  it('discards duplicate deliveries of terminal jobs and messages for unknown jobs', () => {
    const { lines, queue, stored, deliver, ctx } = setup()
    const done = stored((j) => Object.assign(j, { status: 'COMPLETED' }))
    expect(acquire(ctx, deliver())).toBeNull()
    expect(queue.size()).toBe(0)
    queue.send('missing', 'cid-gone')
    const orphan = deliver()
    expect(acquire(ctx, orphan)).toBeNull()
    expect(queue.size()).toBe(0)
    expect(lines).toEqual([
      `INFO [cid-job] Job ${done.id} is already COMPLETED; discarding duplicate delivery`,
      `WARN [cid-gone] Job missing does not exist; discarding message ${orphan.messageId}`,
    ])
  })
})

describe('handleFailure', () => {
  it('schedules a transient failure through the visibility timeout and keeps the message', () => {
    const { ctx, queue, stored, deliver, locked } = setup()
    stored()
    const message = deliver()
    const job = locked(message)
    expect(handleFailure(ctx, job, message, failure('slow down'), false).outcome).toBe(
      'RETRY_SCHEDULED'
    )
    expect(job.status).toBe('RETRY_SCHEDULED')
    expect(job.errorMessage).toBe('Attempt 1 failed: slow down')
    const delay = (job.nextAttemptAt ?? -1) - ctx.clock.now
    expect(delay).toBeGreaterThanOrEqual(0)
    expect(delay).toBeLessThanOrEqual(4_000)
    expect(queue.messages()[0]?.invisibleUntil).toBe(delay === 0 ? null : delay)
  })

  it('sends visibility timeouts that vary across failures and stay inside the window', () => {
    const first = new Set<number>()
    const second = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const { ctx, loop, stored, deliver, locked } = setup(i)
      stored()
      const m1 = deliver()
      const j1 = locked(m1)
      handleFailure(ctx, j1, m1, UPLOAD_TIMEOUT, false)
      first.add(((j1.nextAttemptAt ?? 0) - loop.now) / 1000)
      loop.runUntil(j1.nextAttemptAt ?? 0)
      const m2 = deliver()
      const j2 = locked(m2)
      handleFailure(ctx, j2, m2, UPLOAD_TIMEOUT, false)
      second.add(((j2.nextAttemptAt ?? 0) - loop.now) / 1000)
    }
    expect(Math.max(...first)).toBeLessThanOrEqual(4)
    expect(Math.max(...second)).toBeLessThanOrEqual(8)
    expect(first.size).toBeGreaterThan(2)
    expect(second.size).toBeGreaterThan(3)
    expect(Math.max(...second)).toBeGreaterThan(4)
  })

  it('fails the last attempt and releases the message for the dead-letter queue', () => {
    const { ctx, queue, stored, deliver, locked } = setup()
    stored((j) => Object.assign(j, { status: 'RETRY_SCHEDULED', attemptCount: 2 }))
    const message = deliver(2)
    const job = locked(message)
    expect(handleFailure(ctx, job, message, failure('still broken'), false).outcome).toBe('FAILED')
    expect(job.attemptCount).toBe(3)
    expect(job.errorMessage).toBe(
      'Attempt 3 of 3 failed: still broken. No attempts left; the message was sent to the dead-letter queue.'
    )
    expect(queue.messages()[0]).toMatchObject({ receiveCount: 3, invisibleUntil: null })
  })

  it('trusts the delivery count from SQS over the job attempt counter', () => {
    const { ctx, queue, stored, deliver, locked } = setup()
    stored()
    const message = deliver(2)
    const job = locked(message)
    expect(job.attemptCount).toBe(1)
    expect(handleFailure(ctx, job, message, failure('boom'), false).outcome).toBe('FAILED')
    expect(job.errorMessage).toContain('Attempt 1 of 3 failed: boom')
    expect(queue.visibleCount()).toBe(1)
  })

  it('fails a non-retryable error at once and deletes the message', () => {
    const { ctx, lines, queue, stored, deliver, locked } = setup()
    stored()
    const message = deliver()
    const job = locked(message)
    const bad: Failure = {
      exception: 'InvalidReportParametersException',
      message:
        "Invalid report parameters: parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'x'",
    }
    expect(handleFailure(ctx, job, message, bad, false)).toEqual({
      outcome: 'FAILED',
      recorded: true,
    })
    expect(job.errorMessage).toBe(`Attempt 1 failed with a non-retryable error: ${bad.message}`)
    expect(lines.at(-1)).toBe(
      `ERROR [cid-job] Attempt 1 of job ${job.id} failed with a non-retryable error: ${bad.message}`
    )
    expect(queue.size()).toBe(0)
  })

  it('hands an interrupted attempt straight back to SQS', () => {
    const { ctx, loop, lines, queue, stored, deliver, locked } = setup()
    stored()
    loop.runUntil(700)
    const message = deliver()
    const job = locked(message)
    expect(handleFailure(ctx, job, message, INTERRUPTION, true).outcome).toBe('INTERRUPTED')
    expect(job).toMatchObject({
      status: 'RETRY_SCHEDULED',
      errorMessage: 'Attempt 1 was interrupted by a worker shutdown',
      nextAttemptAt: 700,
    })
    expect(queue.messages()[0]?.invisibleUntil).toBeNull()
    expect(lines.at(-1)).toBe(
      `WARN [cid-job] Attempt 1 of job ${job.id} interrupted by shutdown; releasing the message`
    )
  })

  it('logs a hand-back that SQS refuses and leaves the message to its timeout', () => {
    const { ctx, loop, lines, stored, deliver, locked } = setup()
    stored()
    const message = deliver()
    const job = locked(message)
    loop.runUntil(120_000)
    deliver()
    expect(handleFailure(ctx, job, message, INTERRUPTION, true)).toEqual({
      outcome: 'INTERRUPTED',
      recorded: true,
    })
    expect(lines.at(-1)).toBe(
      `ERROR [cid-job] Could not hand job ${job.id} back after the interrupt; it will be redelivered after the visibility timeout`
    )
  })
})

describe('classify', () => {
  it('puts the interrupt flag first, then reads the exception', () => {
    expect(classify(failure('timeout'), false)).toBe('TRANSIENT')
    expect(classify({ exception: 'InvalidReportParametersException', message: 'x' }, false)).toBe(
      'PERMANENT'
    )
    expect(classify(INTERRUPTION, false)).toBe('INTERRUPTED')
    expect(classify({ exception: 'InvalidReportParametersException', message: 'x' }, true)).toBe(
      'INTERRUPTED'
    )
  })
})
