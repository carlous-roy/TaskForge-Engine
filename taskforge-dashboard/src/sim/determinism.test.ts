// Scenario 10: the same configuration, seed and commands give the same state, log included, and
// reset starts over from exactly that. Also the snapshot contract: immutable, shared while
// unchanged, and a clock that only moves on advance.

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './config.ts'
import { Simulation } from './simulation.ts'
import type { SimState } from './types.ts'

/** A run that touches every command: faults, a burst, duplicates, kill, freeze, drain, restart. */
function script(sim: Simulation): SimState {
  sim.arm('transient')
  sim.submit({ type: 'SALES_SUMMARY', parameters: { region: 'North' }, correlationId: 'script-1' })
  sim.burst(4, { type: 'INVENTORY_SNAPSHOT', parameters: { lowStockThreshold: '5' } })
  sim.advance(1_500)
  sim.killWorker('worker-2')
  sim.submit({ type: 'USER_ACTIVITY', parameters: {}, idempotencyKey: 'same' })
  sim.submit({ type: 'USER_ACTIVITY', parameters: {}, idempotencyKey: 'same' })
  for (let i = 0; i < 300; i++) sim.advance(1000 / 3)
  sim.arm('permanent')
  sim.freezeWorker('worker-1', 2.5)
  sim.restartWorker('worker-2')
  sim.submit({ type: 'SALES_SUMMARY', parameters: {} })
  sim.advance(4_000)
  sim.drainWorker('worker-1')
  sim.burst(70, { type: 'SALES_SUMMARY', parameters: {} })
  sim.advance(200_000)
  return sim.state()
}

describe('scenario 10: determinism', () => {
  it('replays a scripted run to the same state, log included', () => {
    const first = script(new Simulation())
    const second = script(new Simulation())
    expect(second).toEqual(first)
    expect(first.log.length).toBeGreaterThan(100)
    expect(
      first.stats.takeovers + first.stats.deadLettered + first.stats.rateLimited
    ).toBeGreaterThan(0)
  })

  it('gives another seed other ids and timings', () => {
    const a = script(new Simulation({ seed: 1 }))
    const b = script(new Simulation({ seed: 2 }))
    expect(b.jobs.map((job) => job.id)).not.toEqual(a.jobs.map((job) => job.id))
    expect(b.seed).toBe(2)
  })

  it('resets to the state of a fresh simulation, with the same seed or a new one', () => {
    const sim = new Simulation()
    script(sim)
    sim.reset()
    expect(sim.state()).toEqual(new Simulation().state())
    expect(script(sim)).toEqual(script(new Simulation()))

    sim.reset(7)
    expect(sim.state().seed).toBe(7)
    expect(sim.config.seed).toBe(DEFAULT_CONFIG.seed)
    expect(script(sim)).toEqual(script(new Simulation({ seed: 7 })))
  })
})

describe('the snapshot', () => {
  it('is frozen, and the same object until something changes', () => {
    const sim = new Simulation()
    const before = sim.state()
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(before.jobs)).toBe(true)
    expect(Object.isFrozen(before.workers[0])).toBe(true)
    expect(sim.state()).toBe(before)

    sim.submit({ type: 'SALES_SUMMARY', parameters: {} })
    const after = sim.state()
    expect(after).not.toBe(before)
    expect(after.workers).toBe(before.workers)
    expect(after.history).toBe(before.history)
    expect(after.jobs).not.toBe(before.jobs)
    expect(Object.isFrozen(after.jobs[0])).toBe(true)
  })

  it('moves the clock only on advance, carrying fractions of a millisecond', () => {
    const sim = new Simulation()
    for (let i = 0; i < 3; i++) sim.advance(0.4)
    expect(sim.state().time).toBe(1)
    for (let i = 0; i < 60; i++) sim.advance(1000 / 60)
    expect(sim.state().time).toBe(1_001)
    expect(() => sim.advance(-1)).toThrow(RangeError)
    expect(() => sim.advance(Number.NaN)).toThrow(RangeError)
  })

  it('caps the log at 2,000 lines and keeps the newest', () => {
    const sim = new Simulation({ rateLimitPerMinute: 10_000, workers: 4, maxConcurrent: 10 })
    for (let round = 0; round < 6; round++) {
      sim.burst(100, { type: 'USER_ACTIVITY', parameters: {} })
      sim.advance(3_000)
    }
    const { log } = sim.state()
    expect(log).toHaveLength(2_000)
    const seqs = log.map((line) => line.seq)
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i))
    expect(seqs[0]).toBeGreaterThan(1)
  })

  it('checks its configuration against the services bounds', () => {
    expect(() => new Simulation({ maxConcurrent: 0 })).toThrow(
      'maxConcurrent must be an integer from 1 to 64'
    )
    expect(() => new Simulation({ batchSize: 11 })).toThrow(
      'batchSize must be an integer from 1 to 10'
    )
    expect(() => new Simulation({ maxAttempts: 101 })).toThrow(
      'maxAttempts must be an integer from 1 to 100'
    )
    expect(() => new Simulation({ backoffBaseS: 5, backoffCapS: 1 })).toThrow(
      'cap must be at least base'
    )
    expect(() => new Simulation({ generationMs: [900, 100] })).toThrow(RangeError)
    expect(() => new Simulation().killWorker('worker-9')).toThrow('no worker worker-9')
  })
})
