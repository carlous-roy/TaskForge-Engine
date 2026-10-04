import { useState } from 'react'
import type { FaultKind } from '../sim/faults.ts'
import type { SimConfig, SubmitResult } from '../sim/types.ts'
import { presetFor } from '../lib/presets.ts'

interface Props {
  armed: FaultKind | null
  onArm: (kind: FaultKind | null) => void
  onBurst: (
    n: number,
    request: { type: 'SALES_SUMMARY'; parameters: Record<string, string> }
  ) => SubmitResult[]
  traffic: boolean
  onTraffic: (on: boolean) => void
  todayMs: number
  config: SimConfig
}

export const BURST_SIZE = 70

/** The faults a visitor can inject from the deck; the worker buttons live on the lanes themselves. */
export default function ControlDeck({
  armed,
  onArm,
  onBurst,
  traffic,
  onTraffic,
  todayMs,
  config,
}: Props) {
  const [burstNote, setBurstNote] = useState<string | null>(null)

  const burst = () => {
    const results = onBurst(BURST_SIZE, {
      type: 'SALES_SUMMARY',
      parameters: presetFor('SALES_SUMMARY', todayMs),
    })
    const accepted = results.filter((r) => r.status === 202).length
    const limited = results.filter((r) => r.status === 429)
    const retryAfter = limited.reduce(
      (m, r) => (r.status === 429 ? Math.max(m, r.retryAfterSeconds) : m),
      0
    )
    setBurstNote(
      limited.length === 0
        ? `${accepted} accepted. The window still had room for all of them.`
        : `${accepted} accepted, ${limited.length} rejected with 429 and Retry-After ${retryAfter} s.`
    )
  }

  return (
    <div className="deck">
      <div className="deck-group">
        <div className="deck-head">
          <h3>Poison the next job</h3>
          <div className="segmented" role="group" aria-label="Fault to inject">
            <button type="button" aria-pressed={armed === null} onClick={() => onArm(null)}>
              Off
            </button>
            <button
              type="button"
              aria-pressed={armed === 'transient'}
              onClick={() => onArm('transient')}
            >
              Transient
            </button>
            <button
              type="button"
              aria-pressed={armed === 'permanent'}
              onClick={() => onArm('permanent')}
            >
              Permanent
            </button>
          </div>
        </div>
        <p className="small muted">
          {armed === 'transient'
            ? `The next job a worker starts fails its S3 upload on every attempt. Watch it come back after a jittered delay (${config.backoffBaseS} s doubling, capped at ${config.backoffCapS} s), then land on the dead-letter queue after attempt ${config.maxAttempts}.`
            : armed === 'permanent'
              ? 'The next job a worker starts has parameters the worker rejects. One attempt, then FAILED: a permanent error is never retried.'
              : `A transient fault retries with backoff and dead-letters after ${config.maxAttempts} attempts; a permanent one fails at once.`}
        </p>
      </div>

      <div className="deck-group">
        <div className="deck-head">
          <h3>Flood the API</h3>
          <button type="button" className="btn btn-sm btn-warn" onClick={burst}>
            Send {BURST_SIZE} at once
          </button>
        </div>
        <p className="small muted">
          {burstNote ??
            `The limit is ${config.rateLimitPerMinute} requests a minute per client, counted in a fixed window. Anything past it gets a 429 with a Retry-After header.`}
        </p>
      </div>

      <div className="deck-group">
        <div className="deck-head">
          <h3>Background traffic</h3>
          <label className="switch">
            <input
              type="checkbox"
              checked={traffic}
              onChange={(e) => onTraffic(e.target.checked)}
            />
            <span className="track" aria-hidden="true" />
            <span className="small">{traffic ? 'On' : 'Off'}</span>
          </label>
        </div>
        <p className="small muted">
          A report every few seconds, so there is always something on the board. Turn it off to
          follow one job on its own.
        </p>
      </div>

      <div className="deck-group">
        <h3>Break a worker</h3>
        <p className="small muted">
          Freeze, Drain and Kill sit on each worker lane. Freeze and Kill hold the jobs in hand past
          the {config.visibilityTimeoutS} s visibility timeout, so the other lane takes them over;
          Drain is the SIGTERM path, which finishes them first.
        </p>
      </div>
    </div>
  )
}
