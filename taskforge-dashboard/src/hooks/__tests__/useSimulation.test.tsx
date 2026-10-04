// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WARM_START_MS, useSimulation } from '../useSimulation.ts'

const SALES = { type: 'SALES_SUMMARY' as const, parameters: { region: 'North' } }

describe('useSimulation', () => {
  it('starts with a warmed-up run that has traffic on the board', () => {
    const { result } = renderHook(() => useSimulation())
    act(() => result.current.setSpeed(0))
    const { state } = result.current
    expect(state.time).toBeGreaterThanOrEqual(WARM_START_MS)
    expect(state.stats.accepted).toBeGreaterThan(5)
    expect(state.workers.map((w) => w.id)).toEqual(['worker-1', 'worker-2'])
    expect(result.current.traffic).toBe(true)
  })

  it('answers submissions like the API and records them for the ticker', () => {
    const { result } = renderHook(() => useSimulation())
    act(() => result.current.setSpeed(0))
    let first: ReturnType<typeof result.current.submit> | undefined
    let second: ReturnType<typeof result.current.submit> | undefined
    act(() => {
      first = result.current.submit({ ...SALES, idempotencyKey: 'order-1' })
      second = result.current.submit({ ...SALES, idempotencyKey: 'order-1' })
    })
    expect(first?.status).toBe(202)
    expect(second?.status).toBe(409)
    if (first?.status === 202 && second?.status === 409) {
      expect(second.existingReportId).toBe(first.job.id)
    }
    expect(result.current.responses.map((r) => r.status)).toEqual([202, 409])
    expect(result.current.state.stats.rejectedDuplicates).toBe(1)
  })

  it('rate-limits a burst past sixty in the window', () => {
    const { result } = renderHook(() => useSimulation())
    act(() => result.current.setSpeed(0))
    let results: ReturnType<typeof result.current.burst> = []
    act(() => {
      results = result.current.burst(70, SALES)
    })
    const limited = results.filter((r) => r.status === 429)
    expect(limited.length).toBeGreaterThanOrEqual(10)
    expect(results.filter((r) => r.status === 202).length + limited.length).toBe(70)
    expect(result.current.state.stats.rateLimited).toBe(limited.length)
  })

  it('steps a paused run and lets traffic be turned off', () => {
    const { result } = renderHook(() => useSimulation())
    act(() => {
      result.current.setSpeed(0)
      result.current.setTraffic(false)
    })
    const before = result.current.state
    act(() => result.current.step(30_000))
    const after = result.current.state
    expect(after.time).toBe(before.time + 30_000)
    expect(after.stats.accepted).toBe(before.stats.accepted)
    act(() => result.current.setTraffic(true))
    act(() => result.current.step(30_000))
    expect(result.current.state.stats.accepted).toBeGreaterThan(before.stats.accepted)
  })

  it('kills, restarts and resets', () => {
    const { result } = renderHook(() => useSimulation())
    act(() => result.current.setSpeed(0))
    act(() => result.current.killWorker('worker-1'))
    expect(result.current.state.workers[0]?.state).toBe('dead')
    act(() => result.current.restartWorker('worker-1'))
    expect(result.current.state.workers[0]?.state).toBe('running')
    act(() => result.current.arm('transient'))
    expect(result.current.state.armed).toBe('transient')
    act(() => result.current.reset(9))
    expect(result.current.state.seed).toBe(9)
    expect(result.current.state.armed).toBeNull()
    expect(result.current.responses).toEqual([])
    expect(result.current.state.time).toBe(WARM_START_MS)
  })
})
