// Everything one simulated run consists of, built from a configuration and a seed and started at
// time 0: the clock, the generator, the log, the DynamoDB table, the queue and its dead-letter
// queue, the API, the worker processes and the dead-letter consumer, with the counters and the
// history the console plots. The names of the table and queues are the application.yml defaults.

import { RateLimitFilter, type ApiContext } from './api.ts'
import { BackoffPolicy } from './backoff.ts'
import { runtimeConfig } from './config.ts'
import { DeadLetterConsumer } from './deadLetter.ts'
import { EventLoop } from './events.ts'
import { FaultInjector } from './faults.ts'
import { isTerminal } from './job.ts'
import { LogBuffer } from './log.ts'
import { SqsQueue } from './queue.ts'
import { Random } from './random.ts'
import { ReportJobRepository } from './store.ts'
import type { HistoryPoint, SimConfig } from './types.ts'
import { WorkerProcess } from './worker.ts'

/** One point per simulated second is kept for the last hour; older points are dropped. */
export const HISTORY_LIMIT = 3_600
const SAMPLE_EVERY_MS = 1_000
/** The dead-letter queue is created without a VisibilityTimeout, so it has SQS's default. */
const DLQ_VISIBILITY_TIMEOUT_S = 30

/** The cumulative counters behind Stats. */
export interface Counters {
  accepted: number
  rejectedDuplicates: number
  rateLimited: number
  deadLettered: number
  takeovers: number
  staleWritesDiscarded: number
}

export class History {
  private points: HistoryPoint[] = []
  private view: readonly HistoryPoint[] | null = null
  private samples = 0

  get revision(): number {
    return this.samples
  }

  record(point: HistoryPoint): void {
    this.points.push(Object.freeze(point))
    if (this.points.length >= 2 * HISTORY_LIMIT) this.points = this.points.slice(-HISTORY_LIMIT)
    this.samples++
    this.view = null
  }

  snapshot(): readonly HistoryPoint[] {
    if (this.view === null) this.view = Object.freeze(this.points.slice(-HISTORY_LIMIT))
    return this.view
  }
}

export interface World {
  readonly loop: EventLoop
  readonly log: LogBuffer
  readonly repository: ReportJobRepository
  readonly queue: SqsQueue
  readonly dlq: SqsQueue
  readonly workers: readonly WorkerProcess[]
  readonly rateLimit: RateLimitFilter
  readonly faults: FaultInjector
  readonly counters: Counters
  readonly api: ApiContext
  readonly history: History
  /** The fraction of a millisecond advance() has been given but not yet run. */
  carry: number
}

export function createWorld(config: SimConfig, seed: number): World {
  const runtime = runtimeConfig(config)
  const loop = new EventLoop()
  const random = new Random(seed)
  const log = new LogBuffer(loop)
  const sqsLog = log.writer('sqs')
  const counters: Counters = {
    accepted: 0,
    rejectedDuplicates: 0,
    rateLimited: 0,
    deadLettered: 0,
    takeovers: 0,
    staleWritesDiscarded: 0,
  }
  const repository = new ReportJobRepository()
  const dlq = new SqsQueue({
    name: 'taskforge-reports-dlq',
    visibilityTimeoutS: DLQ_VISIBILITY_TIMEOUT_S,
    maxReceiveCount: null,
    deadLetterQueue: null,
    scheduler: loop,
    random,
    log: sqsLog,
  })
  const queue = new SqsQueue({
    name: 'taskforge-reports',
    visibilityTimeoutS: runtime.visibilityTimeoutS,
    maxReceiveCount: runtime.maxAttempts,
    deadLetterQueue: dlq,
    scheduler: loop,
    random,
    log: sqsLog,
    onRedrive: () => {
      counters.deadLettered++
    },
  })
  const backoff = new BackoffPolicy(runtime.backoffBaseS, runtime.backoffCapS, random)
  const faults = new FaultInjector((jobId) => {
    const job = repository.record(jobId)
    return job === undefined || isTerminal(job.status)
  })
  const rateLimit = new RateLimitFilter(runtime.rateLimitPerMinute)
  const api: ApiContext = {
    clock: loop,
    random,
    repository,
    rateLimit,
    maxAttempts: runtime.maxAttempts,
    enqueue: (jobId, correlationId) => queue.send(jobId, correlationId),
    log: log.writer('api'),
  }
  const workers = Array.from({ length: runtime.workers }, (_, index) => {
    const id = `worker-${index + 1}`
    return new WorkerProcess(id, {
      scheduler: loop,
      random,
      repository,
      queue,
      backoff,
      faults,
      config: runtime,
      log: log.writer(id),
      counters,
    })
  })
  const deadLetterConsumer = new DeadLetterConsumer({
    scheduler: loop,
    dlq,
    repository,
    pollIntervalMs: runtime.dlqPollIntervalMs,
    log: log.writer('dlq'),
  })
  const history = new History()
  const world: World = {
    loop,
    log,
    repository,
    queue,
    dlq,
    workers,
    rateLimit,
    faults,
    counters,
    api,
    history,
    carry: 0,
  }
  for (const worker of workers) worker.start()
  deadLetterConsumer.start()
  sample(world, 0)
  return world
}

/** A history point at `t`, taken after everything else due in that millisecond, then the next. */
function sample(world: World, t: number): void {
  world.loop.at(
    t,
    () => {
      world.history.record({
        t,
        queueDepth: world.queue.visibleCount(),
        inFlight: world.queue.inFlightCount(),
        dlqDepth: world.dlq.size(),
      })
      sample(world, t + SAMPLE_EVERY_MS)
    },
    1
  )
}
