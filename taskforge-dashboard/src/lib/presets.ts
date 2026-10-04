// Default parameters per report type. The worker seeds sample transactions over the 90 days before
// it starts and user activity over the 30 before, so the presets are relative to "today" rather
// than fixed dates that would drift out of the seeded range. "Today" is the real date in the
// service edition and the simulated clock's date in the browser edition.

import type { ReportStatus, ReportType } from '../sim/types.ts'
import { isoDate } from './format.ts'

const DAY_MS = 86_400_000

export function daysAgo(days: number, todayMs: number): string {
  return isoDate(todayMs - days * DAY_MS)
}

export function presetFor(type: ReportType, todayMs: number): Record<string, string> {
  switch (type) {
    case 'SALES_SUMMARY':
      return { dateFrom: daysAgo(30, todayMs), dateTo: isoDate(todayMs), region: 'North' }
    case 'INVENTORY_SNAPSHOT':
      return { lowStockThreshold: '15' }
    case 'USER_ACTIVITY':
      return { dateFrom: daysAgo(7, todayMs), dateTo: isoDate(todayMs) }
  }
}

/** The parameters each type accepts, with a placeholder for the form. */
export const PARAMETER_HINTS: Record<ReportType, Array<{ name: string; hint: string }>> = {
  SALES_SUMMARY: [
    { name: 'dateFrom', hint: 'yyyy-MM-dd' },
    { name: 'dateTo', hint: 'yyyy-MM-dd' },
    { name: 'region', hint: 'North, South, East or West' },
  ],
  INVENTORY_SNAPSHOT: [
    { name: 'warehouse', hint: 'WH-NORTH, WH-SOUTH, WH-EAST or WH-WEST' },
    { name: 'lowStockThreshold', hint: '0 to 1,000,000' },
  ],
  USER_ACTIVITY: [
    { name: 'dateFrom', hint: 'yyyy-MM-dd' },
    { name: 'dateTo', hint: 'yyyy-MM-dd' },
    { name: 'userId', hint: 'a positive integer' },
  ],
}

export const STATUS_FILTERS: Array<ReportStatus | 'ALL'> = [
  'ALL',
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'COMPLETED',
  'FAILED',
]

/** Drops blank fields so an untouched optional input is not sent as an empty parameter. */
export function compactParameters(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value.trim() !== '') out[name] = value
  }
  return out
}
