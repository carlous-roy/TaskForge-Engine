// Tests for java.ts: the Java library behaviours whose edge cases show up in messages and logs.

import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatInstant,
  formatLocalDate,
  isBlank,
  minusDays,
  parseInteger,
  parseLocalDate,
  today,
  trim,
} from './java.ts'

describe('strings', () => {
  it('trims what String.trim trims, controls included, and not no-break spaces', () => {
    expect(trim(' \t North \n')).toBe('North')
    expect(trim('\u0001North\u0007')).toBe('North')
    expect(trim('\u00a0North\u00a0')).toBe('\u00a0North\u00a0')
  })

  it('calls blank what String.isBlank calls blank', () => {
    expect(isBlank('')).toBe(true)
    expect(isBlank(' \t\n\u2003')).toBe(true)
    expect(isBlank('\u00a0')).toBe(false)
    expect(isBlank('\u0000')).toBe(false)
  })
})

describe('parseInteger', () => {
  it('parses as Integer.parseInt and Long.parseLong do', () => {
    expect(parseInteger('15', 32)).toBe(15n)
    expect(parseInteger('+15', 32)).toBe(15n)
    expect(parseInteger('-0005', 32)).toBe(-5n)
    expect(parseInteger('\u0661\u0665', 32)).toBe(15n)
    expect(parseInteger('\uff19', 32)).toBe(9n)
    expect(parseInteger('2147483647', 32)).toBe(2147483647n)
    expect(parseInteger('-2147483648', 32)).toBe(-2147483648n)
    expect(parseInteger('9223372036854775807', 64)).toBe(9223372036854775807n)
  })

  it('returns null where they throw NumberFormatException', () => {
    for (const value of ['', '+', '-', '1.5', '1e3', ' 1', '0x10', '2147483648']) {
      expect(parseInteger(value, 32)).toBeNull()
    }
    expect(parseInteger('9223372036854775808', 64)).toBeNull()
  })
})

describe('LocalDate', () => {
  it('parses ISO_LOCAL_DATE strictly', () => {
    expect(parseLocalDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 })
    expect(parseLocalDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseLocalDate('+12026-01-01')).toEqual({ year: 12026, month: 1, day: 1 })
    expect(parseLocalDate('-0044-03-15')).toEqual({ year: -44, month: 3, day: 15 })
    for (const value of [
      '2026-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-1-5',
      '+2026-01-01',
      '12026-01-01',
      '-0000-01-01',
      '2026-01-01T00:00',
      'yesterday',
    ]) {
      expect(parseLocalDate(value)).toBeNull()
    }
  })

  it('prints as LocalDate.toString does', () => {
    expect(formatLocalDate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05')
    expect(formatLocalDate({ year: 12026, month: 1, day: 5 })).toBe('+12026-01-05')
    expect(formatLocalDate({ year: -5, month: 12, day: 31 })).toBe('-0005-12-31')
    expect(formatLocalDate({ year: 33, month: 3, day: 3 })).toBe('0033-03-03')
  })

  it('knows the simulated day and counts back from it', () => {
    expect(today(0)).toEqual({ year: 2026, month: 9, day: 18 })
    expect(today(12 * 3_600_000)).toEqual({ year: 2026, month: 9, day: 19 })
    expect(minusDays({ year: 2026, month: 9, day: 18 }, 30)).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    })
    expect(minusDays({ year: 2024, month: 3, day: 1 }, 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    })
  })
})

describe('Duration and Instant', () => {
  it('prints durations as Duration.toString does', () => {
    expect(formatDuration(0)).toBe('PT0S')
    expect(formatDuration(500)).toBe('PT0.5S')
    expect(formatDuration(1_001)).toBe('PT1.001S')
    expect(formatDuration(5_000)).toBe('PT5S')
    expect(formatDuration(30_000)).toBe('PT30S')
    expect(formatDuration(60_000)).toBe('PT1M')
    expect(formatDuration(90_000)).toBe('PT1M30S')
    expect(formatDuration(120_000)).toBe('PT2M')
    expect(formatDuration(3_600_000)).toBe('PT1H')
  })

  it('prints instants as Instant.toString does, counting from the simulation epoch', () => {
    expect(formatInstant(0)).toBe('2026-09-18T12:00:00Z')
    expect(formatInstant(1)).toBe('2026-09-18T12:00:00.001Z')
    expect(formatInstant(120_250)).toBe('2026-09-18T12:02:00.250Z')
  })
})
