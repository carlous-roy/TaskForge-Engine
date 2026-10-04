// The log lines of the three report generators (SalesSummaryGenerator, InventorySnapshotGenerator
// and UserActivityGenerator), with the defaults each fills in when a parameter is absent. The
// simulation holds no sample data, so the size of the CSV is drawn rather than computed.

import { formatLocalDate, minusDays, today } from './java.ts'
import type { ReportParameters } from './parameters.ts'
import type { Random } from './random.ts'
import type { ReportType } from './types.ts'

/** InventorySnapshotGenerator.DEFAULT_LOW_STOCK_THRESHOLD. */
const DEFAULT_LOW_STOCK_THRESHOLD = 10
/** Roughly what the seeded dataset yields: 20 to 80 rows of about 50 bytes and a summary. */
const CSV_BYTES: readonly [number, number] = [900, 4_800]

/** The line each generator logs as it starts, on the worker's clock (LocalDate.now(clock)). */
export function generatingLine(
  type: ReportType,
  parameters: ReportParameters,
  now: number
): string {
  const day = today(now)
  switch (type) {
    case 'SALES_SUMMARY': {
      const from = formatLocalDate(parameters.dateFrom(minusDays(day, 30)))
      const to = formatLocalDate(parameters.dateTo(day))
      return `Generating SALES_SUMMARY ${from}..${to} region=${parameters.region() ?? 'all'}`
    }
    case 'INVENTORY_SNAPSHOT': {
      const warehouse = parameters.warehouse() ?? 'all'
      const threshold = parameters.lowStockThreshold(DEFAULT_LOW_STOCK_THRESHOLD)
      return `Generating INVENTORY_SNAPSHOT warehouse=${warehouse} lowStockThreshold=${threshold}`
    }
    case 'USER_ACTIVITY': {
      const from = formatLocalDate(parameters.dateFrom(minusDays(day, 7)))
      const to = formatLocalDate(parameters.dateTo(day))
      const userId = parameters.userId()
      return `Generating USER_ACTIVITY ${from}..${to} userId=${userId === null ? 'all' : String(userId)}`
    }
  }
}

/** The line each generator logs when the CSV is built. */
export function completeLine(type: ReportType, bytes: number): string {
  return `${type} complete: ${bytes} bytes`
}

export function drawCsvBytes(random: Random): number {
  const [min, max] = CSV_BYTES
  return min + random.nextInt(max - min)
}
