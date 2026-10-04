// Tests for events.ts: the agenda runs in time order, then lane, then scheduling order, and the
// clock only moves when it is run.

import { describe, expect, it } from 'vitest'
import { EventLoop } from './events.ts'

describe('EventLoop', () => {
  it('runs events in time order, then lane, then the order they were scheduled in', () => {
    const loop = new EventLoop()
    const seen: string[] = []
    loop.at(20, () => seen.push('b@20'))
    loop.at(10, () => seen.push('late lane@10'), 1)
    loop.at(10, () => seen.push('first@10'))
    loop.at(10, () => seen.push('second@10'))
    loop.at(5, () => seen.push('a@5'))
    loop.runUntil(100)
    expect(seen).toEqual(['a@5', 'first@10', 'second@10', 'late lane@10', 'b@20'])
    expect(loop.now).toBe(100)
  })

  it('stops at the target, runs what an event schedules, and skips cancelled events', () => {
    const loop = new EventLoop()
    const seen: number[] = []
    loop.at(10, () => {
      seen.push(loop.now)
      loop.at(loop.now + 5, () => seen.push(loop.now))
    })
    loop.at(12, () => seen.push(-1)).cancel()
    loop.at(50, () => seen.push(loop.now))
    loop.runUntil(30)
    expect(seen).toEqual([10, 15])
    expect(loop.now).toBe(30)
    loop.runUntil(50)
    expect(seen).toEqual([10, 15, 50])
  })

  it('never schedules into the past', () => {
    const loop = new EventLoop()
    loop.runUntil(100)
    let ranAt = -1
    loop.at(40, () => {
      ranAt = loop.now
    })
    loop.runUntil(100)
    expect(ranAt).toBe(100)
  })

  it('keeps its order across many entries', () => {
    const loop = new EventLoop()
    const seen: number[] = []
    const times = Array.from({ length: 500 }, (_, i) => (i * 7919) % 997)
    for (const t of times) loop.at(t, () => seen.push(t))
    loop.runUntil(1000)
    expect(seen).toEqual([...times].sort((a, b) => a - b))
  })
})
