// Tests for job.ts, the ReportJob state machine, after ReportJobTest; plus the boundary of
// isLockStale, which is strict in the Java (Instant.isBefore).

import { describe, expect, it } from 'vitest'
import {
  canRetry,
  createJob,
  isLockStale,
  markCompleted,
  markDeadLettered,
  markFailed,
  markProcessing,
  markQueued,
  markRetryScheduled,
} from './job.ts'
import type { Job } from './types.ts'

const T0 = 0
const newJob = (): Job =>
  createJob('job-1', 'SALES_SUMMARY', { region: 'North' }, 'cid123', 'key-1', 3, T0)

describe('ReportJob', () => {
  it('starts ACCEPTED at version 0', () => {
    expect(newJob()).toMatchObject({
      status: 'ACCEPTED',
      version: 0,
      attemptCount: 0,
      maxAttempts: 3,
      parameters: { region: 'North' },
      correlationId: 'cid123',
      idempotencyKey: 'key-1',
      createdAt: T0,
      updatedAt: T0,
    })
  })

  it('walks the happy path', () => {
    const job = newJob()
    markQueued(job, 1_000)
    expect(job.status).toBe('QUEUED')
    markProcessing(job, 'worker-a', 2_000)
    expect(job).toMatchObject({ status: 'PROCESSING', attemptCount: 1, lockedBy: 'worker-a' })
    markCompleted(job, 'reports/x.csv', 150, 3_000)
    expect(job).toMatchObject({
      status: 'COMPLETED',
      fileKey: 'reports/x.csv',
      executionTimeMs: 150,
      completedAt: 3_000,
      lockedBy: null,
    })
  })

  it('picks a scheduled retry up again', () => {
    const job = newJob()
    markQueued(job, T0)
    markProcessing(job, 'worker-a', T0)
    markRetryScheduled(job, 'boom', 5_000, T0)
    expect(job).toMatchObject({
      status: 'RETRY_SCHEDULED',
      errorMessage: 'boom',
      nextAttemptAt: 5_000,
    })
    expect(canRetry(job)).toBe(true)
    markProcessing(job, 'worker-b', 5_000)
    expect(job).toMatchObject({ attemptCount: 2, nextAttemptAt: null })
  })

  it('can retry until the budget is spent', () => {
    const job = newJob()
    markQueued(job, T0)
    for (let i = 1; i <= 3; i++) {
      markProcessing(job, 'w', T0)
      expect(canRetry(job)).toBe(i < 3)
      markRetryScheduled(job, 'e', T0, T0)
    }
  })

  it('rejects transitions out of a terminal state, with the Java messages', () => {
    const job = newJob()
    markQueued(job, T0)
    markProcessing(job, 'w', T0)
    markFailed(job, 'bad input', T0)
    expect(job).toMatchObject({ status: 'FAILED', completedAt: T0 })
    expect(() => markProcessing(job, 'w', T0)).toThrow(
      'Cannot start processing job job-1 in status FAILED'
    )
    expect(() => markFailed(job, 'again', T0)).toThrow(
      'Cannot fail job job-1 in terminal status FAILED'
    )
    expect(() => markCompleted(job, 'f', 1, T0)).toThrow('Job job-1 is FAILED, expected PROCESSING')
  })

  it('completes or schedules retries only from PROCESSING, and queues only from ACCEPTED', () => {
    const job = newJob()
    expect(() => markCompleted(job, 'f', 1, T0)).toThrow(
      'Job job-1 is ACCEPTED, expected PROCESSING'
    )
    expect(() => markRetryScheduled(job, 'e', T0, T0)).toThrow(
      'Job job-1 is ACCEPTED, expected PROCESSING'
    )
    markQueued(job, T0)
    expect(() => markQueued(job, T0)).toThrow('Job job-1 is QUEUED, expected ACCEPTED')
  })

  it('calls a lock stale only once it is strictly older than the limit', () => {
    const job = newJob()
    markQueued(job, T0)
    expect(isLockStale(job, 1_000_000, 120_000)).toBe(false)
    markProcessing(job, 'w', T0)
    expect(isLockStale(job, 60_000, 120_000)).toBe(false)
    expect(isLockStale(job, 120_000, 120_000)).toBe(false)
    expect(isLockStale(job, 120_001, 120_000)).toBe(true)
  })

  it('stamps the dead-lettering', () => {
    const job = newJob()
    markQueued(job, T0)
    markProcessing(job, 'w', T0)
    markFailed(job, 'x', T0)
    markDeadLettered(job, 9_000)
    expect(job).toMatchObject({ deadLetteredAt: 9_000, updatedAt: 9_000 })
  })
})
