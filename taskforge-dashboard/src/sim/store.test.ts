// Tests for store.ts, ReportJobRepository: the idempotency transaction with its KEY# marker, the
// version condition on every update, and the records it hands out. Several cases follow
// ReportJobRepositoryIT.

import { describe, expect, it } from 'vitest'
import { createJob, markCompleted, markProcessing, markQueued, markRetryScheduled } from './job.ts'
import {
  DuplicateReportException,
  KEY_PREFIX,
  ReportJobRepository,
  StaleJobException,
} from './store.ts'
import type { Job } from './types.ts'

let nextId = 0
function job(key: string | null, createdAt = 0): Job {
  nextId++
  const id = `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`
  return createJob(id, 'SALES_SUMMARY', { region: 'North' }, `cid-${nextId}`, key, 3, createdAt)
}

describe('ReportJobRepository', () => {
  it('stores version 0, then bumps the stored version and the copy once per write', () => {
    const repository = new ReportJobRepository()
    const created = job('rt-1')
    repository.create(created)
    expect(repository.findById(created.id)?.version).toBe(0)

    markQueued(created, 1)
    repository.update(created)
    markProcessing(created, 'worker-x', 2)
    repository.update(created)
    markRetryScheduled(created, 'timeout', 9, 3)
    repository.update(created)

    expect(created.version).toBe(3)
    expect(repository.findById(created.id)).toMatchObject({
      status: 'RETRY_SCHEDULED',
      version: 3,
      attemptCount: 1,
      errorMessage: 'timeout',
      nextAttemptAt: 9,
      lockedBy: null,
      idempotencyKey: 'rt-1',
      createdAt: 0,
    })
  })

  it('refuses a stale writer and leaves its copy at the version it loaded', () => {
    const repository = new ReportJobRepository()
    const created = job(null)
    repository.create(created)
    markQueued(created, 0)
    repository.update(created)

    const workerA = repository.findById(created.id) as Job
    const workerB = repository.findById(created.id) as Job
    markProcessing(workerA, 'a', 0)
    repository.update(workerA)
    markCompleted(workerA, 'reports/a.csv', 5, 0)
    repository.update(workerA)

    markProcessing(workerB, 'b', 0)
    expect(() => repository.update(workerB)).toThrow(new StaleJobException(created.id, 1).message)
    expect(() => repository.update(workerB)).toThrow(StaleJobException)
    expect(workerB.version).toBe(1)
    expect(repository.findById(created.id)).toMatchObject({
      status: 'COMPLETED',
      fileKey: 'reports/a.csv',
    })
  })

  it('rejects a second job with the same key and names the job that owns it', () => {
    const repository = new ReportJobRepository()
    const first = job('dup-1')
    repository.create(first)
    const second = job('dup-1')
    expect(() => repository.create(second)).toThrow(DuplicateReportException)
    try {
      repository.create(second)
    } catch (error) {
      expect((error as DuplicateReportException).existingId).toBe(first.id)
      expect((error as Error).message).toBe(
        `Duplicate report request with key 'dup-1' (existing report ${first.id})`
      )
    }
    expect(repository.findJobIdByIdempotencyKey('dup-1')).toBe(first.id)
    expect(repository.findById(second.id)).toBeUndefined()
  })

  it('refuses to reuse a job id, with or without a key', () => {
    const repository = new ReportJobRepository()
    const keyed = job('k-1')
    repository.create(keyed)
    expect(() => repository.create({ ...keyed, idempotencyKey: 'k-2' })).toThrow(
      `Job id collision for ${keyed.id}`
    )
    const plain = job(null)
    repository.create(plain)
    expect(() => repository.create(plain)).toThrow('The conditional request failed')
  })

  it('frees the key when a job is deleted', () => {
    const repository = new ReportJobRepository()
    const created = job('free-1')
    repository.create(created)
    repository.delete(created.id, 'free-1')
    expect(repository.findById(created.id)).toBeUndefined()
    expect(repository.findJobIdByIdempotencyKey('free-1')).toBeUndefined()
    expect(() => repository.create(job('free-1'))).not.toThrow()
  })

  it('never resolves a key marker as a job, and treats a missing job as stale', () => {
    const repository = new ReportJobRepository()
    repository.create(job('marker'))
    expect(repository.findById(`${KEY_PREFIX}marker`)).toBeUndefined()
    expect(() => repository.update(job(null))).toThrow(StaleJobException)
  })

  it('hands out copies to change and frozen records to share', () => {
    const repository = new ReportJobRepository()
    const created = job(null)
    repository.create(created)
    const copy = repository.findById(created.id) as Job
    copy.status = 'FAILED'
    copy.parameters['region'] = 'South'
    expect(repository.findById(created.id)).toMatchObject({
      status: 'ACCEPTED',
      parameters: { region: 'North' },
    })
    const record = repository.record(created.id)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record?.parameters)).toBe(true)
  })

  it('lists jobs newest first without the markers, and reuses the list until a write', () => {
    const repository = new ReportJobRepository()
    const jobs = [job('l-1', 0), job(null, 1), job('l-3', 2)]
    for (const each of jobs) repository.create(each)
    const listed = repository.findAll()
    expect(listed.map((j) => j.id)).toEqual(jobs.map((j) => j.id).reverse())
    expect(repository.findAll()).toBe(listed)
    repository.delete(jobs[1]?.id ?? '', null)
    expect(repository.findAll()).not.toBe(listed)
    expect(repository.findAll()).toHaveLength(2)
  })

  it('stores what DynamoDB keeps: errors cut to 1,000 chars, blank strings as absent', () => {
    const repository = new ReportJobRepository()
    const created = job(null)
    repository.create(created)
    markQueued(created, 0)
    markProcessing(created, '  ', 0)
    repository.update(created)
    expect(created.lockedBy).toBe('  ')
    expect(repository.findById(created.id)?.lockedBy).toBeNull()

    markRetryScheduled(created, 'e'.repeat(1_200), 0, 0)
    repository.update(created)
    const stored = repository.findById(created.id) as Job
    expect(stored.errorMessage).toHaveLength(1_000)
    expect(stored.errorMessage?.endsWith('e...')).toBe(true)
    expect(created.errorMessage).toHaveLength(1_200)
  })
})
