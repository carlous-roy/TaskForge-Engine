// Tests for deadLetter.ts, DeadLetterConsumer: each branch of handle and record, after
// DeadLetterConsumerTest, and the consumer's loop of a two-second long poll and a sleep.

import { describe, expect, it } from 'vitest'
import { DeadLetterConsumer } from './deadLetter.ts'
import { EventLoop } from './events.ts'
import { createJob } from './job.ts'
import type { Log } from './log.ts'
import { SqsQueue, type ReceivedMessage } from './queue.ts'
import { Random } from './random.ts'
import { ReportJobRepository, StaleJobException } from './store.ts'
import type { Job, ReportStatus } from './types.ts'

class FlakyRepository extends ReportJobRepository {
  failingWrites = 0

  override update(job: Job): void {
    if (this.failingWrites > 0) {
      this.failingWrites--
      throw new StaleJobException(job.id, job.version)
    }
    super.update(job)
  }
}

function setup() {
  const loop = new EventLoop()
  const random = new Random(4)
  const lines: string[] = []
  const log: Log = (level, cid, message) => lines.push(`${level} [${cid}] ${message}`)
  const repository = new FlakyRepository()
  const dlq = new SqsQueue({
    name: 'taskforge-reports-dlq',
    visibilityTimeoutS: 30,
    maxReceiveCount: null,
    deadLetterQueue: null,
    scheduler: loop,
    random,
    log: () => {},
  })
  const queue = new SqsQueue({
    name: 'taskforge-reports',
    visibilityTimeoutS: 120,
    maxReceiveCount: 1,
    deadLetterQueue: dlq,
    scheduler: loop,
    random,
    log: () => {},
  })
  const consumer = new DeadLetterConsumer({
    scheduler: loop,
    dlq,
    repository,
    pollIntervalMs: 5_000,
    log,
  })
  const stored = (status: ReportStatus, change: (job: Job) => void = () => {}): Job => {
    const job = createJob(random.uuid(), 'USER_ACTIVITY', {}, 'cid', null, 3, 0)
    job.status = status
    change(job)
    repository.create(job)
    return job
  }
  /** A message sent for the job and dead-lettered now: received once, handed back, received again. */
  const deadLetter = (job: Job): void => {
    queue.send(job.id, job.correlationId)
    const first = queue.receive(1, 'worker-1')[0]
    queue.changeVisibility(first?.receiptHandle ?? '', 0)
    queue.receive(1, 'worker-1')
  }
  return { loop, lines, repository, dlq, consumer, stored, deadLetter }
}

const dead = (job: Job): ReceivedMessage => ({
  messageId: 'm',
  receiptHandle: 'rh-dlq:4',
  jobId: job.id,
  correlationId: 'cid',
  receiveCount: 4,
})

describe('DeadLetterConsumer.handle', () => {
  it('fails a job left PROCESSING by a dead worker, with a reason', () => {
    const { loop, lines, repository, consumer, stored } = setup()
    loop.runUntil(9_000)
    const job = stored('PROCESSING', (j) =>
      Object.assign(j, { attemptCount: 3, errorMessage: 'Attempt 2 failed: timeout' })
    )
    consumer.handle(dead(job))
    const reason =
      'Dead-lettered after 3 deliveries while PROCESSING; last error: Attempt 2 failed: timeout'
    expect(repository.findById(job.id)).toMatchObject({
      status: 'FAILED',
      errorMessage: reason,
      deadLetteredAt: 9_000,
      completedAt: 9_000,
      version: 1,
    })
    expect(lines).toEqual([`ERROR [cid] Job ${job.id} failed: ${reason}`])
  })

  it('explains a job on which no attempt recorded an outcome', () => {
    const { repository, consumer, stored } = setup()
    const job = stored('RETRY_SCHEDULED')
    consumer.handle(dead(job))
    expect(repository.findById(job.id)?.errorMessage).toBe(
      'Dead-lettered after 3 deliveries while RETRY_SCHEDULED; no attempt recorded an outcome (the worker holding it stopped or crashed)'
    )
  })

  it('only stamps a job that already failed', () => {
    const { loop, lines, repository, consumer, stored } = setup()
    loop.runUntil(42)
    const job = stored('FAILED', (j) =>
      Object.assign(j, { errorMessage: 'Attempt 3 of 3 failed: boom' })
    )
    consumer.handle(dead(job))
    expect(repository.findById(job.id)).toMatchObject({
      errorMessage: 'Attempt 3 of 3 failed: boom',
      deadLetteredAt: 42,
      version: 1,
    })
    expect(lines).toEqual([
      `INFO [cid] Message for failed job ${job.id} reached the dead-letter queue after 4 deliveries; recorded`,
    ])
  })

  it('leaves a completed job alone, does nothing for one already recorded, and discards unknown ones', () => {
    const { lines, repository, consumer, stored } = setup()
    const completed = stored('COMPLETED')
    const recorded = stored('FAILED', (j) => Object.assign(j, { deadLetteredAt: 1 }))
    consumer.handle(dead(completed))
    consumer.handle(dead(recorded))
    consumer.handle({ ...dead(completed), jobId: 'gone', correlationId: 'cid-gone' })
    expect(repository.findById(completed.id)?.version).toBe(0)
    expect(repository.findById(recorded.id)?.version).toBe(0)
    expect(lines).toEqual([
      `INFO [cid] Job ${completed.id} completed before its message was dead-lettered; nothing to record`,
      'WARN [cid-gone] Dead-letter message for unknown job gone; discarding it',
    ])
  })

  it('reloads after a stale write, and gives up after the second', () => {
    const { lines, repository, consumer, stored } = setup()
    const once = stored('FAILED')
    repository.failingWrites = 1
    consumer.handle(dead(once))
    expect(repository.findById(once.id)?.deadLetteredAt).toBe(0)

    const twice = stored('FAILED')
    repository.failingWrites = 2
    consumer.handle(dead(twice))
    expect(repository.findById(twice.id)?.deadLetteredAt).toBeNull()
    expect(lines.at(-1)).toBe(
      `WARN [cid] Job ${twice.id} kept changing while being dead-lettered; leaving it as FAILED`
    )
  })
})

describe('DeadLetterConsumer loop', () => {
  it('waits up to two seconds for a message, then sleeps the poll interval', () => {
    const { loop, lines, repository, dlq, consumer, stored, deadLetter } = setup()
    consumer.start()
    expect(lines).toEqual(['INFO [null] Dead-letter consumer started (poll interval PT5S)'])

    const early = stored('FAILED')
    loop.runUntil(1_000)
    deadLetter(early)
    loop.runUntil(1_001)
    expect(repository.findById(early.id)?.deadLetteredAt).toBe(1_001)
    expect(dlq.size()).toBe(0)

    // The wait that started at 1,001 ends at 3,001; the sleep after it ends at 8,001.
    const late = stored('FAILED')
    loop.runUntil(3_500)
    deadLetter(late)
    loop.runUntil(8_000)
    expect(repository.findById(late.id)?.deadLetteredAt).toBeNull()
    loop.runUntil(8_001)
    expect(repository.findById(late.id)?.deadLetteredAt).toBe(8_001)
    expect(dlq.size()).toBe(0)
  })
})
