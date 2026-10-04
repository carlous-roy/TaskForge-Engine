// The shapes shared by the simulator (src/sim) and the console (src/ui). They
// mirror the service's own records: ReportJob, ReportResponse, the SQS
// message the worker receives, and the log line format from application.yml.

export type ReportType = 'SALES_SUMMARY' | 'INVENTORY_SNAPSHOT' | 'USER_ACTIVITY'
export type ReportStatus =
  'ACCEPTED' | 'QUEUED' | 'PROCESSING' | 'RETRY_SCHEDULED' | 'COMPLETED' | 'FAILED'

export const REPORT_TYPES: ReportType[] = ['SALES_SUMMARY', 'INVENTORY_SNAPSHOT', 'USER_ACTIVITY']

/** com.taskforge.common.model.ReportJob, as the API returns it (ReportResponse). */
export interface Job {
  id: string
  type: ReportType
  status: ReportStatus
  parameters: Record<string, string>
  correlationId: string
  idempotencyKey: string | null
  errorMessage: string | null
  attemptCount: number
  maxAttempts: number
  version: number
  lockedBy: string | null
  fileKey: string | null
  downloadUrl: string | null
  /** Simulation milliseconds (the simulation's clock), or ISO strings on the service. */
  createdAt: number
  updatedAt: number
  completedAt: number | null
  nextAttemptAt: number | null
  deadLetteredAt: number | null
  executionTimeMs: number
}

/** An SQS message as the queue holds it. */
export interface QueueMessage {
  messageId: string
  jobId: string
  correlationId: string
  /** How many times it has been received; the redrive policy compares this with maxReceiveCount. */
  receiveCount: number
  /** When it becomes visible again (simulation ms); null while visible. */
  invisibleUntil: number | null
  sentAt: number
  /** Set once the queue moved it to the dead-letter queue. */
  deadLetteredAt: number | null
}

export type WorkerState = 'running' | 'draining' | 'frozen' | 'dead' | 'stopped'

export interface WorkerSlot {
  jobId: string
  startedAt: number
  /** When the generation finishes, if nothing interrupts it. */
  finishesAt: number
  /** The attempt this slot is running (job.attemptCount at acquire). */
  attempt: number
}

export interface Worker {
  id: string
  state: WorkerState
  slots: WorkerSlot[]
  maxConcurrent: number
  /** Simulation ms when a frozen worker thaws or a draining worker gives up waiting. */
  until: number | null
  /** Jobs this worker has finished, for the lane's counter. */
  completed: number
  failed: number
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface LogLine {
  seq: number
  t: number
  level: LogLevel
  /** api, worker-1, worker-2, dlq, sqs */
  source: string
  cid: string | null
  message: string
}

export interface Stats {
  accepted: number
  queued: number
  processing: number
  retryScheduled: number
  completed: number
  failed: number
  deadLettered: number
  rejectedDuplicates: number
  rateLimited: number
  takeovers: number
  staleWritesDiscarded: number
}

export interface HistoryPoint {
  t: number
  queueDepth: number
  inFlight: number
  dlqDepth: number
}

export interface SimState {
  time: number
  seed: number
  jobs: Job[]
  queue: QueueMessage[]
  dlq: QueueMessage[]
  workers: Worker[]
  log: LogLine[]
  stats: Stats
  history: HistoryPoint[]
  /** The next poison or permanent failure armed by the controls, if any. */
  armed: 'transient' | 'permanent' | null
  /** Requests counted in the current fixed one-minute rate-limit window. */
  rateWindow: { startedAt: number; count: number }
}

export interface SubmitRequest {
  type: ReportType
  parameters: Record<string, string>
  idempotencyKey?: string | null
  correlationId?: string | null
}

export type SubmitResult =
  | { status: 202; job: Job }
  | { status: 409; message: string; existingReportId: string; correlationId: string }
  | { status: 429; message: string; retryAfterSeconds: number; correlationId: string }
  | { status: 400; message: string; details: string[]; correlationId: string }

/** The service's settings (application.yml), in the units the simulator uses. */
export interface SimConfig {
  workers: number
  maxConcurrent: number
  batchSize: number
  idleWaitMs: number
  visibilityTimeoutS: number
  maxAttempts: number
  backoffBaseS: number
  backoffCapS: number
  drainTimeoutS: number
  /** Null means the visibility timeout, as in TaskForgeProperties. */
  staleLockAfterS: number | null
  dlqPollIntervalS: number
  rateLimitPerMinute: number
  /** Report generation takes a uniform draw from this range, in ms. */
  generationMs: [number, number]
  seed: number
}

// Added with the simulator, below the contract above so that nothing in it changes. Interface
// merging adds the field to SimConfig.
export interface SimConfig {
  /**
   * The workers' SQS long-poll wait (taskforge.sqs.wait-time, 10 s). With a wait, a receive that
   * finds the queue empty returns as soon as a message becomes visible; with 0 the worker sleeps
   * idleWaitMs before it polls again, as MessagePoller does when the wait time is zero.
   * Optional; DEFAULT_CONFIG sets 10.
   */
  receiveWaitS?: number
}
