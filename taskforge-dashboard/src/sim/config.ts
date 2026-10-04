// The settings a simulation runs with. DEFAULT_CONFIG holds the defaults of
// taskforge-worker/src/main/resources/application.yml and taskforge-api/.../application.yml (they
// agree on every shared key), as bound into TaskForgeProperties; resolveConfig applies the same
// bounds as the properties' @Min and @Max, plus a few the simulated clock needs.

import type { SimConfig } from './types.ts'

export const DEFAULT_CONFIG: SimConfig = Object.freeze({
  // Two lanes, worker-1 and worker-2, so that one can take over from the other. The ids follow
  // WORKER_ID in docker-compose.yml, which itself starts a single worker.
  workers: 2,
  maxConcurrent: 3, // taskforge.worker.max-concurrent
  batchSize: 5, // taskforge.worker.batch-size
  idleWaitMs: 500, // taskforge.worker.idle-wait
  visibilityTimeoutS: 120, // taskforge.sqs.visibility-timeout
  maxAttempts: 3, // taskforge.retry.max-attempts, also the redrive policy's maxReceiveCount
  backoffBaseS: 2, // taskforge.retry.backoff.base
  backoffCapS: 60, // taskforge.retry.backoff.cap
  drainTimeoutS: 60, // taskforge.worker.drain-timeout
  staleLockAfterS: null, // taskforge.worker.stale-lock-after: unset, so the visibility timeout
  dlqPollIntervalS: 5, // taskforge.worker.dead-letter.poll-interval
  rateLimitPerMinute: 60, // taskforge.rate-limit.requests-per-minute
  generationMs: Object.freeze([600, 1800]) as [number, number],
  seed: 1,
  receiveWaitS: 10, // taskforge.sqs.wait-time in the worker's application.yml
})

/** The same settings in the units the code works in. */
export interface RuntimeConfig {
  readonly workers: number
  readonly maxConcurrent: number
  readonly batchSize: number
  readonly idleWaitMs: number
  /** The queue's VisibilityTimeout attribute, set from Duration.toSeconds(): whole seconds. */
  readonly visibilityTimeoutS: number
  readonly maxAttempts: number
  readonly backoffBaseS: number
  readonly backoffCapS: number
  readonly drainTimeoutMs: number
  /** JobProcessor's staleLockAfter: the configured value, or the visibility timeout as a Duration. */
  readonly staleLockAfterMs: number
  readonly dlqPollIntervalMs: number
  readonly rateLimitPerMinute: number
  readonly generationMs: readonly [number, number]
  readonly receiveWaitMs: number
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new RangeError(message)
}

function integerIn(name: string, value: number, min: number, max: number): void {
  check(
    Number.isInteger(value) && value >= min && value <= max,
    `${name} must be an integer from ${min} to ${max}, got ${value}`
  )
}

function finiteAtLeast(name: string, value: number, min: number): void {
  check(Number.isFinite(value) && value >= min, `${name} must be at least ${min}, got ${value}`)
}

/** The defaults with `overrides` applied and checked. */
export function resolveConfig(overrides: Partial<SimConfig> = {}): SimConfig {
  const d = DEFAULT_CONFIG
  const config: SimConfig = {
    workers: overrides.workers ?? d.workers,
    maxConcurrent: overrides.maxConcurrent ?? d.maxConcurrent,
    batchSize: overrides.batchSize ?? d.batchSize,
    idleWaitMs: overrides.idleWaitMs ?? d.idleWaitMs,
    visibilityTimeoutS: overrides.visibilityTimeoutS ?? d.visibilityTimeoutS,
    maxAttempts: overrides.maxAttempts ?? d.maxAttempts,
    backoffBaseS: overrides.backoffBaseS ?? d.backoffBaseS,
    backoffCapS: overrides.backoffCapS ?? d.backoffCapS,
    drainTimeoutS: overrides.drainTimeoutS ?? d.drainTimeoutS,
    staleLockAfterS: overrides.staleLockAfterS ?? d.staleLockAfterS,
    dlqPollIntervalS: overrides.dlqPollIntervalS ?? d.dlqPollIntervalS,
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? d.rateLimitPerMinute,
    generationMs: Object.freeze([...(overrides.generationMs ?? d.generationMs)]) as [
      number,
      number,
    ],
    seed: overrides.seed ?? d.seed,
    receiveWaitS: overrides.receiveWaitS ?? d.receiveWaitS ?? 10,
  }
  integerIn('workers', config.workers, 0, 64)
  integerIn('maxConcurrent', config.maxConcurrent, 1, 64)
  integerIn('batchSize', config.batchSize, 1, 10)
  // The simulated poll loop cannot spin in place, so the idle wait and the visibility timeout
  // need a floor of a millisecond and a second (zero is legal in the services).
  finiteAtLeast('idleWaitMs', config.idleWaitMs, 1)
  check(
    Number.isFinite(config.visibilityTimeoutS) &&
      config.visibilityTimeoutS >= 1 &&
      config.visibilityTimeoutS <= 43_200,
    `visibilityTimeoutS must be from 1 to 43200, got ${config.visibilityTimeoutS}`
  )
  integerIn('maxAttempts', config.maxAttempts, 1, 100)
  check(
    Number.isFinite(config.backoffBaseS) && Number.isFinite(config.backoffCapS),
    'backoffBaseS and backoffCapS must be finite'
  )
  finiteAtLeast('drainTimeoutS', config.drainTimeoutS, 0)
  if (config.staleLockAfterS !== null) finiteAtLeast('staleLockAfterS', config.staleLockAfterS, 0)
  finiteAtLeast('dlqPollIntervalS', config.dlqPollIntervalS, 0)
  integerIn('rateLimitPerMinute', config.rateLimitPerMinute, 1, Number.MAX_SAFE_INTEGER)
  const [minMs, maxMs] = config.generationMs
  check(
    config.generationMs.length === 2 &&
      Number.isInteger(minMs) &&
      Number.isInteger(maxMs) &&
      minMs >= 0 &&
      minMs <= maxMs,
    `generationMs must be two whole numbers [min, max] with 0 <= min <= max, got [${config.generationMs.join(', ')}]`
  )
  check(Number.isFinite(config.seed), `seed must be a finite number, got ${config.seed}`)
  const wait = config.receiveWaitS ?? 0
  check(wait >= 0 && wait <= 20, `receiveWaitS must be from 0 to 20, got ${wait}`)
  return Object.freeze(config)
}

const ms = (seconds: number): number => Math.round(seconds * 1000)

export function runtimeConfig(config: SimConfig): RuntimeConfig {
  return Object.freeze({
    workers: config.workers,
    maxConcurrent: config.maxConcurrent,
    batchSize: config.batchSize,
    idleWaitMs: Math.round(config.idleWaitMs),
    visibilityTimeoutS: Math.trunc(config.visibilityTimeoutS),
    maxAttempts: config.maxAttempts,
    backoffBaseS: config.backoffBaseS,
    backoffCapS: config.backoffCapS,
    drainTimeoutMs: ms(config.drainTimeoutS),
    staleLockAfterMs: ms(config.staleLockAfterS ?? config.visibilityTimeoutS),
    dlqPollIntervalMs: ms(config.dlqPollIntervalS),
    rateLimitPerMinute: config.rateLimitPerMinute,
    generationMs: config.generationMs,
    // QueueService passes min(20, wait.toSeconds()) as WaitTimeSeconds: whole seconds.
    receiveWaitMs: Math.trunc(config.receiveWaitS ?? 0) * 1000,
  })
}
