// The Simulation the console drives. It owns one simulated run (world.ts): the clock, the table,
// the queues, the API, the workers and the dead-letter consumer. Nothing in it reads the wall clock
// or Math.random, so the state after any sequence of commands depends only on the configuration,
// the seed and that sequence.

import { submitReport } from './api.ts'
import { resolveConfig } from './config.ts'
import type { FaultKind } from './faults.ts'
import type {
  HistoryPoint,
  Job,
  LogLine,
  QueueMessage,
  SimConfig,
  SimState,
  Stats,
  SubmitRequest,
  SubmitResult,
  Worker,
} from './types.ts'
import { createWorld, type World } from './world.ts'
import type { WorkerProcess } from './worker.ts'

export class Simulation {
  readonly config: SimConfig
  private seed: number
  private world: World
  private cachedState: { key: number; state: SimState } | null = null
  private cachedWorkers: { key: number; workers: Worker[] } | null = null
  private cachedStats: { key: number; stats: Stats } | null = null

  constructor(config: Partial<SimConfig> = {}) {
    this.config = resolveConfig(config)
    this.seed = this.config.seed
    this.world = createWorld(this.config, this.seed)
  }

  /**
   * An immutable snapshot, rebuilt only when something changed and otherwise the same object.
   * Its parts are shared between snapshots while they do not change, so comparing them by
   * reference tells what moved. In `stats`, `accepted` counts 202 answers; queued, processing,
   * retryScheduled, completed and failed count the jobs now in that status; the rest count events
   * since the start. `history.inFlight` is SQS's in-flight count (received or delayed messages).
   * Jobs are listed newest first, as the API lists them.
   */
  state(): SimState {
    const w = this.world
    const armed = w.faults.current()
    const key = this.revisionKey()
    if (this.cachedState !== null && this.cachedState.key === key) return this.cachedState.state
    const jobs = w.repository.findAll()
    const state: SimState = Object.freeze({
      time: w.loop.now,
      seed: this.seed,
      jobs: jobs as Job[],
      queue: w.queue.messages() as QueueMessage[],
      dlq: w.dlq.messages() as QueueMessage[],
      workers: this.workers(),
      log: w.log.snapshot() as LogLine[],
      stats: this.stats(jobs),
      history: w.history.snapshot() as HistoryPoint[],
      armed,
      rateWindow: Object.freeze(w.rateLimit.current(w.loop.now)),
    })
    this.cachedState = { key, state }
    return state
  }

  /**
   * Moves the clock forward by `ms`, running every event due in that window in time order. Any
   * fraction of a millisecond is carried to the next call, so frame deltas add up exactly.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ms must be a finite, non-negative number, got ${ms}`)
    }
    const w = this.world
    w.carry += ms
    const whole = Math.floor(w.carry + 1e-9)
    w.carry = Math.max(0, w.carry - whole)
    w.loop.runUntil(w.loop.now + whole)
  }

  /** POST /api/v1/reports from the simulation's one client, at the current time. */
  submit(request: SubmitRequest): SubmitResult {
    const w = this.world
    const result = submitReport(w.api, request)
    if (result.status === 202) w.counters.accepted++
    if (result.status === 409) w.counters.rejectedDuplicates++
    if (result.status === 429) w.counters.rateLimited++
    return result
  }

  /**
   * The next job a worker starts fails every attempt with a transient error (an S3 upload
   * timeout), or once with a permanent one (bad parameters), until disarmed with null.
   */
  arm(kind: FaultKind | null): void {
    this.world.faults.arm(kind)
  }

  /** The process dies: its in-flight jobs keep their locks and their messages stay invisible. */
  killWorker(id: string): void {
    this.worker(id).kill()
  }

  /** The process stops making progress for `seconds` without dying, then carries on. */
  freezeWorker(id: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError(`seconds must be a finite, non-negative number, got ${seconds}`)
    }
    this.worker(id).freeze(Math.round(seconds * 1000))
  }

  /** SIGTERM: no new receives, in-flight jobs finish or are interrupted at the drain timeout. */
  drainWorker(id: string): void {
    this.worker(id).drain()
  }

  /** A stopped or dead worker comes back with a fresh process. */
  restartWorker(id: string): void {
    this.worker(id).restart()
  }

  /** `n` submissions in the same instant. */
  burst(n: number, request: SubmitRequest): SubmitResult[] {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a whole number, got ${n}`)
    return Array.from({ length: n }, () => this.submit(request))
  }

  /** Fresh state, same config; the seed in use unless a new one is given. */
  reset(seed?: number): void {
    if (seed !== undefined && !Number.isFinite(seed)) {
      throw new RangeError(`seed must be a finite number, got ${seed}`)
    }
    this.seed = seed ?? this.seed
    this.world = createWorld(this.config, this.seed)
    this.cachedState = null
    this.cachedWorkers = null
    this.cachedStats = null
  }

  private worker(id: string): WorkerProcess {
    const worker = this.world.workers.find((candidate) => candidate.id === id)
    if (worker === undefined) {
      const ids = this.world.workers.map((candidate) => candidate.id).join(', ')
      throw new RangeError(`no worker ${id}; the workers are ${ids || 'none'}`)
    }
    return worker
  }

  /** Every part only ever counts up, so the sum changes exactly when something changed. */
  private revisionKey(): number {
    const w = this.world
    let key =
      w.loop.now +
      w.repository.revision +
      w.queue.revision +
      w.dlq.revision +
      w.log.revision +
      w.history.revision +
      w.faults.revision +
      w.rateLimit.revision
    for (const worker of w.workers) key += worker.revision
    for (const count of Object.values(w.counters)) key += count
    return key
  }

  private workers(): Worker[] {
    let key = 0
    for (const worker of this.world.workers) key += worker.revision
    if (this.cachedWorkers === null || this.cachedWorkers.key !== key) {
      const workers = this.world.workers.map((worker) => worker.snapshot())
      this.cachedWorkers = { key, workers: Object.freeze(workers) as Worker[] }
    }
    return this.cachedWorkers.workers
  }

  private stats(jobs: readonly Readonly<Job>[]): Stats {
    const c = this.world.counters
    let key = this.world.repository.revision
    for (const count of Object.values(c)) key += count
    if (this.cachedStats !== null && this.cachedStats.key === key) return this.cachedStats.stats
    const stats: Stats = {
      accepted: c.accepted,
      queued: 0,
      processing: 0,
      retryScheduled: 0,
      completed: 0,
      failed: 0,
      deadLettered: c.deadLettered,
      rejectedDuplicates: c.rejectedDuplicates,
      rateLimited: c.rateLimited,
      takeovers: c.takeovers,
      staleWritesDiscarded: c.staleWritesDiscarded,
    }
    for (const job of jobs) {
      if (job.status === 'QUEUED') stats.queued++
      else if (job.status === 'PROCESSING') stats.processing++
      else if (job.status === 'RETRY_SCHEDULED') stats.retryScheduled++
      else if (job.status === 'COMPLETED') stats.completed++
      else if (job.status === 'FAILED') stats.failed++
    }
    this.cachedStats = { key, stats: Object.freeze(stats) }
    return this.cachedStats.stats
  }
}
