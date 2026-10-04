import { useCallback, useMemo, useState } from 'react'
import { SIM_EPOCH_MS } from '../sim/index.ts'
import type { ReportStatus, SubmitResult } from '../sim/types.ts'
import { useSimulation } from '../hooks/useSimulation.ts'
import TopBar from '../components/TopBar.tsx'
import Transport from '../components/Transport.tsx'
import StatStrip, { type Tile } from '../components/StatStrip.tsx'
import Sparkline from '../components/Sparkline.tsx'
import PipelineBoard from '../components/PipelineBoard.tsx'
import SubmitForm, { type Outcome, type SubmitRequestBody } from '../components/SubmitForm.tsx'
import ControlDeck from '../components/ControlDeck.tsx'
import JobsTable from '../components/JobsTable.tsx'
import LogPane from '../components/LogPane.tsx'
import Footer from '../components/Footer.tsx'
import { shortId } from '../lib/format.ts'

/** The sparkline's window: the last three simulated minutes, one point a second. */
const CHART_WINDOW = 180

export function outcomeOf(result: SubmitResult): Outcome {
  switch (result.status) {
    case 202:
      return {
        tone: 'green',
        text: `202 Accepted: ${result.job.type} as job ${shortId(result.job.id)}`,
        correlationId: result.job.correlationId,
      }
    case 409:
      return {
        tone: 'amber',
        text: `409 Conflict: that idempotency key already belongs to job ${shortId(result.existingReportId)}. Nothing was created.`,
        correlationId: result.correlationId,
      }
    case 429:
      return {
        tone: 'red',
        text: `429 Too Many Requests: the window is full. Retry-After ${result.retryAfterSeconds} s.`,
        correlationId: result.correlationId,
      }
    case 400:
      return {
        tone: 'violet',
        text: '400 Bad Request: the parameters were rejected before anything was stored.',
        correlationId: result.correlationId,
        details: result.details,
      }
  }
}

/** The browser edition: the simulator, the board and the controls that break it. */
export default function ConsolePage() {
  const sim = useSimulation()
  const { state, config } = sim
  const [selected, setSelected] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState('')
  const [filter, setFilter] = useState<ReportStatus | 'ALL'>('ALL')

  const select = useCallback((correlationId: string | null) => {
    setSelected(correlationId)
    setLogFilter(correlationId ?? '')
  }, [])

  const epochNow = SIM_EPOCH_MS + state.time
  const second = Math.floor(epochNow / 1000) * 1000
  const stats = state.stats

  const tiles: Tile[] = [
    { label: 'Accepted', value: stats.accepted, sub: '202 since start' },
    { label: 'Queued', value: stats.queued, tone: 'amber', sub: 'waiting on SQS' },
    { label: 'Processing', value: stats.processing, tone: 'cyan', sub: 'on a worker' },
    { label: 'Retrying', value: stats.retryScheduled, tone: 'amber', sub: 'backoff delay' },
    { label: 'Completed', value: stats.completed, tone: 'green', sub: 'files in S3' },
    { label: 'Failed', value: stats.failed, tone: 'red', sub: 'no attempts left' },
    {
      label: 'DLQ',
      value: stats.deadLettered,
      tone: 'red',
      sub: 'dead-lettered',
      title: 'Messages the queue moved to the dead-letter queue after their last receive',
    },
    {
      label: 'Duplicates',
      value: stats.rejectedDuplicates,
      tone: 'amber',
      sub: '409 Conflict',
      title: 'Requests rejected for a reused idempotency key',
    },
    {
      label: 'Rate limited',
      value: stats.rateLimited,
      tone: 'red',
      sub: '429 answers',
      title: 'Requests past the per-minute limit',
    },
    {
      label: 'Takeovers',
      value: stats.takeovers,
      tone: 'violet',
      sub: 'stale locks',
      title: 'Locks a worker took over from a dead or stuck one after the visibility timeout',
    },
    {
      label: 'Stale writes',
      value: stats.staleWritesDiscarded,
      tone: 'violet',
      sub: 'version check',
      title: 'Writes a worker discarded because the job had moved on without it',
    },
  ]

  const series = useMemo(
    () => [
      { name: 'queue', color: 'var(--amber)', values: state.history.map((p) => p.queueDepth) },
      { name: 'in flight', color: 'var(--cyan)', values: state.history.map((p) => p.inFlight) },
      { name: 'dlq', color: 'var(--red)', values: state.history.map((p) => p.dlqDepth) },
    ],
    [state.history]
  )

  const submit = useCallback(
    (body: SubmitRequestBody) => Promise.resolve(outcomeOf(sim.submit(body))),
    [sim]
  )

  return (
    <div className="app">
      <TopBar>
        <Transport
          time={state.time}
          seed={state.seed}
          speed={sim.speed}
          onSpeed={sim.setSpeed}
          onStep={sim.step}
          onReset={sim.reset}
        />
      </TopBar>
      <main className="console">
        <StatStrip tiles={tiles}>
          <Sparkline series={series} window={CHART_WINDOW} caption="Last three minutes" />
        </StatStrip>

        <PipelineBoard
          state={state}
          config={config}
          responses={sim.responses}
          selected={selected}
          onSelect={select}
          onKill={sim.killWorker}
          onFreeze={sim.freezeWorker}
          onDrain={sim.drainWorker}
          onRestart={sim.restartWorker}
        />

        <div className="console-grid">
          <section className="panel deck-panel" aria-label="Controls">
            <div className="panel-head">
              <h2>Submit a report</h2>
            </div>
            <div className="panel-body">
              <SubmitForm
                todayMs={epochNow}
                onSubmit={submit}
                onSelect={select}
                keyHint="Submit twice with the same key: the second request is answered 409 with the first job's id, and nothing is queued twice."
              />
            </div>
            <div className="panel-head">
              <h2>Break things</h2>
            </div>
            <div className="panel-body">
              <ControlDeck
                armed={state.armed}
                onArm={sim.arm}
                onBurst={sim.burst}
                traffic={sim.traffic}
                onTraffic={sim.setTraffic}
                todayMs={epochNow}
                config={config}
              />
            </div>
          </section>

          <JobsTable
            jobs={state.jobs}
            now={second}
            epochOffset={SIM_EPOCH_MS}
            selected={selected}
            onSelect={select}
            filter={filter}
            onFilter={setFilter}
          />

          <LogPane
            lines={state.log}
            epochOffset={SIM_EPOCH_MS}
            filter={logFilter}
            onFilter={(text) => {
              setLogFilter(text)
              if (selected && text !== selected) setSelected(null)
            }}
            onSelect={select}
          />
        </div>
      </main>
      <Footer config={config} />
    </div>
  )
}
