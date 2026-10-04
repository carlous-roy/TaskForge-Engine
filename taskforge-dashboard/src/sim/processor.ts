// com.taskforge.worker.service.JobProcessor and FailureClassifier: what one worker does with one
// delivered message. startAttempt runs JobProcessor.process up to the generator call (acquire
// loads, checks and locks the job); finishAttempt runs the rest, through complete or
// handleFailure. The time in between belongs to the worker process (worker.ts), which is what
// lets a process be interrupted, frozen or killed in the middle of a job.

import type { BackoffPolicy } from './backoff.ts'
import type { Clock } from './events.ts'
import { UPLOAD_TIMEOUT, type Failure, type FaultInjector } from './faults.ts'
import { completeLine, drawCsvBytes, generatingLine } from './generators.ts'
import { formatInstant, isBlank } from './java.ts'
import {
  isLockStale,
  isTerminal,
  markCompleted,
  markFailed,
  markProcessing,
  markRetryScheduled,
} from './job.ts'
import type { Log } from './log.ts'
import { InvalidReportParametersException, ReportParameters } from './parameters.ts'
import { SqsException, type ReceivedMessage, type SqsQueue } from './queue.ts'
import type { Random } from './random.ts'
import { StaleJobException, type ReportJobRepository } from './store.ts'
import type { Job } from './types.ts'

/** taskforge.s3.bucket, for StorageService's upload line. */
export const BUCKET = 'taskforge-reports'

/** What JobProcessor's constructor logs: the keys of its EnumMap of generators. */
export const LOADED_GENERATORS =
  'Loaded 3 report generators: [SALES_SUMMARY, INVENTORY_SNAPSHOT, USER_ACTIVITY]'

/** JobProcessor.Outcome. */
export type Outcome = 'COMPLETED' | 'RETRY_SCHEDULED' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED'

/** FailureClassifier.Kind. */
export type FailureKind = 'INTERRUPTED' | 'PERMANENT' | 'TRANSIENT'

export interface ProcessorCounters {
  takeovers: number
  staleWritesDiscarded: number
}

export interface ProcessorContext {
  /** WorkerIdentity.id(), written into lockedBy. */
  readonly workerId: string
  readonly clock: Clock
  readonly repository: ReportJobRepository
  readonly queue: SqsQueue
  readonly backoff: BackoffPolicy
  readonly maxAttempts: number
  readonly staleLockAfterMs: number
  readonly log: Log
  readonly counters: ProcessorCounters
}

/** The Java's outcome, and whether this worker's write of it went through. */
export interface Result {
  readonly outcome: Outcome
  readonly recorded: boolean
}

/** What generating a report draws on: the injected faults, the generator, the time it takes. */
export interface GenerationContext {
  readonly faults: FaultInjector
  readonly random: Random
  readonly generationMs: readonly [number, number]
}

/** What a job thread holds while its report is generated. */
export interface Attempt {
  readonly message: ReceivedMessage
  readonly job: Job
  readonly startedAt: number
  readonly durationMs: number
  readonly bytes: number
}

/**
 * FailureClassifier.classify for the failures the simulation produces. The interrupt flag is
 * checked first, as in the Java; then bad parameters are PERMANENT and an SdkClientException
 * (a timeout, a reset connection) is TRANSIENT.
 */
export function classify(failure: Failure, interrupted: boolean): FailureKind {
  if (interrupted || failure.exception === 'InterruptedException') return 'INTERRUPTED'
  return failure.exception === 'InvalidReportParametersException' ? 'PERMANENT' : 'TRANSIENT'
}

/** JobProcessor.describe: the message (the class name if it has none), at most 500 chars. */
function describe(failure: Failure): string {
  const message = isBlank(failure.message) ? failure.exception : failure.message
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}

/**
 * JobProcessor.acquire: loads the job and moves it to PROCESSING under this worker's name, or
 * returns null when the delivery should not be processed. A lock lost to a concurrent write is
 * retried on a fresh copy, up to three times.
 */
export function acquire(ctx: ProcessorContext, message: ReceivedMessage): Job | null {
  const { log, queue, repository } = ctx
  let cid = message.correlationId
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = repository.findById(message.jobId)
    if (job === undefined) {
      log(
        'WARN',
        cid,
        `Job ${message.jobId} does not exist; discarding message ${message.messageId}`
      )
      queue.delete(message.receiptHandle)
      return null
    }
    cid = job.correlationId
    const now = ctx.clock.now
    if (isTerminal(job.status)) {
      log('INFO', cid, `Job ${job.id} is already ${job.status}; discarding duplicate delivery`)
      queue.delete(message.receiptHandle)
      return null
    }
    const takeover = job.status === 'PROCESSING'
    if (takeover) {
      const since = formatInstant(job.updatedAt)
      if (!isLockStale(job, now, ctx.staleLockAfterMs)) {
        log(
          'INFO',
          cid,
          `Job ${job.id} is being processed by ${job.lockedBy} since ${since}; leaving the message for redelivery`
        )
        return null
      }
      log(
        'WARN',
        cid,
        `Job ${job.id} was left PROCESSING by ${job.lockedBy} at ${since}; taking it over`
      )
    }
    markProcessing(job, ctx.workerId, now)
    try {
      repository.update(job)
      if (takeover) ctx.counters.takeovers++
      return job
    } catch (error) {
      if (!(error instanceof StaleJobException)) throw error
      log('INFO', cid, `Job ${job.id} changed while locking it (try ${attempt} of 3); reloading`)
    }
  }
  log('WARN', cid, `Job ${message.jobId} kept changing; leaving the message for redelivery`)
  return null
}

/** JobProcessor.tryUpdate: writes the job, or discards this worker's result if it is stale. */
export function tryUpdate(ctx: ProcessorContext, job: Job): boolean {
  try {
    ctx.repository.update(job)
    return true
  } catch (error) {
    if (!(error instanceof StaleJobException)) throw error
    ctx.log(
      'WARN',
      job.correlationId,
      `Job ${job.id} was modified by another process; this worker's result is discarded and the message left alone`
    )
    ctx.counters.staleWritesDiscarded++
    return false
  }
}

/** The end of a successful attempt: StorageService.upload, COMPLETED, and the message deleted. */
export function complete(
  ctx: ProcessorContext,
  job: Job,
  message: ReceivedMessage,
  startedAt: number,
  bytes: number
): Result {
  const fileKey = `reports/${job.type.toLowerCase()}/${job.id}.csv`
  ctx.log('INFO', job.correlationId, `Uploaded s3://${BUCKET}/${fileKey} (${bytes} bytes)`)
  const now = ctx.clock.now
  const elapsedMs = now - startedAt
  markCompleted(job, fileKey, elapsedMs, now)
  if (!tryUpdate(ctx, job)) return { outcome: 'SKIPPED', recorded: false }
  ctx.queue.delete(message.receiptHandle)
  ctx.log('INFO', job.correlationId, `Job ${job.id} completed in ${elapsedMs} ms: ${fileKey}`)
  return { outcome: 'COMPLETED', recorded: true }
}

/** JobProcessor.handleFailure: what a failed attempt means for the job and its message. */
export function handleFailure(
  ctx: ProcessorContext,
  job: Job,
  message: ReceivedMessage,
  failure: Failure,
  interrupted: boolean
): Result {
  const { log, queue } = ctx
  const kind = classify(failure, interrupted)
  const reason = describe(failure)
  const now = ctx.clock.now
  const attempt = job.attemptCount
  const cid = job.correlationId
  switch (kind) {
    case 'INTERRUPTED': {
      log(
        'WARN',
        cid,
        `Attempt ${attempt} of job ${job.id} interrupted by shutdown; releasing the message`
      )
      markRetryScheduled(job, `Attempt ${attempt} was interrupted by a worker shutdown`, now, now)
      let recorded = false
      try {
        recorded = tryUpdate(ctx, job)
        if (recorded) queue.changeVisibility(message.receiptHandle, 0)
      } catch (error) {
        if (!(error instanceof SqsException)) throw error
        log(
          'ERROR',
          cid,
          `Could not hand job ${job.id} back after the interrupt; it will be redelivered after the visibility timeout`
        )
      }
      return { outcome: 'INTERRUPTED', recorded }
    }
    case 'PERMANENT': {
      log(
        'ERROR',
        cid,
        `Attempt ${attempt} of job ${job.id} failed with a non-retryable error: ${reason}`
      )
      markFailed(job, `Attempt ${attempt} failed with a non-retryable error: ${reason}`, now)
      const recorded = tryUpdate(ctx, job)
      if (recorded) queue.delete(message.receiptHandle)
      return { outcome: 'FAILED', recorded }
    }
    case 'TRANSIENT': {
      // The delivery count from SQS is trusted over the job's own counter.
      const deliveries = Math.max(message.receiveCount, attempt)
      if (deliveries < ctx.maxAttempts) {
        const delaySeconds = ctx.backoff.delaySeconds(deliveries)
        const window = ctx.backoff.upperBoundSeconds(deliveries)
        log(
          'WARN',
          cid,
          `Attempt ${attempt} of job ${job.id} failed (${reason}); retry in ${delaySeconds} s (window 0-${window} s)`
        )
        markRetryScheduled(
          job,
          `Attempt ${attempt} failed: ${reason}`,
          now + delaySeconds * 1000,
          now
        )
        const recorded = tryUpdate(ctx, job)
        if (recorded) queue.changeVisibility(message.receiptHandle, delaySeconds)
        return { outcome: 'RETRY_SCHEDULED', recorded }
      }
      log(
        'ERROR',
        cid,
        `Attempt ${attempt} of ${ctx.maxAttempts} for job ${job.id} failed (${reason}); no attempts left, message goes to the dead-letter queue`
      )
      markFailed(
        job,
        `Attempt ${attempt} of ${ctx.maxAttempts} failed: ${reason}. No attempts left; the message was sent to the dead-letter queue.`,
        now
      )
      const recorded = tryUpdate(ctx, job)
      if (recorded) queue.changeVisibility(message.receiptHandle, 0)
      return { outcome: 'FAILED', recorded }
    }
  }
}

/**
 * JobProcessor.process up to the generator call: acquire, the parameter re-check and the
 * generator's first line. Gives the attempt to generate, the Result of one that ended at once
 * (parameters the re-check rejects), or null for a delivery that is not processed.
 */
export function startAttempt(
  ctx: ProcessorContext,
  generation: GenerationContext,
  message: ReceivedMessage
): Attempt | Result | null {
  const job = acquire(ctx, message)
  if (job === null) return null
  const cid = job.correlationId
  ctx.log(
    'INFO',
    cid,
    `Processing ${job.type} job ${job.id} (attempt ${job.attemptCount}/${job.maxAttempts}, delivery ${message.receiveCount})`
  )
  const startedAt = ctx.clock.now
  let parameters: ReportParameters
  try {
    parameters = ReportParameters.of(job.type, generation.faults.parametersFor(job))
  } catch (error) {
    if (!(error instanceof InvalidReportParametersException)) throw error
    const failure: Failure = {
      exception: 'InvalidReportParametersException',
      message: error.message,
    }
    return handleFailure(ctx, job, message, failure, false)
  }
  ctx.log('INFO', cid, generatingLine(job.type, parameters, startedAt))
  const [min, max] = generation.generationMs
  const durationMs = min + generation.random.nextInt(max - min)
  return { message, job, startedAt, durationMs, bytes: drawCsvBytes(generation.random) }
}

/** The rest of JobProcessor.process, once the CSV is built: the upload and the outcome. */
export function finishAttempt(
  ctx: ProcessorContext,
  generation: GenerationContext,
  attempt: Attempt
): Result {
  const { job, message } = attempt
  ctx.log('INFO', job.correlationId, completeLine(job.type, attempt.bytes))
  if (generation.faults.uploadFails(job.id)) {
    return handleFailure(ctx, job, message, UPLOAD_TIMEOUT, false)
  }
  return complete(ctx, job, message, attempt.startedAt, attempt.bytes)
}
