// com.taskforge.worker.service.MessagePoller, under WorkerIdentity's name: one worker process. It
// receives while it has free slots, runs each message through JobProcessor (processor.ts) and
// spreads the generation over simulated time; on SIGTERM it drains. kill, freeze and restart are
// what a crash, a long pause and an operator do to the process from outside.

import type { BackoffPolicy } from './backoff.ts'
import type { RuntimeConfig } from './config.ts'
import type { Scheduler, Timer } from './events.ts'
import { INTERRUPTION, type FaultInjector } from './faults.ts'
import { formatDuration } from './java.ts'
import type { Log } from './log.ts'
import {
  finishAttempt,
  handleFailure,
  LOADED_GENERATORS,
  startAttempt,
  type Attempt,
  type GenerationContext,
  type ProcessorContext,
  type ProcessorCounters,
  type Result,
} from './processor.ts'
import { SqsException, type ReceivedMessage, type SqsQueue } from './queue.ts'
import type { Random } from './random.ts'
import type { ReportJobRepository } from './store.ts'
import type { Worker, WorkerSlot, WorkerState } from './types.ts'

export interface WorkerDeps {
  readonly scheduler: Scheduler
  readonly random: Random
  readonly repository: ReportJobRepository
  readonly queue: SqsQueue
  readonly backoff: BackoffPolicy
  readonly faults: FaultInjector
  readonly config: RuntimeConfig
  readonly log: Log
  readonly counters: ProcessorCounters
}

/** One job in flight: a thread of the pool, with its own copy of the job. */
interface Slot {
  readonly attempt: Attempt
  /** When the generation ends; a freeze pushes it back. */
  finishesAt: number
  timer: Timer | null
}

export class WorkerProcess {
  readonly id: string
  private readonly deps: WorkerDeps
  private readonly ctx: ProcessorContext
  private readonly generation: GenerationContext
  private status: WorkerState = 'stopped'
  private slots: Slot[] = []
  private pollTimer: Timer | null = null
  private longPoll: Timer | null = null
  private drainDeadline: number | null = null
  private drainTimer: Timer | null = null
  private frozenUntil: number | null = null
  private thawTimer: Timer | null = null
  private resumeAs: 'running' | 'draining' = 'running'
  private sigtermWhileFrozen = false
  private completedJobs = 0
  private failedJobs = 0
  private changes = 0
  private view: Worker | null = null

  constructor(id: string, deps: WorkerDeps) {
    this.id = id
    this.deps = deps
    this.ctx = {
      workerId: id,
      clock: deps.scheduler,
      repository: deps.repository,
      queue: deps.queue,
      backoff: deps.backoff,
      maxAttempts: deps.config.maxAttempts,
      staleLockAfterMs: deps.config.staleLockAfterMs,
      log: deps.log,
      counters: deps.counters,
    }
    this.generation = {
      faults: deps.faults,
      random: deps.random,
      generationMs: deps.config.generationMs,
    }
  }

  get revision(): number {
    return this.changes
  }

  /** A process starting: JobProcessor's constructor logs, then MessagePoller.start(). */
  start(): void {
    const { config, log } = this.deps
    this.status = 'running'
    this.slots = []
    log('INFO', null, LOADED_GENERATORS)
    log(
      'INFO',
      null,
      `Polling started (max-concurrent=${config.maxConcurrent}, batch-size=${config.batchSize}, drain-timeout=${formatDuration(config.drainTimeoutMs)})`
    )
    this.changed()
    this.poll()
  }

  /** A fresh process for a stopped or dead one; the lane's counters carry on. */
  restart(): void {
    if (this.status === 'stopped' || this.status === 'dead') this.start()
  }

  /** SIGKILL: no shutdown hook runs, so the jobs keep their locks and their messages stay hidden. */
  kill(): void {
    if (this.status === 'stopped' || this.status === 'dead') return
    this.cancelTimers()
    for (const slot of this.slots) slot.timer?.cancel()
    this.slots = []
    this.status = 'dead'
    this.frozenUntil = null
    this.drainDeadline = null
    this.sigtermWhileFrozen = false
    this.changed()
  }

  /**
   * A pause of the whole JVM (a long GC, a stall): nothing advances, then everything carries on
   * where it was, so each job finishes `ms` later. The drain deadline does not move, since
   * awaitTermination measures elapsed time, pause included.
   */
  freeze(ms: number): void {
    if (ms <= 0 || this.status === 'stopped' || this.status === 'dead') return
    const until = this.deps.scheduler.now + ms
    if (this.status === 'frozen') {
      const previous = this.frozenUntil ?? until
      if (until <= previous) return
      for (const slot of this.slots) slot.finishesAt += until - previous
      this.thawTimer?.cancel()
    } else {
      this.resumeAs = this.status
      this.status = 'frozen'
      this.cancelPolling()
      this.drainTimer?.cancel()
      this.drainTimer = null
      for (const slot of this.slots) {
        slot.timer?.cancel()
        slot.timer = null
        slot.finishesAt += ms
      }
    }
    this.frozenUntil = until
    this.thawTimer = this.deps.scheduler.at(until, () => this.thaw())
    this.changed()
  }

  /** SIGTERM: MessagePoller.stop(). A frozen JVM handles the signal once it runs again. */
  drain(): void {
    if (this.status === 'frozen') {
      if (this.resumeAs === 'running') this.sigtermWhileFrozen = true
      return
    }
    if (this.status !== 'running') return
    const { scheduler, config, log } = this.deps
    this.status = 'draining'
    this.cancelPolling()
    const timeout = formatDuration(config.drainTimeoutMs)
    log(
      'INFO',
      null,
      `Shutdown requested: ${this.slots.length} job(s) in flight, waiting up to ${timeout}`
    )
    // The poll thread is interrupted at once. Its receive is assumed to end with the interrupt, so
    // the hand-back of messages received while stopping never happens here.
    log('INFO', null, 'Polling stopped')
    this.changed()
    if (this.slots.length === 0) {
      this.drainComplete()
      return
    }
    this.drainDeadline = scheduler.now + config.drainTimeoutMs
    this.drainTimer = scheduler.at(this.drainDeadline, () => this.interruptAll())
  }

  snapshot(): Worker {
    if (this.view === null) {
      const slots: WorkerSlot[] = this.slots.map(({ attempt, finishesAt }) =>
        Object.freeze({
          jobId: attempt.job.id,
          startedAt: attempt.startedAt,
          finishesAt,
          attempt: attempt.job.attemptCount,
        })
      )
      this.view = Object.freeze({
        id: this.id,
        state: this.status,
        slots: Object.freeze(slots) as WorkerSlot[],
        maxConcurrent: this.deps.config.maxConcurrent,
        // The drain deadline is only set while draining, and a freeze shows when it ends.
        until: this.status === 'frozen' ? this.frozenUntil : this.drainDeadline,
        completed: this.completedJobs,
        failed: this.failedJobs,
      })
    }
    return this.view
  }

  /**
   * MessagePoller.pollLoop. A full worker sleeps idleWait and looks again. A receive that finds
   * nothing is a long poll: it returns when a message becomes visible, and an empty return is
   * followed by the next poll straight away, so the wait time itself never shows. With a wait
   * time of zero the worker sleeps idleWait after an empty receive instead.
   */
  private poll(): void {
    this.pollTimer = null
    const { scheduler, queue, config } = this.deps
    while (this.status === 'running') {
      const free = config.maxConcurrent - this.slots.length
      if (free === 0) {
        this.pollTimer = scheduler.at(scheduler.now + config.idleWaitMs, () => this.poll())
        return
      }
      const messages = queue.receive(Math.min(free, config.batchSize), this.id)
      if (messages.length === 0) {
        if (config.receiveWaitMs > 0) {
          this.longPoll = queue.waitForMessages(() => {
            this.longPoll = null
            this.poll()
          })
        } else {
          this.pollTimer = scheduler.at(scheduler.now + config.idleWaitMs, () => this.poll())
        }
        return
      }
      for (const message of messages) this.process(message)
    }
  }

  /** A pool thread taking a message: the attempt starts, and its generation takes time. */
  private process(message: ReceivedMessage): void {
    try {
      const started = startAttempt(this.ctx, this.generation, message)
      if (started === null) return
      if ('outcome' in started) {
        this.count(started)
        return
      }
      const slot: Slot = {
        attempt: started,
        finishesAt: started.startedAt + started.durationMs,
        timer: null,
      }
      slot.timer = this.deps.scheduler.at(slot.finishesAt, () => this.finish(slot))
      this.slots.push(slot)
      this.changed()
    } catch (error) {
      this.unhandled(error, message)
    }
  }

  private finish(slot: Slot): void {
    this.slots = this.slots.filter((other) => other !== slot)
    this.changed()
    try {
      this.count(finishAttempt(this.ctx, this.generation, slot.attempt))
    } catch (error) {
      this.unhandled(error, slot.attempt.message)
    }
    if (this.status === 'draining' && this.slots.length === 0) this.drainComplete()
  }

  /** The drain deadline: shutdownNow interrupts every job thread still running. */
  private interruptAll(): void {
    this.drainTimer = null
    const { config, log } = this.deps
    log(
      'WARN',
      null,
      `Drain deadline of ${formatDuration(config.drainTimeoutMs)} reached with ${this.slots.length} job(s) still running; interrupting them`
    )
    const interrupted = this.slots
    this.slots = []
    for (const { attempt, timer } of interrupted) {
      timer?.cancel()
      this.count(handleFailure(this.ctx, attempt.job, attempt.message, INTERRUPTION, true))
    }
    log('INFO', null, 'Interrupted jobs handed their messages back')
    this.stop()
  }

  private thaw(): void {
    const { scheduler } = this.deps
    this.thawTimer = null
    this.frozenUntil = null
    this.status = this.resumeAs
    for (const slot of this.slots) {
      slot.timer = scheduler.at(slot.finishesAt, () => this.finish(slot))
    }
    this.changed()
    if (this.status === 'draining' && this.drainDeadline !== null) {
      this.drainTimer = scheduler.at(this.drainDeadline, () => this.interruptAll())
    }
    if (this.sigtermWhileFrozen) {
      this.sigtermWhileFrozen = false
      this.drain()
    }
    if (this.status === 'running') this.poll()
  }

  private drainComplete(): void {
    this.deps.log('INFO', null, 'Drain complete: all in-flight jobs finished')
    this.stop()
  }

  private stop(): void {
    this.cancelTimers()
    this.status = 'stopped'
    this.drainDeadline = null
    this.changed()
  }

  /** MessagePoller.handle's catch: an SQS call that failed after the job's outcome was written. */
  private unhandled(error: unknown, message: ReceivedMessage): void {
    if (!(error instanceof SqsException)) throw error
    this.deps.log('ERROR', null, `Unhandled error processing message ${message.messageId}`)
  }

  private count(result: Result): void {
    if (!result.recorded) return
    if (result.outcome === 'COMPLETED') this.completedJobs++
    if (result.outcome === 'FAILED') this.failedJobs++
    this.changed()
  }

  private cancelPolling(): void {
    this.pollTimer?.cancel()
    this.pollTimer = null
    this.longPoll?.cancel()
    this.longPoll = null
  }

  private cancelTimers(): void {
    this.cancelPolling()
    this.drainTimer?.cancel()
    this.drainTimer = null
    this.thawTimer?.cancel()
    this.thawTimer = null
  }

  private changed(): void {
    this.changes++
    this.view = null
  }
}
