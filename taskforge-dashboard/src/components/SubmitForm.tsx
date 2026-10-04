import { useState } from 'react'
import { REPORT_TYPES, type ReportType } from '../sim/types.ts'
import { TYPE_LABELS } from '../lib/format.ts'
import { PARAMETER_HINTS, compactParameters, presetFor } from '../lib/presets.ts'

export interface SubmitRequestBody {
  type: ReportType
  parameters: Record<string, string>
  idempotencyKey?: string
}

/** What came back, in the form's terms: tone for the colour, text for the line, and the ids to link. */
export interface Outcome {
  tone: 'green' | 'amber' | 'red' | 'violet'
  text: string
  correlationId?: string
  details?: string[]
}

interface Props {
  /** Dates the presets: the simulated clock's day or the real one. */
  todayMs: number
  onSubmit: (body: SubmitRequestBody) => Promise<Outcome>
  onSelect?: (correlationId: string) => void
  /** The form's own copy, so the two editions can explain the key differently. */
  keyHint: string
}

export default function SubmitForm({ todayMs, onSubmit, onSelect, keyHint }: Props) {
  const [type, setType] = useState<ReportType>('SALES_SUMMARY')
  const [values, setValues] = useState<Record<string, string>>(() =>
    presetFor('SALES_SUMMARY', todayMs)
  )
  const [key, setKey] = useState('')
  const [keyCounter, setKeyCounter] = useState(1)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [lastBody, setLastBody] = useState<SubmitRequestBody | null>(null)

  const chooseType = (next: ReportType) => {
    setType(next)
    setValues(presetFor(next, todayMs))
  }

  const send = async (body: SubmitRequestBody) => {
    setBusy(true)
    try {
      const result = await onSubmit(body)
      setOutcome(result)
      setLastBody(body)
    } finally {
      setBusy(false)
    }
  }

  const body = (): SubmitRequestBody => {
    const trimmedKey = key.trim()
    return {
      type,
      parameters: compactParameters(values),
      ...(trimmedKey ? { idempotencyKey: trimmedKey } : {}),
    }
  }

  return (
    <form
      className="submit-form"
      onSubmit={(e) => {
        e.preventDefault()
        void send(body())
      }}
    >
      <div className="field">
        <span className="field-label" id="type-label">
          Report type
        </span>
        <div className="segmented types" role="group" aria-labelledby="type-label">
          {REPORT_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => chooseType(t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="params">
        {PARAMETER_HINTS[type].map(({ name, hint }) => (
          <div className="field" key={name}>
            <label htmlFor={`param-${name}`} className="mono-label">
              {name}
            </label>
            <input
              id={`param-${name}`}
              className="input mono"
              value={values[name] ?? ''}
              placeholder={hint}
              onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        ))}
      </div>

      <div className="field">
        <label htmlFor="idempotency-key">
          Idempotency key <span className="muted">(optional)</span>
        </label>
        <div className="key-row">
          <input
            id="idempotency-key"
            className="input mono"
            value={key}
            maxLength={128}
            placeholder="order-2026-09-18-01"
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setKey(
                `order-${new Date(todayMs).toISOString().slice(0, 10)}-${String(keyCounter).padStart(2, '0')}`
              )
              setKeyCounter(keyCounter + 1)
            }}
            title="Fill in a key, then submit twice to see the second request rejected"
          >
            Generate
          </button>
        </div>
        <p className="small muted">{keyHint}</p>
      </div>

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Submitting' : 'Submit report'}
        </button>
        {lastBody?.idempotencyKey && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void send(lastBody)}
            title={`Sends the same request again with key ${lastBody.idempotencyKey}`}
          >
            Send the same key again
          </button>
        )}
      </div>

      {outcome && (
        <div className={`outcome tone-${outcome.tone}`} role="status">
          <span>{outcome.text}</span>
          {outcome.correlationId && onSelect && (
            <button
              type="button"
              className="linkish mono"
              onClick={() => onSelect(outcome.correlationId as string)}
              title="Follow this job through the board and the log"
            >
              {outcome.correlationId}
            </button>
          )}
          {outcome.details && outcome.details.length > 0 && (
            <ul className="details">
              {outcome.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  )
}
