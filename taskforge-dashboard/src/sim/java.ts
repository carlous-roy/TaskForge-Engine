// The parts of the Java standard library the ports lean on: String.trim and isBlank,
// Character.isISOControl and digit, Integer.parseInt and Long.parseLong, LocalDate.parse and
// toString, Duration.toString and Instant.toString. Copying their edge cases keeps validation
// messages and log lines byte for byte what the services print.

/** Simulation time 0 on the services' clock: 2026-09-18T12:00:00Z, the instant the Java tests use. */
export const SIM_EPOCH_MS = Date.UTC(2026, 8, 18, 12, 0, 0)

const DECIMAL_DIGIT = /\p{Nd}/u

/** String.trim: drops every leading and trailing char at or below U+0020, controls included. */
export function trim(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 0x20) start++
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--
  return value.slice(start, end)
}

/** Character.isWhitespace: unlike JavaScript's \s it leaves out the no-break spaces. */
function isWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    (c >= 0x1c && c <= 0x20) ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x2006) ||
    (c >= 0x2008 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x205f ||
    c === 0x3000
  )
}

/** String.isBlank. */
export function isBlank(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (!isWhitespace(value.charCodeAt(i))) return false
  }
  return true
}

/** Character.isISOControl for one UTF-16 unit. */
export function isISOControl(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f)
}

/**
 * Character.digit(c, 10): ASCII digits and every other Unicode decimal digit in the BMP. Each run
 * of decimal digits in the BMP is exactly ten long, so a digit's value is its distance from the
 * start of its run.
 */
function digit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c < 0x80 || !DECIMAL_DIGIT.test(String.fromCharCode(c))) return -1
  let zero = c
  while (c - zero < 9 && DECIMAL_DIGIT.test(String.fromCharCode(zero - 1))) zero--
  return c - zero
}

const INTEGER_BOUNDS = {
  32: [-(2n ** 31n), 2n ** 31n - 1n],
  64: [-(2n ** 63n), 2n ** 63n - 1n],
} as const

/** Integer.parseInt (32 bits) or Long.parseLong (64 bits); null where Java throws NumberFormatException. */
export function parseInteger(value: string, bits: 32 | 64): bigint | null {
  const sign = value.charAt(0)
  const start = sign === '-' || sign === '+' ? 1 : 0
  if (value.length <= start) return null
  let magnitude = 0n
  for (let i = start; i < value.length; i++) {
    const d = digit(value.charCodeAt(i))
    if (d < 0) return null
    magnitude = magnitude * 10n + BigInt(d)
  }
  const result = sign === '-' ? -magnitude : magnitude
  const [min, max] = INTEGER_BOUNDS[bits]
  return result < min || result > max ? null : result
}

/** java.time.LocalDate, as far as the parameter rules and the generators need it. */
export interface LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

// DateTimeFormatter.ISO_LOCAL_DATE, which LocalDate.parse uses with strict resolution: a year of
// four digits, or five to ten with a sign; '+' only when more than four digits follow.
const ISO_LOCAL_DATE = /^(?:([+-])(\d{4,10})|(\d{4}))-(\d{2})-(\d{2})$/
const MAX_YEAR = 999_999_999

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function lengthOfMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** LocalDate.parse; null where Java throws DateTimeParseException. */
export function parseLocalDate(value: string): LocalDate | null {
  const match = ISO_LOCAL_DATE.exec(value)
  if (match === null) return null
  const [, sign, signedDigits, plainDigits, monthText, dayText] = match
  const digits = signedDigits ?? plainDigits ?? ''
  if (sign === '+' && digits.length <= 4) return null
  const magnitude = Number(digits)
  if (sign === '-' && magnitude === 0) return null
  const year = sign === '-' ? -magnitude : magnitude
  const month = Number(monthText)
  const day = Number(dayText)
  if (magnitude > MAX_YEAR || month < 1 || month > 12) return null
  if (day < 1 || day > lengthOfMonth(year, month)) return null
  return { year, month, day }
}

/** LocalDate.toString: four-digit years padded, longer ones signed. */
export function formatLocalDate(date: LocalDate): string {
  const { year, month, day } = date
  const absYear = Math.abs(year)
  let text: string
  if (absYear < 1000) {
    text = (year < 0 ? '-' : '') + String(absYear).padStart(4, '0')
  } else {
    text = (year > 9999 ? '+' : '') + String(year)
  }
  return `${text}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** LocalDate.isAfter. */
export function isAfter(a: LocalDate, b: LocalDate): boolean {
  if (a.year !== b.year) return a.year > b.year
  if (a.month !== b.month) return a.month > b.month
  return a.day > b.day
}

/** LocalDate.now(clock) on the services' UTC clock, for a simulation time. */
export function today(t: number): LocalDate {
  const date = new Date(SIM_EPOCH_MS + t)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** LocalDate.minusDays, within the range a JavaScript Date covers (about 270,000 years). */
export function minusDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(0)
  shifted.setUTCFullYear(date.year, date.month - 1, date.day - days)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/** java.time.Duration.toString for a whole, non-negative number of milliseconds: PT1M, PT0.5S. */
export function formatDuration(ms: number): string {
  if (ms === 0) return 'PT0S'
  const totalSeconds = Math.floor(ms / 1000)
  const millis = ms % 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  let text = 'PT'
  if (hours !== 0) text += `${hours}H`
  if (minutes !== 0) text += `${minutes}M`
  if (seconds === 0 && millis === 0 && text.length > 2) return text
  text += String(seconds)
  if (millis > 0) text += '.' + String(millis).padStart(3, '0').replace(/0+$/, '')
  return text + 'S'
}

/** Instant.toString of a simulation time: ISO-8601 in UTC, with no fraction on whole seconds. */
export function formatInstant(t: number): string {
  const iso = new Date(SIM_EPOCH_MS + t).toISOString()
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso
}
