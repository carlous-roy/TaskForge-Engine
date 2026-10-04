import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../api.ts'
import { DEFAULT_CONFIG } from '../sim/index.ts'
import type { Job, ReportStatus } from '../sim/types.ts'
import { POLL_INTERVAL_MS, usePolling, type Health } from '../hooks/usePolling.ts'
import TopBar from '../components/TopBar.tsx'
import StatStrip, { type Tile } from '../components/StatStrip.tsx'
import Sparkline from '../components/Sparkline.tsx'
import SubmitForm, { type Outcome, type SubmitRequestBody } from '../components/SubmitForm.tsx'
import JobsTable from '../components/JobsTable.tsx'
import LogPane from '../components/LogPane.tsx'
import Footer from '../components/Footer.tsx'
import { clock, secondsUntil, shortId } from '../lib/format.ts'

const HEALTH_TONE: Record<Health['status'], string> = {
  UP: 'green',
  DEGRADED: 'amber',
  UNREACHABLE: 'red',
  LOADING: 'grey',
}

export function outcomeOfError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        tone: 'amber',
        text: `409 Conflict: that idempotency key already belongs to job ${error.existingReportId ? shortId(error.existingReportId) : 'another report'}. Nothing was created.`,
        correlationId: error.correlationId ?? undefined,
      }
    }
    if (error.status === 429) {
      return {
        tone: 'red',
        text: `429 Too Many Requests. Retry-After ${error.retryAfterSeconds ?? '?'} s.`,
        correlationId: error.correlationId ?? undefined,
      }
    }
    if (error.status === 400) {
      return {
        tone: 'violet',
        text: `400 Bad Request: ${error.message}`,
        details: error.details,
        correlationId: error.correlationId ?? undefined,
      }
    }
    return {
      tone: 'red',
      text: `${error.status}: ${error.message}`,
      correlationId: error.correlationId ?? undefined,
    }
  }
  return {
    tone: 'red',
    text: `Could not reach the API: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/** The service edition: the page the API serves, polling the live service. */
export default function ServicePage() {
  const poll = usePolling()
  const [selected, setSelected] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState('')
  const [filter, setFilter] = useState<ReportStatus | 'ALL'>('ALL')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const select = useCallback((correlationId: string | null) => {
    setSelected(correlationId)
    setLogFilter(correlationId ?? '')
  }, [])

  const jobs = poll.reports
  const by = (status: ReportStatus) => jobs.filter((j) => j.status === status).length
  const health = poll.health
  const tiles: Tile[] = [
    { label: 'Reports', value: jobs.length, sub: 'in the table' },
    { label: 'Queued', value: by('QUEUED') + by('ACCEPTED'), tone: 'amber', sub: 'waiting on SQS' },
    { label: 'Processing', value: by('PROCESSING'), tone: 'cyan', sub: 'on a worker' },
    { label: 'Retrying', value: by('RETRY_SCHEDULED'), tone: 'amber', sub: 'backoff delay' },
    { label: 'Completed', value: by('COMPLETED'), tone: 'green', sub: 'files in S3' },
    { label: 'Failed', value: by('FAILED'), tone: 'red', sub: 'no attempts left' },
    {
      label: 'Queue depth',
      value: health.queueDepth ?? 0,
      tone: 'amber',
      sub: 'from /health',
      title: 'Messages on the queue, as the health endpoint reports them',
    },
    {
      label: 'DLQ depth',
      value: health.deadLetterDepth ?? 0,
      tone: 'red',
      sub: 'from /health',
      title: 'Messages on the dead-letter queue, as the health endpoint reports them',
    },
  ]
  const series = useMemo(
    () => [{ name: 'queue depth', color: 'var(--amber)', values: poll.depths }],
    [poll.depths]
  )

  const submit = useCallback(
    async (body: SubmitRequestBody): Promise<Outcome> => {
      try {
        const job = await api.submit({
          type: body.type,
          parameters: body.parameters,
          ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        })
        void poll.refresh()
        return {
          tone: 'green',
          text: `202 Accepted: ${job.type} as job ${shortId(job.id)}`,
          correlationId: job.correlationId,
        }
      } catch (error) {
        return outcomeOfError(error)
      }
    },
    [poll]
  )

  const pausedSeconds = poll.pausedUntil !== null ? secondsUntil(poll.pausedUntil, now) : 0

  return (
    <div className="app">
      <TopBar>
        <div className="health">
          <span
            className={`pill pill-${HEALTH_TONE[health.status]}`}
            title={'detail' in health && health.detail ? health.detail : ''}
          >
            <span className="dot" aria-hidden="true" />
            {health.status === 'LOADING' ? 'Connecting' : `API ${health.status}`}
          </span>
          <span className="small muted num">
            {poll.lastPollAt !== null ? `polled ${clock(poll.lastPollAt)} UTC` : ''}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void poll.refresh()}>
            Refresh
          </button>
        </div>
      </TopBar>
      <main className="console">
        {poll.error && (
          <div className="banner" role="alert">
            Could not refresh the report list: {poll.error}.{' '}
            {pausedSeconds > 0
              ? `Polling resumes in ${pausedSeconds} s.`
              : 'Showing the last known state.'}
          </div>
        )}

        <StatStrip tiles={tiles}>
          <Sparkline series={series} window={60} caption="Queue depth over the last polls" />
        </StatStrip>

        <div className="console-grid">
          <section className="panel deck-panel" aria-label="Controls">
            <div className="panel-head">
              <h2>Submit a report</h2>
            </div>
            <div className="panel-body">
              <SubmitForm
                todayMs={now}
                onSubmit={submit}
                onSelect={select}
                keyHint="A reused key is answered 409 with the existing report's id; the request body is not compared."
              />
            </div>
            <div className="panel-head">
              <h2>Service health</h2>
            </div>
            <div className="panel-body health-card mono small">
              <div>
                <span className="muted">api</span>
                <span className={`tone-${HEALTH_TONE[health.status]}`}>{health.status}</span>
              </div>
              <div>
                <span className="muted">queue</span>
                <span>{health.queueDepth ?? '?'} waiting</span>
              </div>
              <div>
                <span className="muted">dead-letter</span>
                <span className={health.deadLetterDepth ? 'tone-red' : ''}>
                  {health.deadLetterDepth ?? '?'} messages
                </span>
              </div>
              <div>
                <span className="muted">refresh</span>
                <span>every {POLL_INTERVAL_MS / 1000} s</span>
              </div>
              {'detail' in health && health.detail && (
                <div>
                  <span className="muted">detail</span>
                  <span>{health.detail}</span>
                </div>
              )}
            </div>
          </section>

          <JobsTable
            jobs={jobs}
            now={Math.floor(now / 1000) * 1000}
            epochOffset={0}
            selected={selected}
            onSelect={select}
            filter={filter}
            onFilter={setFilter}
            downloadUrl={(job: Job) => api.downloadUrl(job.id)}
          />

          <LogPane
            title="Activity"
            lines={poll.events}
            epochOffset={0}
            filter={logFilter}
            onFilter={(text) => {
              setLogFilter(text)
              if (selected && text !== selected) setSelected(null)
            }}
            onSelect={select}
            emptyText="Status changes seen between polls show here."
          />
        </div>
      </main>
      <Footer config={DEFAULT_CONFIG} />
    </div>
  )
}
