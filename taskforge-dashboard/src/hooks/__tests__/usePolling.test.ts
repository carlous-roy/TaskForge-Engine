import { describe, expect, it } from 'vitest'
import { diffEvents } from '../usePolling.ts'
import type { Job } from '../../sim/types.ts'

function job(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    type: 'SALES_SUMMARY',
    status: 'QUEUED',
    parameters: {},
    correlationId: 'abc123',
    idempotencyKey: null,
    errorMessage: null,
    attemptCount: 0,
    maxAttempts: 3,
    version: 0,
    lockedBy: null,
    fileKey: null,
    downloadUrl: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    nextAttemptAt: null,
    deadLetteredAt: null,
    executionTimeMs: 0,
    ...overrides,
  }
}

describe('diffEvents', () => {
  it('ignores the first answer and reports new and changed jobs after it', () => {
    const first = [job({ id: 'a' })]
    expect(diffEvents(null, first, 1, 1)).toEqual([])
    const next = [
      job({ id: 'b', correlationId: 'bbb' }),
      job({ id: 'a', status: 'COMPLETED', attemptCount: 1, executionTimeMs: 900 }),
    ]
    const lines = diffEvents(first, next, 5, 10)
    expect(lines.map((l) => [l.seq, l.level, l.source, l.cid])).toEqual([
      [10, 'INFO', 'worker', 'abc123'],
      [11, 'INFO', 'api', 'bbb'],
    ])
    expect(lines[0]?.message).toBe('Job a Queued to Completed (attempt 1/3) in 900 ms')
    expect(lines[1]?.message).toBe('Report submitted: SALES_SUMMARY b')
  })

  it('marks retries as warnings and failures as errors, with the reason', () => {
    const before = [job({ id: 'a', status: 'PROCESSING', attemptCount: 1 })]
    const retry = diffEvents(
      before,
      [job({ id: 'a', status: 'RETRY_SCHEDULED', attemptCount: 1, errorMessage: 'timed out' })],
      1,
      1
    )
    expect(retry[0]?.level).toBe('WARN')
    expect(retry[0]?.message).toContain(': timed out')
    const failed = diffEvents(before, [job({ id: 'a', status: 'FAILED', attemptCount: 3 })], 1, 1)
    expect(failed[0]?.level).toBe('ERROR')
  })

  it('reports nothing when nothing moved', () => {
    const same = [job({ id: 'a' })]
    expect(diffEvents(same, [job({ id: 'a' })], 1, 1)).toEqual([])
  })
})
