import { memo } from 'react'
import type { Job, ReportStatus } from '../sim/types.ts'
import {
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_LABELS,
  clock,
  duration,
  secondsUntil,
} from '../lib/format.ts'
import { STATUS_FILTERS } from '../lib/presets.ts'

interface Props {
  /** Newest first, as the API lists them. */
  jobs: Job[]
  /** The clock the jobs' times are on, in epoch ms, rounded to the second so rows re-render once a second. */
  now: number
  /** Added to the jobs' times to put them on the epoch clock: SIM_EPOCH_MS for the simulator, 0 for the service. */
  epochOffset: number
  selected: string | null
  onSelect: (correlationId: string | null) => void
  filter: ReportStatus | 'ALL'
  onFilter: (filter: ReportStatus | 'ALL') => void
  /** Service edition: link completed rows to the presigned CSV. */
  downloadUrl?: (job: Job) => string
  limit?: number
}

export default function JobsTable({
  jobs,
  now,
  epochOffset,
  selected,
  onSelect,
  filter,
  onFilter,
  downloadUrl,
  limit = 200,
}: Props) {
  const filtered = filter === 'ALL' ? jobs : jobs.filter((j) => j.status === filter)
  const shown = filtered.slice(0, limit)
  return (
    <div className="panel jobs">
      <div className="panel-head">
        <h2>Jobs</h2>
        <span className="small muted num">
          {filtered.length === jobs.length ? jobs.length : `${filtered.length} of ${jobs.length}`}
        </span>
        <span className="spacer" />
        <div className="filters" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn-sm btn-ghost ${filter === f ? 'selected' : ''}`}
              onClick={() => onFilter(f)}
            >
              {f === 'ALL' ? 'All' : STATUS_LABELS[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Correlation</th>
              <th>Type</th>
              <th>Status</th>
              <th className="num">Attempts</th>
              <th>Worker</th>
              <th>Created</th>
              <th>Took</th>
              <th>{downloadUrl ? 'File' : 'Note'}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((job) => (
              <Row
                key={job.id}
                job={job}
                now={now}
                epochOffset={epochOffset}
                selected={selected === job.correlationId}
                onSelect={onSelect}
                downloadUrl={downloadUrl}
              />
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="empty small muted">
            {jobs.length === 0 ? 'No jobs yet.' : `No jobs with status ${filter}.`}
          </p>
        )}
        {filtered.length > shown.length && (
          <p className="empty small muted">Showing the newest {shown.length}.</p>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  job: Job
  now: number
  epochOffset: number
  selected: boolean
  onSelect: (correlationId: string | null) => void
  downloadUrl?: (job: Job) => string
}

const Row = memo(function Row({
  job,
  now,
  epochOffset,
  selected,
  onSelect,
  downloadUrl,
}: RowProps) {
  const retryIn =
    job.status === 'RETRY_SCHEDULED' && job.nextAttemptAt !== null
      ? secondsUntil(job.nextAttemptAt + epochOffset, now)
      : null
  return (
    <tr className={selected ? 'selected' : ''}>
      <td>
        <button
          type="button"
          className="linkish mono"
          onClick={() => onSelect(selected ? null : job.correlationId)}
          title={`job ${job.id}${job.idempotencyKey ? `, key ${job.idempotencyKey}` : ''}`}
        >
          {job.correlationId}
        </button>
      </td>
      <td className="type">{TYPE_LABELS[job.type]}</td>
      <td>
        <span className={`pill pill-${STATUS_TONE[job.status]}`} title={job.errorMessage ?? ''}>
          {retryIn !== null ? `Retry in ${retryIn} s` : STATUS_LABELS[job.status]}
        </span>
      </td>
      <td className="num">
        {job.attemptCount}/{job.maxAttempts}
      </td>
      <td className="mono worker">{job.lockedBy ?? ''}</td>
      <td className="num">{clock(job.createdAt + epochOffset)}</td>
      <td className="num">{job.executionTimeMs > 0 ? duration(job.executionTimeMs) : ''}</td>
      <td className="note">
        {downloadUrl && job.status === 'COMPLETED' ? (
          <a href={downloadUrl(job)} target="_blank" rel="noopener noreferrer">
            CSV
          </a>
        ) : job.errorMessage ? (
          <span className="small error" title={job.errorMessage}>
            {job.errorMessage}
          </span>
        ) : job.status === 'COMPLETED' && job.fileKey ? (
          <span className="small mono muted" title={job.fileKey}>
            {job.fileKey.split('/').pop()}
          </span>
        ) : null}
      </td>
    </tr>
  )
})
