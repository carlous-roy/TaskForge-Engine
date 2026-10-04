// The faults the console can inject, and the exceptions that carry them into JobProcessor: an S3
// upload that times out (an SdkClientException, which FailureClassifier calls TRANSIENT) and
// parameters the worker's own re-check rejects (InvalidReportParametersException, PERMANENT).
// The interruption a drain deadline causes is defined here as well.

import type { Job, ReportType } from './types.ts'

export type FaultKind = 'transient' | 'permanent'

/** How a failed attempt ends, named after the Java exception that would carry it. */
export interface Failure {
  readonly exception:
    'SdkClientException' | 'InvalidReportParametersException' | 'InterruptedException'
  readonly message: string
}

/** The SDK's message when an S3 PutObject times out reading the response. */
export const UPLOAD_TIMEOUT: Failure = {
  exception: 'SdkClientException',
  message: 'Unable to execute HTTP request: Read timed out',
}

/**
 * What an interrupted job thread ends with. Its text is never shown: the INTERRUPTED branch of
 * JobProcessor records a fixed message of its own.
 */
export const INTERRUPTION: Failure = {
  exception: 'InterruptedException',
  message: 'interrupted after generating the report',
}

// One value per type that the type's rules reject, so the re-check fails with the Java's message.
// A record like this one reaches a worker when the API that accepted it ran laxer rules.
const BAD_PARAMETER: Readonly<Record<ReportType, Readonly<Record<string, string>>>> = {
  SALES_SUMMARY: { dateFrom: 'yesterday' },
  INVENTORY_SNAPSHOT: { lowStockThreshold: '-1' },
  USER_ACTIVITY: { userId: '0' },
}

/**
 * The armed fault strikes the first job that starts after it is armed. A transient fault then
 * fails every attempt of that job until it is disarmed or the job is finished (FAILED once the
 * attempts run out); a permanent one fails it once, which finishes it. Either way the fault is
 * cleared when its job reaches COMPLETED or FAILED.
 */
export class FaultInjector {
  private kind: FaultKind | null = null
  private target: string | null = null
  private changes = 0
  private readonly isFinished: (jobId: string) => boolean

  constructor(isFinished: (jobId: string) => boolean) {
    this.isFinished = isFinished
  }

  get revision(): number {
    return this.changes
  }

  /** The armed fault, if it has not run its course. */
  current(): FaultKind | null {
    this.settle()
    return this.kind
  }

  arm(kind: FaultKind | null): void {
    this.kind = kind
    this.target = null
    this.changes++
  }

  /** The parameters an attempt that starts now re-checks: corrupted when the permanent fault strikes. */
  parametersFor(job: Readonly<Job>): Readonly<Record<string, string>> {
    this.settle()
    if (this.kind !== null && this.target === null) {
      this.target = job.id
      this.changes++
    }
    if (this.kind === 'permanent' && this.target === job.id) {
      return { ...job.parameters, ...BAD_PARAMETER[job.type] }
    }
    return job.parameters
  }

  /** Whether the upload that ends an attempt of this job fails. */
  uploadFails(jobId: string): boolean {
    this.settle()
    return this.kind === 'transient' && this.target === jobId
  }

  private settle(): void {
    if (this.target !== null && this.isFinished(this.target)) {
      this.kind = null
      this.target = null
      this.changes++
    }
  }
}
