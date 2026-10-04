import { memo, useMemo } from 'react'
import type { Job, QueueMessage, SimConfig, SimState, Worker } from '../sim/types.ts'
import type { Response } from '../hooks/useSimulation.ts'
import { WORKER_LABELS, WORKER_TONE, secondsUntil, shortId } from '../lib/format.ts'

interface Props {
  state: SimState
  config: SimConfig
  responses: Response[]
  selected: string | null
  onSelect: (correlationId: string | null) => void
  onKill: (id: string) => void
  onFreeze: (id: string, seconds: number) => void
  onDrain: (id: string) => void
  onRestart: (id: string) => void
}

/** How long a frozen worker stays frozen: past the visibility timeout, so the other lane takes over. */
export const FREEZE_SECONDS = 150

const MAX_CHIPS = 48

export default function PipelineBoard(props: Props) {
  const { state, config, responses, selected, onSelect } = props
  // The snapshot shares its parts between frames while they do not change, so these indexes are
  // rebuilt only when a job or a message actually moved.
  const byId = useMemo(() => new Map(state.jobs.map((job) => [job.id, job])), [state.jobs])
  const messageByJob = useMemo(() => new Map(state.queue.map((m) => [m.jobId, m])), [state.queue])

  return (
    <section className="board" aria-label="Pipeline">
      <ApiNode
        now={state.time}
        window={state.rateWindow}
        limit={config.rateLimitPerMinute}
        responses={responses}
        selected={selected}
        onSelect={onSelect}
      />
      <Flow />
      <QueueNode
        now={state.time}
        queue={state.queue}
        config={config}
        byId={byId}
        selected={selected}
        onSelect={onSelect}
      />
      <Flow />
      <div className="lanes">
        {state.armed && (
          <div className={`armed armed-${state.armed}`} role="status">
            {state.armed === 'transient'
              ? 'Poison armed: the first job to start after arming fails its S3 upload on every attempt, retries with backoff, and is dead-lettered after its last attempt.'
              : 'Poison armed: the first job to start after arming has parameters the worker rejects; it fails once and is not retried.'}
          </div>
        )}
        {state.workers.map((worker) => (
          <WorkerLane
            key={worker.id}
            worker={worker}
            now={state.time}
            jobs={state.jobs}
            byId={byId}
            messageByJob={messageByJob}
            selected={selected}
            onSelect={onSelect}
            onKill={props.onKill}
            onFreeze={props.onFreeze}
            onDrain={props.onDrain}
            onRestart={props.onRestart}
          />
        ))}
      </div>
      <Flow />
      <div className="sinks">
        <S3Node jobs={state.jobs} selected={selected} onSelect={onSelect} />
        <DlqNode dlq={state.dlq} jobs={state.jobs} selected={selected} onSelect={onSelect} />
      </div>
    </section>
  )
}

function Flow() {
  return (
    <div className="flow" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="24" height="24">
        <path d="M2 12h17M14 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

const STATUS_TONE: Record<Response['status'], string> = {
  202: 'green',
  400: 'violet',
  409: 'amber',
  429: 'red',
}

interface ApiProps {
  now: number
  window: SimState['rateWindow']
  limit: number
  responses: Response[]
  selected: string | null
  onSelect: (correlationId: string | null) => void
}

const ApiNode = memo(function ApiNode({
  now,
  window,
  limit,
  responses,
  selected,
  onSelect,
}: ApiProps) {
  const used = Math.min(window.count, limit)
  const resetsIn = secondsUntil(window.startedAt + 60_000, now)
  const full = window.count >= limit
  const latest = responses[responses.length - 1]
  return (
    <div className="node node-api">
      <header>
        <h3>API</h3>
        <span className="pill pill-grey num">{limit}/min</span>
      </header>
      <div className="gauge" title={`${window.count} requests in the current one-minute window`}>
        <div
          className={`gauge-fill ${full ? 'full' : ''}`}
          style={{ width: `${(used / limit) * 100}%` }}
        />
      </div>
      <p className="small muted num">
        {window.count} request{window.count === 1 ? '' : 's'} this window
        {window.count > 0 ? `, resets in ${resetsIn} s` : ''}
      </p>
      <div className="ticker" aria-label="Recent answers to your requests">
        {responses.slice(-24).map((r) => (
          <button
            key={r.seq}
            type="button"
            className={`tick tone-${STATUS_TONE[r.status]} ${selected === r.correlationId ? 'selected' : ''}`}
            title={r.summary}
            aria-label={r.summary}
            onClick={() => onSelect(selected === r.correlationId ? null : r.correlationId)}
          />
        ))}
      </div>
      <p className="small latest">
        {latest ? latest.summary : 'Your requests show here as they are answered.'}
      </p>
      <p className="small muted rule legend">
        <span className="tick tone-green" aria-hidden="true" /> 202
        <span className="tick tone-amber" aria-hidden="true" /> 409
        <span className="tick tone-red" aria-hidden="true" /> 429
        <span className="tick tone-violet" aria-hidden="true" /> 400
      </p>
    </div>
  )
})

interface QueueProps {
  now: number
  queue: QueueMessage[]
  config: SimConfig
  byId: Map<string, Job>
  selected: string | null
  onSelect: (correlationId: string | null) => void
}

const QueueNode = memo(function QueueNode({
  now,
  queue,
  config,
  byId,
  selected,
  onSelect,
}: QueueProps) {
  const visible = queue.filter((m) => m.invisibleUntil === null || m.invisibleUntil <= now)
  const inFlight = queue.filter((m) => m.invisibleUntil !== null && m.invisibleUntil > now)
  const ordered = [...visible, ...inFlight]
  return (
    <div className="node node-queue">
      <header>
        <h3>SQS queue</h3>
        <span className="num depth">{queue.length}</span>
      </header>
      <p className="small muted">
        <span className="num">{visible.length}</span> visible,{' '}
        <span className="num">{inFlight.length}</span> in flight
      </p>
      <div className="chips" aria-label="Messages on the queue">
        {ordered.slice(0, MAX_CHIPS).map((m) => {
          const job = byId.get(m.jobId)
          const flying = m.invisibleUntil !== null && m.invisibleUntil > now
          const title = `${m.correlationId}: ${flying ? `in flight, visible again in ${secondsUntil(m.invisibleUntil ?? now, now)} s` : 'visible'}; received ${m.receiveCount} time${m.receiveCount === 1 ? '' : 's'}${job ? `; job ${shortId(job.id)}` : ''}`
          return (
            <button
              key={m.messageId}
              type="button"
              className={`chip ${flying ? 'flying' : ''} ${selected === m.correlationId ? 'selected' : ''}`}
              title={title}
              aria-label={title}
              onClick={() => onSelect(selected === m.correlationId ? null : m.correlationId)}
            >
              {m.receiveCount > 1 && <span className="receives num">{m.receiveCount}</span>}
            </button>
          )
        })}
        {ordered.length > MAX_CHIPS && (
          <span className="more small muted">+{ordered.length - MAX_CHIPS}</span>
        )}
      </div>
      <p className="small muted rule legend">
        <span className="chip legend-chip" aria-hidden="true" /> visible
        <span className="chip legend-chip flying" aria-hidden="true" /> in flight
        <span className="legend-text">
          visibility {config.visibilityTimeoutS} s, dead-letter after {config.maxAttempts} receives
        </span>
      </p>
    </div>
  )
})

interface LaneProps {
  worker: Worker
  now: number
  jobs: Job[]
  byId: Map<string, Job>
  messageByJob: Map<string, QueueMessage>
  selected: string | null
  onSelect: (correlationId: string | null) => void
  onKill: (id: string) => void
  onFreeze: (id: string, seconds: number) => void
  onDrain: (id: string) => void
  onRestart: (id: string) => void
}

const WorkerLane = memo(function WorkerLane(props: LaneProps) {
  const { worker, now, jobs, byId, messageByJob, selected, onSelect } = props
  const alive =
    worker.state === 'running' || worker.state === 'draining' || worker.state === 'frozen'
  // A dead process takes its slots with it, but the jobs it was running keep its lock in the
  // table and their messages stay invisible: the lane shows them until another worker takes over.
  const orphaned = useMemo(
    () =>
      worker.state === 'dead'
        ? jobs.filter((job) => job.lockedBy === worker.id && job.status === 'PROCESSING')
        : [],
    [jobs, worker.id, worker.state]
  )
  const countdown =
    worker.until !== null && worker.until > now ? secondsUntil(worker.until, now) : null
  const stateText =
    worker.state === 'frozen' && countdown !== null
      ? `frozen, thaws in ${countdown} s`
      : worker.state === 'draining' && countdown !== null
        ? `draining, deadline in ${countdown} s`
        : WORKER_LABELS[worker.state]
  const slots = Array.from({ length: worker.maxConcurrent }, (_, i) => worker.slots[i] ?? null)
  const orphanSlots = Array.from({ length: worker.maxConcurrent }, (_, i) => orphaned[i] ?? null)

  return (
    <div className={`lane lane-${worker.state}`}>
      <header>
        <h3 className="mono">{worker.id}</h3>
        <span className={`pill pill-${WORKER_TONE[worker.state]}`}>
          <span className="dot" aria-hidden="true" />
          {stateText}
        </span>
        <span
          className="small muted num lane-counts"
          title="Finished on this worker: completed, failed"
        >
          {worker.completed} done, {worker.failed} failed
        </span>
        <span className="spacer" />
        <div className="lane-actions">
          {alive ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={worker.state !== 'running'}
                onClick={() => props.onFreeze(worker.id, FREEZE_SECONDS)}
                title={`The process stops making progress for ${FREEZE_SECONDS} s without dying. Its messages' visibility timeout runs out first, so the other worker takes over and this one's late writes are discarded.`}
              >
                Freeze
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={worker.state === 'draining'}
                onClick={() => props.onDrain(worker.id)}
                title="SIGTERM: stop receiving, finish the jobs in hand, interrupt what is left at the drain timeout, exit."
              >
                Drain
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-danger"
                onClick={() => props.onKill(worker.id)}
                title="The process dies mid-job. Its locks and invisible messages stay until the visibility timeout; then the other worker takes over."
              >
                Kill
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => props.onRestart(worker.id)}
              title="A fresh process with the same worker id"
            >
              Restart
            </button>
          )}
        </div>
      </header>
      <div className="slots">
        {worker.state === 'dead'
          ? orphanSlots.map((job, i) => {
              if (job === null) {
                return (
                  <div key={i} className="slot idle">
                    <span className="small muted">idle</span>
                  </div>
                )
              }
              const message = messageByJob.get(job.id)
              const visibleIn =
                message?.invisibleUntil !== null && message?.invisibleUntil !== undefined
                  ? secondsUntil(message.invisibleUntil, now)
                  : null
              const cid = job.correlationId
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`slot busy held ${selected === cid ? 'selected' : ''}`}
                  onClick={() => onSelect(selected === cid ? null : cid)}
                  title={`${cid}: still locked by the dead process; its message becomes visible again ${visibleIn === null ? 'soon' : `in ${visibleIn} s`}, and the next worker to receive it takes the lock over`}
                >
                  <span className="bar" style={{ width: '100%' }} aria-hidden="true" />
                  <span className="mono cid">{cid}</span>
                  <span className="small num attempt">lock held</span>
                  <span className="small num elapsed">
                    {visibleIn === null ? '' : `visible in ${visibleIn} s`}
                  </span>
                </button>
              )
            })
          : slots.map((slot, i) => {
              if (slot === null) {
                return (
                  <div key={i} className="slot idle">
                    <span className="small muted">idle</span>
                  </div>
                )
              }
              const job = byId.get(slot.jobId)
              const total = Math.max(1, slot.finishesAt - slot.startedAt)
              const progress = Math.min(1, Math.max(0, (now - slot.startedAt) / total))
              const cid = job?.correlationId ?? slot.jobId
              const held = worker.state === 'frozen'
              return (
                <button
                  key={slot.jobId}
                  type="button"
                  className={`slot busy ${held ? 'held' : ''} ${selected === cid ? 'selected' : ''}`}
                  onClick={() => onSelect(selected === cid ? null : cid)}
                  title={`${cid}: attempt ${slot.attempt} of ${job?.maxAttempts ?? '?'}${job ? `, ${job.type}` : ''}`}
                >
                  <span
                    className="bar"
                    style={{ width: `${progress * 100}%` }}
                    aria-hidden="true"
                  />
                  <span className="mono cid">{cid}</span>
                  <span className="small num attempt">try {slot.attempt}</span>
                  <span className="small num elapsed">
                    {((now - slot.startedAt) / 1000).toFixed(1)} s
                  </span>
                </button>
              )
            })}
      </div>
    </div>
  )
})

interface S3Props {
  jobs: Job[]
  selected: string | null
  onSelect: (correlationId: string | null) => void
}

const S3Node = memo(function S3Node({ jobs, selected, onSelect }: S3Props) {
  const stored = jobs.filter((j) => j.status === 'COMPLETED')
  return (
    <div className="node node-s3">
      <header>
        <h3>S3 bucket</h3>
        <span className="num depth">{stored.length}</span>
      </header>
      <ul className="recent">
        {stored.slice(0, 4).map((job) => (
          <li key={job.id}>
            <button
              type="button"
              className={`linkish mono ${selected === job.correlationId ? 'selected' : ''}`}
              onClick={() => onSelect(selected === job.correlationId ? null : job.correlationId)}
              title={job.fileKey ?? ''}
            >
              {job.fileKey ? job.fileKey.split('/').pop() : shortId(job.id)}
            </button>
          </li>
        ))}
        {stored.length === 0 && <li className="small muted">No files yet</li>}
      </ul>
      <p className="small muted rule">presigned links, valid 60 minutes</p>
    </div>
  )
})

interface DlqProps {
  dlq: QueueMessage[]
  jobs: Job[]
  selected: string | null
  onSelect: (correlationId: string | null) => void
}

/**
 * The consumer deletes each message once the job is marked, so the queue itself is usually empty;
 * the node counts the jobs that have been through it and shows the message count while one waits.
 */
const DlqNode = memo(function DlqNode({ dlq, jobs, selected, onSelect }: DlqProps) {
  const deadLettered = jobs
    .filter((j) => j.deadLetteredAt !== null)
    .sort((a, b) => (b.deadLetteredAt ?? 0) - (a.deadLetteredAt ?? 0))
  return (
    <div className={`node node-dlq ${deadLettered.length > 0 ? 'has-items' : ''}`}>
      <header>
        <h3>Dead-letter queue</h3>
        <span className="num depth">{deadLettered.length}</span>
      </header>
      <p className="small muted">
        <span className="num">{dlq.length}</span> waiting for the consumer
      </p>
      <ul className="recent">
        {deadLettered.slice(0, 4).map((job) => (
          <li key={job.id}>
            <button
              type="button"
              className={`linkish mono ${selected === job.correlationId ? 'selected' : ''}`}
              onClick={() => onSelect(selected === job.correlationId ? null : job.correlationId)}
              title={`${job.type}: ${job.errorMessage ?? ''}`}
            >
              {job.correlationId}
            </button>
          </li>
        ))}
        {deadLettered.length === 0 && <li className="small muted">Nothing dead-lettered</li>}
      </ul>
      <p className="small muted rule">consumer polls every 5 s, marks the job FAILED</p>
    </div>
  )
})
