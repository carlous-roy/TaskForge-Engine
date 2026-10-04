import { describe, expect, it } from 'vitest'
import { clock, duration, isoDate, logClock, secondsUntil, shortId } from '../format.ts'

describe('format', () => {
  const t = Date.UTC(2026, 8, 18, 12, 3, 4, 567)

  it('prints clocks in UTC', () => {
    expect(clock(t)).toBe('12:03:04')
    expect(logClock(t)).toBe('12:03:04.567')
    expect(isoDate(t)).toBe('2026-09-18')
  })

  it('prints durations at the scale they are read at', () => {
    expect(duration(850)).toBe('850 ms')
    expect(duration(2_400)).toBe('2.4 s')
    expect(duration(65_000)).toBe('1m 05s')
  })

  it('rounds countdowns up and never below zero', () => {
    expect(secondsUntil(t + 1_001, t)).toBe(2)
    expect(secondsUntil(t - 5, t)).toBe(0)
    expect(shortId('6ae6def5-1234-5678-9abc-def012345678')).toBe('6ae6def5')
  })
})
