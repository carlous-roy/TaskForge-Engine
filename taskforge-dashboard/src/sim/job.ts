// com.taskforge.common.model.ReportJob and com.taskforge.common.enums.ReportStatus: the job record
// and the transitions that enforce its state machine. Each function changes the caller's copy, as
// the Java methods change `this`; only ReportJobRepository.update makes a change durable, and only
// when the stored version is still the one the copy was loaded with.

import type { Job, ReportStatus, ReportType } from './types.ts'

const CAN_START_PROCESSING: ReadonlySet<ReportStatus> = new Set<ReportStatus>([
  'ACCEPTED',
  'QUEUED',
  'RETRY_SCHEDULED',
  'PROCESSING',
])

/** ReportStatus.isTerminal. */
export function isTerminal(status: ReportStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED'
}

/**
 * ReportJob.create. The record's 24-hour TTL is left out: DynamoDB would remove the job a day
 * later, and no simulated run lasts that long.
 */
export function createJob(
  id: string,
  type: ReportType,
  parameters: Readonly<Record<string, string>>,
  correlationId: string,
  idempotencyKey: string | null,
  maxAttempts: number,
  now: number
): Job {
  return {
    id,
    type,
    status: 'ACCEPTED',
    parameters: { ...parameters },
    correlationId,
    idempotencyKey,
    errorMessage: null,
    attemptCount: 0,
    maxAttempts,
    version: 0,
    lockedBy: null,
    fileKey: null,
    downloadUrl: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    executionTimeMs: 0,
  }
}

/** A copy the caller may change without touching the original (a record read back from the table). */
export function copyJob(job: Readonly<Job>): Job {
  return { ...job, parameters: { ...job.parameters } }
}

function requireStatus(job: Job, expected: ReportStatus): void {
  if (job.status !== expected) {
    throw new Error(`Job ${job.id} is ${job.status}, expected ${expected}`)
  }
}

/** ACCEPTED -> QUEUED, once the SQS message has been sent. */
export function markQueued(job: Job, now: number): void {
  requireStatus(job, 'ACCEPTED')
  job.status = 'QUEUED'
  job.updatedAt = now
}

/** A worker takes the job: from ACCEPTED, QUEUED or RETRY_SCHEDULED, or from PROCESSING when the holder is judged dead. */
export function markProcessing(job: Job, workerId: string, now: number): void {
  if (!CAN_START_PROCESSING.has(job.status)) {
    throw new Error(`Cannot start processing job ${job.id} in status ${job.status}`)
  }
  job.status = 'PROCESSING'
  job.attemptCount++
  job.lockedBy = workerId
  job.nextAttemptAt = null
  job.updatedAt = now
}

/** PROCESSING -> RETRY_SCHEDULED: SQS redelivers the message at `nextAttemptAt`. */
export function markRetryScheduled(
  job: Job,
  error: string,
  nextAttemptAt: number,
  now: number
): void {
  requireStatus(job, 'PROCESSING')
  job.status = 'RETRY_SCHEDULED'
  job.errorMessage = error
  job.nextAttemptAt = nextAttemptAt
  job.lockedBy = null
  job.updatedAt = now
}

/** PROCESSING -> COMPLETED. */
export function markCompleted(
  job: Job,
  fileKey: string,
  executionTimeMs: number,
  now: number
): void {
  requireStatus(job, 'PROCESSING')
  job.status = 'COMPLETED'
  job.fileKey = fileKey
  job.executionTimeMs = executionTimeMs
  job.errorMessage = null
  job.lockedBy = null
  job.nextAttemptAt = null
  job.completedAt = now
  job.updatedAt = now
}

/** Any non-terminal status -> FAILED. */
export function markFailed(job: Job, error: string, now: number): void {
  if (isTerminal(job.status)) {
    throw new Error(`Cannot fail job ${job.id} in terminal status ${job.status}`)
  }
  job.status = 'FAILED'
  job.errorMessage = error
  job.lockedBy = null
  job.nextAttemptAt = null
  job.completedAt = now
  job.updatedAt = now
}

/** Records that the job's SQS message reached the dead-letter queue. */
export function markDeadLettered(job: Job, now: number): void {
  job.deadLetteredAt = now
  job.updatedAt = now
}

/** ReportJob.canRetry. */
export function canRetry(job: Readonly<Job>): boolean {
  return job.attemptCount < job.maxAttempts
}

/**
 * True when the job is PROCESSING and nothing has touched it for longer than `staleAfterMs`.
 * Strictly longer, as Instant.isBefore is strict: a lock exactly that old is still held.
 */
export function isLockStale(job: Readonly<Job>, now: number, staleAfterMs: number): boolean {
  return job.status === 'PROCESSING' && job.updatedAt + staleAfterMs < now
}
