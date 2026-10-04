// The browser edition's driver: one Simulation, advanced on animation frames at the chosen speed,
// with background traffic submitted at the exact simulated instants it is due. Commands apply at
// once and publish a fresh snapshot, so the board reacts even while the clock is paused.

import { useCallback, useEffect, useState } from 'react'
import { Simulation, SIM_EPOCH_MS } from '../sim/index.ts'
import type { FaultKind } from '../sim/faults.ts'
import type { SimConfig, SimState, SubmitRequest, SubmitResult } from '../sim/types.ts'
import { Traffic } from '../lib/traffic.ts'

export type Speed = 0 | 1 | 5 | 20
export const SPEEDS: Speed[] = [1, 5, 20]

/** How far a run is taken before the page shows it, so the first screen has work on it. */
export const WARM_START_MS = 45_000

/**
 * The console's own settings on top of the service's: report generation takes a little longer
 * than it does on the sample dataset, so a job is on its lane long enough to watch.
 */
export const CONSOLE_CONFIG: Partial<SimConfig> = { generationMs: [1200, 3600] }

/** A real frame longer than this (a hidden tab, a stall) counts as this long: the run pauses rather than catching up in one jump. */
const MAX_FRAME_MS = 100

/** One answer from the simulated API to something the visitor did, for the ticker on the API node. */
export interface Response {
  seq: number
  /** Simulation time of the answer. */
  t: number
  status: SubmitResult['status']
  /** The correlation id the API bound to the request. */
  correlationId: string
  summary: string
}

const RESPONSES_KEPT = 40

interface Session {
  sim: Simulation
  traffic: Traffic
  trafficOn: boolean
  responses: Response[]
  nextSeq: number
}

/** Advances the run by `ms`, submitting the traffic due inside that window at its own instants. */
function run(session: Session, ms: number): void {
  const { sim } = session
  let now = sim.state().time
  const end = now + ms
  while (session.trafficOn && session.traffic.nextAt <= end) {
    const step = session.traffic.nextAt - now
    if (step > 0) sim.advance(step)
    now = session.traffic.nextAt
    sim.submit(session.traffic.next(SIM_EPOCH_MS + now))
  }
  if (end > now) sim.advance(end - now)
}

function warmStart(session: Session): void {
  run(session, WARM_START_MS)
}

function createSession(seed?: number): Session {
  const sim = new Simulation(seed === undefined ? CONSOLE_CONFIG : { ...CONSOLE_CONFIG, seed })
  const session: Session = {
    sim,
    traffic: new Traffic(sim.state().seed),
    trafficOn: true,
    responses: [],
    nextSeq: 1,
  }
  warmStart(session)
  return session
}

function summarize(result: SubmitResult): string {
  switch (result.status) {
    case 202:
      return `202 Accepted: ${result.job.type} ${result.job.id.slice(0, 8)}`
    case 409:
      return `409 Conflict: key already used by ${result.existingReportId.slice(0, 8)}`
    case 429:
      return `429 Too Many Requests: retry after ${result.retryAfterSeconds} s`
    case 400:
      return `400 Bad Request: ${result.details[0] ?? result.message}`
  }
}

export interface Console {
  state: SimState
  config: SimConfig
  speed: Speed
  setSpeed: (speed: Speed) => void
  /** Advances a paused run by `ms`. */
  step: (ms: number) => void
  traffic: boolean
  setTraffic: (on: boolean) => void
  responses: Response[]
  submit: (request: SubmitRequest) => SubmitResult
  burst: (n: number, request: SubmitRequest) => SubmitResult[]
  arm: (kind: FaultKind | null) => void
  killWorker: (id: string) => void
  freezeWorker: (id: string, seconds: number) => void
  drainWorker: (id: string) => void
  restartWorker: (id: string) => void
  reset: (seed?: number) => void
}

export function useSimulation(): Console {
  const [session, setSession] = useState<Session>(() => createSession())
  const [state, setState] = useState<SimState>(() => session.sim.state())
  const [responses, setResponses] = useState<Response[]>([])
  const [speed, setSpeed] = useState<Speed>(1)
  const [traffic, setTrafficState] = useState(true)

  const publish = useCallback(() => {
    setState(session.sim.state())
  }, [session])

  useEffect(() => {
    if (speed === 0) return
    let last = performance.now()
    let frame = requestAnimationFrame(function tick(now: number) {
      const real = Math.min(Math.max(0, now - last), MAX_FRAME_MS)
      last = now
      run(session, real * speed)
      publish()
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [session, speed, publish])

  const record = useCallback(
    (results: SubmitResult[]) => {
      const t = session.sim.state().time
      for (const result of results) {
        session.responses.push({
          seq: session.nextSeq++,
          t,
          status: result.status,
          correlationId: result.status === 202 ? result.job.correlationId : result.correlationId,
          summary: summarize(result),
        })
      }
      if (session.responses.length > RESPONSES_KEPT) {
        session.responses = session.responses.slice(-RESPONSES_KEPT)
      }
      setResponses([...session.responses])
      publish()
    },
    [session, publish]
  )

  const submit = useCallback(
    (request: SubmitRequest) => {
      const result = session.sim.submit(request)
      record([result])
      return result
    },
    [session, record]
  )

  const burst = useCallback(
    (n: number, request: SubmitRequest) => {
      const results = session.sim.burst(n, request)
      record(results)
      return results
    },
    [session, record]
  )

  const command = useCallback(
    (action: (sim: Simulation) => void) => {
      action(session.sim)
      publish()
    },
    [session, publish]
  )

  const setTraffic = useCallback(
    (on: boolean) => {
      session.trafficOn = on
      if (on) session.traffic.resumeAt(session.sim.state().time)
      setTrafficState(on)
    },
    [session]
  )

  const reset = useCallback(
    (seed?: number) => {
      const next = createSession(seed ?? session.sim.state().seed)
      next.trafficOn = session.trafficOn
      setSession(next)
      setState(next.sim.state())
      setResponses([])
    },
    [session]
  )

  return {
    state,
    config: session.sim.config,
    speed,
    setSpeed,
    step: (ms) => {
      run(session, ms)
      publish()
    },
    traffic,
    setTraffic,
    responses,
    submit,
    burst,
    arm: (kind) => command((sim) => sim.arm(kind)),
    killWorker: (id) => command((sim) => sim.killWorker(id)),
    freezeWorker: (id, seconds) => command((sim) => sim.freezeWorker(id, seconds)),
    drainWorker: (id) => command((sim) => sim.drainWorker(id)),
    restartWorker: (id) => command((sim) => sim.restartWorker(id)),
    reset,
  }
}
