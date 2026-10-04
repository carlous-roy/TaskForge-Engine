import { useState } from 'react'
import { SIM_EPOCH_MS } from '../sim/index.ts'
import { clock, isoDate } from '../lib/format.ts'
import { SPEEDS, type Speed } from '../hooks/useSimulation.ts'

interface Props {
  time: number
  seed: number
  speed: Speed
  onSpeed: (speed: Speed) => void
  onStep: (ms: number) => void
  onReset: (seed: number) => void
}

/** The simulated clock and the controls that move it: pause, speed, single steps, and a seeded reset. */
export default function Transport({ time, seed, speed, onSpeed, onStep, onReset }: Props) {
  const epoch = SIM_EPOCH_MS + time
  const paused = speed === 0

  return (
    <div className="transport">
      <div className="simclock" title="The simulated clock, in UTC like the services' own">
        <span className="small muted">{isoDate(epoch)}</span>
        <span className="num">{clock(epoch)}</span>
        <span className="tenths num" aria-hidden="true">
          .{Math.floor((time % 1000) / 100)}
        </span>
      </div>
      <div className="segmented" role="group" aria-label="Clock speed">
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => onSpeed(paused ? 1 : 0)}
          title={paused ? 'Resume' : 'Pause the clock'}
        >
          {paused ? 'Paused' : 'Pause'}
        </button>
        {SPEEDS.map((s) => (
          <button key={s} type="button" aria-pressed={speed === s} onClick={() => onSpeed(s)}>
            {s}x
          </button>
        ))}
      </div>
      {paused && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onStep(1000)}
          title="Advance the paused clock by one second"
        >
          Step 1 s
        </button>
      )}
      <SeedForm key={seed} seed={seed} onReset={onReset} />
    </div>
  )
}

/** Keyed on the seed by its parent, so a reset from elsewhere shows the seed now in use. */
function SeedForm({ seed, onReset }: { seed: number; onReset: (seed: number) => void }) {
  const [text, setText] = useState(String(seed))
  return (
    <form
      className="seed"
      onSubmit={(e) => {
        e.preventDefault()
        const next = Number(text)
        onReset(Number.isFinite(next) ? Math.trunc(next) : seed)
      }}
    >
      <label htmlFor="seed" className="small muted">
        seed
      </label>
      <input
        id="seed"
        className="input mono"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        title="A run replays exactly from its seed: same ids, same timings, same log"
      />
      <button type="submit" className="btn btn-sm" title="Start the run over from this seed">
        Reset
      </button>
    </form>
  )
}
