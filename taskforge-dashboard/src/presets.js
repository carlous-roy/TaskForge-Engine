/**
 * Default parameters per report type. The worker seeds sample transactions over the last 90 days
 * and user activity over the last 30, all relative to the day it starts, so the presets are derived
 * from today rather than fixed dates that would drift out of the seeded range.
 */
export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days, today = new Date()) {
  const d = new Date(today.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

export function presetFor(type, today = new Date()) {
  switch (type) {
    case 'SALES_SUMMARY':
      return { dateFrom: daysAgo(30, today), dateTo: isoDate(today), region: 'North' };
    case 'INVENTORY_SNAPSHOT':
      return { lowStockThreshold: '15' };
    case 'USER_ACTIVITY':
      return { dateFrom: daysAgo(7, today), dateTo: isoDate(today) };
    default:
      return {};
  }
}

export const REPORT_TYPES = ['SALES_SUMMARY', 'INVENTORY_SNAPSHOT', 'USER_ACTIVITY'];
export const STATUSES = ['ALL', 'QUEUED', 'PROCESSING', 'RETRY_SCHEDULED', 'COMPLETED', 'FAILED'];
