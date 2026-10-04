import { describe, expect, it } from 'vitest'
import { compactParameters, daysAgo, presetFor } from '../presets.ts'
import { isoDate } from '../format.ts'

describe('presets', () => {
  const today = Date.parse('2026-09-18T15:00:00Z')

  it('derive their date windows from the day they are asked for', () => {
    expect(isoDate(today)).toBe('2026-09-18')
    expect(daysAgo(30, today)).toBe('2026-08-19')
    expect(presetFor('SALES_SUMMARY', today)).toEqual({
      dateFrom: '2026-08-19',
      dateTo: '2026-09-18',
      region: 'North',
    })
    expect(presetFor('USER_ACTIVITY', today)).toEqual({
      dateFrom: '2026-09-11',
      dateTo: '2026-09-18',
    })
    expect(presetFor('INVENTORY_SNAPSHOT', today)).toEqual({ lowStockThreshold: '15' })
  })

  it('drops blank fields before a request is sent', () => {
    expect(compactParameters({ dateFrom: '2026-09-01', region: '  ', userId: '' })).toEqual({
      dateFrom: '2026-09-01',
    })
  })
})
