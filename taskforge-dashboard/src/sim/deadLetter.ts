// com.taskforge.worker.service.DeadLetterConsumer: reads the dead-letter queue and records on each
// job that its message got there. In the services every worker process runs one (it is enabled by
// default); the simulation runs a single consumer, logged as `dlq`, that keeps running whatever
// happens to the workers.

import type { Scheduler, Timer } from './events.ts'
import { formatDuration } from './java.ts'
import { markDeadLettered, markFailed } from './job.ts'
import type { Log } from './log.ts'
import type { ReceivedMessage, SqsQueue } from './queue.ts'
import { StaleJobException, type ReportJobRepository } from './store.ts'
import type { Job } from './types.ts'

/** DeadLetterConsumer.RECEIVE_WAIT: each receive waits up to this long for a message. */
export const RECEIVE_WAIT_MS = 2_000
const BATCH = 10

export interface DeadLetterDeps {
  readonly scheduler: Scheduler
  readonly dlq: SqsQueue
  readonly repository: ReportJobRepository
  readonly pollIntervalMs: number
  readonly log: Log
}

export class DeadLetterConsumer {
  private readonly deps: DeadLetterDeps
  private longPoll: Timer | null = null
  private timer: Timer | null = null

  constructor(deps: DeadLetterDeps) {
    this.deps = deps
  }

  start(): void {
    const interval = formatDuration(this.deps.pollIntervalMs)
    this.deps.log('INFO', null, `Dead-letter consumer started (poll interval ${interval})`)
    this.poll()
  }

  /** Records the dead-lettering on the job and acknowledges the message. */
  handle(message: ReceivedMessage): void {
    const { dlq, log, repository } = this.deps
    const job = repository.findById(message.jobId)
    if (job === undefined) {
      log(
        'WARN',
        message.correlationId,
        `Dead-letter message for unknown job ${message.jobId}; discarding it`
      )
      dlq.delete(message.receiptHandle)
      return
    }
    this.record(job, message.receiveCount)
    dlq.delete(message.receiptHandle)
  }

  /**
   * The consumer's loop: a receive that waits up to RECEIVE_WAIT for messages, each one handled,
   * straight back to the next receive while there were any, and a sleep of the poll interval
   * after a receive that came back empty.
   */
  private poll(): void {
    const { dlq, scheduler, pollIntervalMs } = this.deps
    for (;;) {
      const messages = dlq.receive(BATCH, 'dlq')
      for (const message of messages) this.handle(message)
      if (messages.length === 0) break
    }
    this.longPoll = dlq.waitForMessages(() => {
      this.timer?.cancel()
      this.longPoll = null
      this.poll()
    })
    this.timer = scheduler.at(scheduler.now + RECEIVE_WAIT_MS, () => {
      this.longPoll?.cancel()
      this.longPoll = null
      this.timer = scheduler.at(scheduler.now + pollIntervalMs, () => this.poll())
    })
  }

  private record(loaded: Job, deliveries: number): void {
    const { log, repository, scheduler } = this.deps
    let job = loaded
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = scheduler.now
      const cid = job.correlationId
      if (job.status === 'COMPLETED') {
        log(
          'INFO',
          cid,
          `Job ${job.id} completed before its message was dead-lettered; nothing to record`
        )
        return
      }
      if (job.status === 'FAILED' && job.deadLetteredAt !== null) return
      if (job.status === 'FAILED') {
        log(
          'INFO',
          cid,
          `Message for failed job ${job.id} reached the dead-letter queue after ${deliveries} deliveries; recorded`
        )
      } else {
        const lastError =
          job.errorMessage !== null
            ? `last error: ${job.errorMessage}`
            : 'no attempt recorded an outcome (the worker holding it stopped or crashed)'
        // The receive from the dead-letter queue counts as one more delivery than the job had.
        const count = Math.max(deliveries - 1, job.attemptCount)
        const reason = `Dead-lettered after ${count} deliveries while ${job.status}; ${lastError}`
        log('ERROR', cid, `Job ${job.id} failed: ${reason}`)
        markFailed(job, reason, now)
      }
      markDeadLettered(job, now)
      try {
        repository.update(job)
        return
      } catch (error) {
        if (!(error instanceof StaleJobException)) throw error
        const fresh = repository.findById(job.id)
        if (fresh === undefined) return
        job = fresh
      }
    }
    log(
      'WARN',
      job.correlationId,
      `Job ${job.id} kept changing while being dead-lettered; leaving it as ${job.status}`
    )
  }
}
