// com.taskforge.common.repository.ReportJobRepository with StaleJobException and
// DuplicateReportException: one DynamoDB table holding job records under their id and
// KEY#<idempotencyKey> markers that point at the job owning the key. A job and its marker are
// written together or not at all, and every write to an existing job is conditional on its version.

import { isBlank } from './java.ts'
import { copyJob } from './job.ts'
import type { Job } from './types.ts'

export const KEY_PREFIX = 'KEY#'
const MAX_ERROR_LENGTH = 1_000

/** A conditional write failed: someone else has written the job since this copy was loaded. */
export class StaleJobException extends Error {
  readonly jobId: string
  readonly expectedVersion: number

  constructor(jobId: string, expectedVersion: number) {
    super(`Job ${jobId} was modified concurrently (expected version ${expectedVersion})`)
    this.name = 'StaleJobException'
    this.jobId = jobId
    this.expectedVersion = expectedVersion
  }
}

/**
 * The idempotency key already belongs to a job. The Java allows a null id (the marker could vanish
 * between the failed write and the lookup); here both happen in the same instant, so it never is.
 */
export class DuplicateReportException extends Error {
  readonly idempotencyKey: string
  readonly existingId: string

  constructor(idempotencyKey: string, existingId: string) {
    super(`Duplicate report request with key '${idempotencyKey}' (existing report ${existingId})`)
    this.name = 'DuplicateReportException'
    this.idempotencyKey = idempotencyKey
    this.existingId = existingId
  }
}

type Item =
  | { readonly kind: 'job'; readonly job: Readonly<Job> }
  | { readonly kind: 'marker'; readonly jobId: string }

/** putIfPresent: DynamoDB keeps no attribute for a null or blank string, so it reads back as null. */
function present(value: string | null): string | null {
  return value === null || isBlank(value) ? null : value
}

function truncate(message: string | null): string | null {
  if (message === null || message.length <= MAX_ERROR_LENGTH) return message
  return `${message.slice(0, MAX_ERROR_LENGTH - 3)}...`
}

/** toItem then fromItem: the record as the table stores it and gives it back. */
function toItem(job: Readonly<Job>, version: number): Readonly<Job> {
  return Object.freeze({
    ...job,
    parameters: Object.freeze({ ...job.parameters }),
    idempotencyKey: present(job.idempotencyKey),
    fileKey: present(job.fileKey),
    errorMessage: present(truncate(job.errorMessage)),
    lockedBy: present(job.lockedBy),
    downloadUrl: null,
    version,
  })
}

export class ReportJobRepository {
  private readonly table = new Map<string, Item>()
  private listing: readonly Readonly<Job>[] | null = null
  private writes = 0

  /** Counts successful writes, so a snapshot can tell whether anything changed. */
  get revision(): number {
    return this.writes
  }

  /**
   * Inserts a new job. With an idempotency key, the job and its marker go in one transaction, each
   * conditional on not existing yet; the marker's condition is checked first, as the Java reads
   * cancellation reason 1 before reason 0.
   *
   * @throws DuplicateReportException if the key already belongs to another job
   */
  create(job: Readonly<Job>): void {
    const key = job.idempotencyKey
    if (key === null) {
      // A plain PutItem with attribute_not_exists(id); the SDK's exception is not translated.
      if (this.table.has(job.id)) throw new Error('The conditional request failed')
      this.put(job.id, { kind: 'job', job: toItem(job, job.version) })
      return
    }
    const existing = this.findJobIdByIdempotencyKey(key)
    if (existing !== undefined) throw new DuplicateReportException(key, existing)
    if (this.table.has(job.id)) throw new Error(`Job id collision for ${job.id}`)
    this.put(job.id, { kind: 'job', job: toItem(job, job.version) })
    this.put(KEY_PREFIX + key, { kind: 'marker', jobId: job.id })
  }

  /**
   * Writes the job if its stored version still equals `job.version`, storing version + 1, and
   * then bumps the caller's copy to match. The copy is bumped only after the write succeeds.
   *
   * @throws StaleJobException if another process has written the job since it was loaded
   */
  update(job: Job): void {
    const expected = job.version
    const next = expected + 1
    const stored = this.table.get(job.id)
    if (stored?.kind !== 'job' || stored.job.version !== expected) {
      throw new StaleJobException(job.id, expected)
    }
    this.put(job.id, { kind: 'job', job: toItem(job, next) })
    job.version = next
  }

  /** Removes a job and its key marker, used when the message for a new job could not be sent. */
  delete(jobId: string, idempotencyKey: string | null): void {
    this.table.delete(jobId)
    if (idempotencyKey !== null) this.table.delete(KEY_PREFIX + idempotencyKey)
    this.changed()
  }

  /** A copy of the job the caller may change, or undefined (Optional.empty). */
  findById(id: string): Job | undefined {
    const record = this.record(id)
    return record === undefined ? undefined : copyJob(record)
  }

  /** The stored record itself, frozen and shared: for snapshots, which must not copy. */
  record(id: string): Readonly<Job> | undefined {
    if (id.startsWith(KEY_PREFIX)) return undefined
    const item = this.table.get(id)
    return item?.kind === 'job' ? item.job : undefined
  }

  findJobIdByIdempotencyKey(key: string): string | undefined {
    const item = this.table.get(KEY_PREFIX + key)
    return item?.kind === 'marker' ? item.jobId : undefined
  }

  /** Every job, newest first, without the key markers. Creation order stands in for createdAt. */
  findAll(): readonly Readonly<Job>[] {
    if (this.listing === null) {
      const jobs: Readonly<Job>[] = []
      for (const item of this.table.values()) {
        if (item.kind === 'job') jobs.push(item.job)
      }
      this.listing = Object.freeze(jobs.reverse())
    }
    return this.listing
  }

  private put(id: string, item: Item): void {
    this.table.set(id, item)
    this.changed()
  }

  private changed(): void {
    this.writes++
    this.listing = null
  }
}
