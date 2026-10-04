// Text for the console: clocks, durations and labels. Every time here is epoch milliseconds; the
// simulator's clock is converted with SIM_EPOCH_MS by the caller, so one set of formatters serves
// both editions.

import type { ReportStatus, ReportType, WorkerState } from '../sim/types.ts'

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** HH:mm:ss in UTC, the services' clock. */
export function clock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** HH:mm:ss.SSS in UTC, the log pattern's %d{HH:mm:ss.SSS}. */
export function logClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${clock(epochMs)}.${pad(d.getUTCMilliseconds(), 3)}`
}

/** yyyy-MM-dd in UTC. */
export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/** A duration for a table cell: 850 ms, 2.4 s, 1m 05s. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${pad(seconds)}s`
}

/** Whole seconds, never negative, for countdowns. */
export function secondsUntil(target: number, now: number): number {
  return Math.max(0, Math.ceil((target - now) / 1000))
}

export const TYPE_LABELS: Record<ReportType, string> = {
  SALES_SUMMARY: 'Sales summary',
  INVENTORY_SNAPSHOT: 'Inventory snapshot',
  USER_ACTIVITY: 'User activity',
}

export const STATUS_LABELS: Record<ReportStatus, string> = {
  ACCEPTED: 'Accepted',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  RETRY_SCHEDULED: 'Retry scheduled',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
}

/** The state colour each status takes, as a pill class suffix. */
export const STATUS_TONE: Record<ReportStatus, 'amber' | 'green' | 'red' | 'cyan' | 'grey'> = {
  ACCEPTED: 'grey',
  QUEUED: 'amber',
  PROCESSING: 'cyan',
  RETRY_SCHEDULED: 'amber',
  COMPLETED: 'green',
  FAILED: 'red',
}

export const WORKER_TONE: Record<WorkerState, 'amber' | 'green' | 'red' | 'violet' | 'grey'> = {
  running: 'green',
  draining: 'violet',
  frozen: 'amber',
  dead: 'red',
  stopped: 'grey',
}

export const WORKER_LABELS: Record<WorkerState, string> = {
  running: 'running',
  draining: 'draining',
  frozen: 'frozen',
  dead: 'dead',
  stopped: 'stopped',
}

/** 1,204 */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** The first 8 characters of a UUID, the way the service's own log lines abbreviate ids. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}
