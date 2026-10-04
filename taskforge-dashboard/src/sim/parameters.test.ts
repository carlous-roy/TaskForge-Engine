// Tests for parameters.ts. The first cases are ReportParametersTest's, with its exact messages;
// the rest pin the Java parsing rules the port copies (Integer.parseInt, LocalDate.parse, trim).

import { describe, expect, it } from 'vitest'
import {
  allowedNames,
  InvalidReportParametersException,
  normalize,
  ReportParameters,
  validate,
} from './parameters.ts'
import { REPORT_TYPES } from './types.ts'

describe('ReportParameters', () => {
  it('has rules for every type and accepts no parameters', () => {
    for (const type of REPORT_TYPES) {
      expect(allowedNames(type).length).toBeGreaterThan(0)
      expect(validate(type, null)).toEqual([])
      expect(validate(type, {})).toEqual([])
    }
  })

  it('accepts valid sales parameters and trims the values', () => {
    const params = normalize('SALES_SUMMARY', {
      dateFrom: ' 2026-01-01 ',
      dateTo: '2026-01-31',
      region: 'North',
    })
    expect(params).toEqual({ dateFrom: '2026-01-01', dateTo: '2026-01-31', region: 'North' })
    const typed = ReportParameters.of('SALES_SUMMARY', params)
    expect(typed.dateFrom({ year: 1, month: 1, day: 1 })).toEqual({ year: 2026, month: 1, day: 1 })
    expect(typed.dateTo({ year: 1, month: 1, day: 1 })).toEqual({ year: 2026, month: 1, day: 31 })
    expect(typed.region()).toBe('North')
  })

  it('lists every problem at once', () => {
    expect(
      validate('USER_ACTIVITY', { userId: 'abc', dateFrom: 'not-a-date', bogus: '1' })
    ).toEqual([
      "parameter 'userId' must be a positive integer, got 'abc'",
      "parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got 'not-a-date'",
      "unknown parameter 'bogus' for USER_ACTIVITY; allowed: dateFrom, dateTo, userId",
    ])
  })

  it('rejects a reversed date range', () => {
    expect(validate('USER_ACTIVITY', { dateFrom: '2026-02-01', dateTo: '2026-01-01' })).toEqual([
      "parameter 'dateFrom' (2026-02-01) must not be after 'dateTo' (2026-01-01)",
    ])
  })

  it('rejects blank, null and oversized values', () => {
    expect(
      validate('SALES_SUMMARY', { region: ' ', dateTo: null, dateFrom: 'x'.repeat(101) })
    ).toEqual([
      "parameter 'region' must not be blank",
      "parameter 'dateTo' must not be blank",
      "parameter 'dateFrom' must be at most 100 characters",
    ])
  })

  it('bounds thresholds and ids', () => {
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '-1' })).toEqual([
      "parameter 'lowStockThreshold' must be between 0 and 1000000, got -1",
    ])
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '1.5' })).toEqual([
      "parameter 'lowStockThreshold' must be an integer, got '1.5'",
    ])
    expect(validate('USER_ACTIVITY', { userId: '0' })).toEqual([
      "parameter 'userId' must be a positive integer, got 0",
    ])
    expect(validate('INVENTORY_SNAPSHOT', { warehouse: 'WH\u0007EAST' })).toEqual([
      "parameter 'warehouse' must not contain control characters",
    ])
  })

  it('treats the parameters of another type as unknown', () => {
    expect(validate('INVENTORY_SNAPSHOT', { dateFrom: '2026-01-01' })).toEqual([
      "unknown parameter 'dateFrom' for INVENTORY_SNAPSHOT; allowed: warehouse, lowStockThreshold",
    ])
  })

  it('throws with every problem from normalize and of', () => {
    expect(() => ReportParameters.of('USER_ACTIVITY', { userId: 'x', extra: 'y' })).toThrow(
      InvalidReportParametersException
    )
    try {
      normalize('USER_ACTIVITY', { userId: 'x', extra: 'y' })
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidReportParametersException)
      const problems = (error as InvalidReportParametersException).problems
      expect(problems).toHaveLength(2)
      expect((error as Error).message).toBe(`Invalid report parameters: ${problems.join('; ')}`)
    }
  })

  it('falls back when a typed value is absent', () => {
    const typed = ReportParameters.of('INVENTORY_SNAPSHOT', {})
    expect(typed.warehouse()).toBeNull()
    expect(typed.lowStockThreshold(10)).toBe(10)
    expect(ReportParameters.of('USER_ACTIVITY', { userId: '42' }).userId()).toBe(42n)
  })
})

describe('the Java parsing rules behind them', () => {
  it('accepts what Integer.parseInt and Long.parseLong accept', () => {
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '+15' })).toEqual([])
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '\u0661\u0665' })).toEqual([])
    expect(
      ReportParameters.of('INVENTORY_SNAPSHOT', { lowStockThreshold: '007' }).lowStockThreshold(10)
    ).toBe(7)
    expect(validate('USER_ACTIVITY', { userId: '9223372036854775807' })).toEqual([])
  })

  it('reports overflow as not a number at all, as NumberFormatException does', () => {
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '2147483648' })).toEqual([
      "parameter 'lowStockThreshold' must be an integer, got '2147483648'",
    ])
    expect(validate('INVENTORY_SNAPSHOT', { lowStockThreshold: '1000001' })).toEqual([
      "parameter 'lowStockThreshold' must be between 0 and 1000000, got 1000001",
    ])
    expect(validate('USER_ACTIVITY', { userId: '-0005' })).toEqual([
      "parameter 'userId' must be a positive integer, got -5",
    ])
    expect(validate('USER_ACTIVITY', { userId: '9223372036854775808' })).toEqual([
      "parameter 'userId' must be a positive integer, got '9223372036854775808'",
    ])
  })

  it('checks dates strictly, leap years included', () => {
    expect(validate('SALES_SUMMARY', { dateFrom: '2024-02-29' })).toEqual([])
    expect(validate('SALES_SUMMARY', { dateFrom: '2026-02-29' })).toEqual([
      "parameter 'dateFrom' must be an ISO-8601 date (yyyy-MM-dd), got '2026-02-29'",
    ])
    expect(validate('SALES_SUMMARY', { dateTo: '2026-1-5' })).toEqual([
      "parameter 'dateTo' must be an ISO-8601 date (yyyy-MM-dd), got '2026-1-5'",
    ])
  })

  it('trims and blanks as Java does: a no-break space is neither trimmed nor blank', () => {
    expect(normalize('SALES_SUMMARY', { region: '\t North \n' })).toEqual({ region: 'North' })
    expect(normalize('SALES_SUMMARY', { region: '\u00a0' })).toEqual({ region: '\u00a0' })
    expect(validate('SALES_SUMMARY', { region: 'North\nEast' })).toEqual([
      "parameter 'region' must not contain control characters",
    ])
  })

  it('checks the length before trimming and the rule after', () => {
    expect(validate('SALES_SUMMARY', { region: ` ${'r'.repeat(99)} ` })).toEqual([
      "parameter 'region' must be at most 100 characters",
    ])
    expect(validate('SALES_SUMMARY', { dateFrom: ' 2026-01-01 ', dateTo: '2025-12-31' })).toEqual([
      "parameter 'dateFrom' (2026-01-01) must not be after 'dateTo' (2025-12-31)",
    ])
  })
})
