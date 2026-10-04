// The services' log output as the console shows it. Both application.yml files log with
// "%d{HH:mm:ss.SSS} %-5level [%thread] [%X{cid:-}] %logger{24} - %msg%n"; a LogLine keeps the
// time, the level, the process (in place of the thread and logger), the correlation id bound in
// the MDC at that moment, and the message exactly as the Java formats it.

import type { Clock } from './events.ts'
import type { LogLevel, LogLine } from './types.ts'

/** The most recent lines kept; older ones are dropped. */
export const LOG_LIMIT = 2_000

/** One process's logger: the level, the bound correlation id (null outside a request or job), the message. */
export type Log = (level: LogLevel, cid: string | null, message: string) => void

export class LogBuffer {
  private readonly clock: Clock
  private lines: LogLine[] = []
  private nextSeq = 1
  private view: readonly LogLine[] | null = null

  constructor(clock: Clock) {
    this.clock = clock
  }

  /** Counts the lines ever written, so a snapshot can tell whether anything changed. */
  get revision(): number {
    return this.nextSeq - 1
  }

  append(source: string, level: LogLevel, cid: string | null, message: string): void {
    const line: LogLine = Object.freeze({
      seq: this.nextSeq++,
      t: this.clock.now,
      level,
      source,
      cid,
      message,
    })
    this.lines.push(line)
    // Trim in batches so that a busy run does not shift a 2,000-line array on every line.
    if (this.lines.length >= 2 * LOG_LIMIT) this.lines = this.lines.slice(-LOG_LIMIT)
    this.view = null
  }

  /** The logger of one process: api, worker-1, dlq, sqs. */
  writer(source: string): Log {
    return (level, cid, message) => this.append(source, level, cid, message)
  }

  /** The last LOG_LIMIT lines, oldest first, frozen and shared until the next line arrives. */
  snapshot(): readonly LogLine[] {
    if (this.view === null) this.view = Object.freeze(this.lines.slice(-LOG_LIMIT))
    return this.view
  }
}
