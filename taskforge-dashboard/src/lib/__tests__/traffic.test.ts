import { describe, expect, it } from 'vitest'
import { Traffic } from '../traffic.ts'
import { validateParameters } from '../../sim/index.ts'

const TODAY = Date.UTC(2026, 8, 18, 12)

describe('Traffic', () => {
  it('replays the same arrivals for the same seed', () => {
    const a = new Traffic(1)
    const b = new Traffic(1)
    const first = Array.from({ length: 20 }, () => [a.nextAt, a.next(TODAY)])
    const second = Array.from({ length: 20 }, () => [b.nextAt, b.next(TODAY)])
    expect(second).toEqual(first)
    expect(new Traffic(2).nextAt).not.toBe(new Traffic(1).nextAt)
  })

  it('keeps the gaps between 1.2 and 3.8 seconds and the parameters valid', () => {
    const traffic = new Traffic(7)
    let last = 0
    for (let i = 0; i < 200; i++) {
      const at = traffic.nextAt
      expect(at - last).toBeGreaterThanOrEqual(1_200)
      expect(at - last).toBeLessThan(3_800)
      const request = traffic.next(TODAY)
      expect(validateParameters(request.type, request.parameters)).toEqual([])
      last = at
    }
  })

  it('schedules a fresh gap after a pause instead of a backlog', () => {
    const traffic = new Traffic(3)
    traffic.resumeAt(60_000)
    expect(traffic.nextAt).toBeGreaterThanOrEqual(61_200)
    expect(traffic.nextAt).toBeLessThan(63_800)
    const at = traffic.nextAt
    traffic.resumeAt(at - 1)
    expect(traffic.nextAt).toBe(at)
  })
})
