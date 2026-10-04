// The service edition's data: the report list and the health endpoint, polled every five seconds
// through src/api.ts. Twelve list requests a minute is a fifth of the API's per-client limit; the
// health endpoint is exempt. A failed refresh keeps the last list on screen, and a 429 pauses the
// poll for the Retry-After period, as applyPoll arranges.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, applyPoll, toJob, type HealthResponse, type PollState } from '../api.ts'
import type { Job, LogLine } from '../sim/types.ts'
import { STATUS_LABELS } from '../lib/format.ts'

export const POLL_INTERVAL_MS = 5_000
const EVENTS_KEPT = 300
const DEPTH_HISTORY = 180

export type Health =
  | HealthResponse
  | { status: 'UNREACHABLE'; detail: string; queueDepth: null; deadLetterDepth: null }
  | { status: 'LOADING'; queueDepth: null; deadLetterDepth: null }

export interface Polling extends PollState<Job, Health> {
  /** Epoch ms of the last answered poll. */
  lastPollAt: number | null
  /** Queue depth per poll, oldest first, for the sparkline. */
  depths: number[]
  /** Status changes seen between polls, in the log pane's shape. */
  events: LogLine[]
  refresh: () => Promise<void>
}

/**
 * Turns one poll's differences into log-shaped lines, so the log pane can show them. `previous` is
 * null before the first answer, when every report is new and none of it is activity.
 */
export function diffEvents(
  previous: Job[] | null,
  next: Job[],
  at: number,
  firstSeq: number
): LogLine[] {
  if (previous === null) return []
  const before = new Map(previous.map((j) => [j.id, j]))
  const lines: LogLine[] = []
  let seq = firstSeq
  for (const job of [...next].reverse()) {
    const old = before.get(job.id)
    if (old === undefined) {
      lines.push({
        seq: seq++,
        t: at,
        level: 'INFO',
        source: 'api',
        cid: job.correlationId,
        message: `Report submitted: ${job.type} ${job.id}`,
      })
    } else if (old.status !== job.status || old.attemptCount !== job.attemptCount) {
      const level =
        job.status === 'FAILED' ? 'ERROR' : job.status === 'RETRY_SCHEDULED' ? 'WARN' : 'INFO'
      const detail =
        job.status === 'COMPLETED'
          ? ` in ${job.executionTimeMs} ms`
          : job.errorMessage
            ? `: ${job.errorMessage}`
            : ''
      lines.push({
        seq: seq++,
        t: at,
        level,
        source: 'worker',
        cid: job.correlationId,
        message: `Job ${job.id} ${STATUS_LABELS[old.status]} to ${STATUS_LABELS[job.status]} (attempt ${job.attemptCount}/${job.maxAttempts})${detail}`,
      })
    }
  }
  return lines
}

export function usePolling(): Polling {
  const [state, setState] = useState<PollState<Job, Health>>({
    reports: [],
    health: { status: 'LOADING', queueDepth: null, deadLetterDepth: null },
    error: null,
    pausedUntil: null,
  })
  const [lastPollAt, setLastPollAt] = useState<number | null>(null)
  const [depths, setDepths] = useState<number[]>([])
  const [events, setEvents] = useState<LogLine[]>([])
  const stateRef = useRef(state)
  const seqRef = useRef(1)
  const loadedRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const refresh = useCallback(async () => {
    const current = stateRef.current
    const now = Date.now()
    if (current.pausedUntil !== null && now < current.pausedUntil) return
    const [reports, health] = await Promise.allSettled([api.listReports(), api.getHealth()])
    const healthValue: Health =
      health.status === 'fulfilled'
        ? health.value
        : health.reason instanceof ApiError && health.reason.status === 503
          ? {
              service: 'taskforge-api',
              timestamp: new Date().toISOString(),
              status: 'DEGRADED',
              queueDepth: null,
              deadLetterDepth: null,
              detail: health.reason.message,
            }
          : {
              status: 'UNREACHABLE',
              detail: messageOf(health.reason),
              queueDepth: null,
              deadLetterDepth: null,
            }
    setLastPollAt(now)
    if (healthValue.queueDepth !== null && healthValue.queueDepth !== undefined) {
      const depth = healthValue.queueDepth
      setDepths((d) => [...d, depth].slice(-DEPTH_HISTORY))
    }
    if (reports.status === 'fulfilled') {
      const jobs = reports.value.map(toJob)
      const added = diffEvents(
        loadedRef.current ? current.reports : null,
        jobs,
        now,
        seqRef.current
      )
      loadedRef.current = true
      if (added.length > 0) {
        seqRef.current += added.length
        setEvents((e) => [...e, ...added].slice(-EVENTS_KEPT))
      }
      setState((prev) => applyPoll(prev, { reports: jobs, health: healthValue, now }))
    } else {
      const reason = reports.reason
      setState((prev) =>
        applyPoll(prev, {
          error: {
            message: messageOf(reason),
            status: reason instanceof ApiError ? reason.status : undefined,
            retryAfterSeconds: reason instanceof ApiError ? reason.retryAfterSeconds : null,
          },
          health: healthValue,
          now,
        })
      )
    }
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [refresh])

  return { ...state, lastPollAt, depths, events, refresh }
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}
