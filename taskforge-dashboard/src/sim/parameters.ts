// com.taskforge.common.report.ReportParameters and InvalidReportParametersException: the
// parameters each report type accepts, with the same rules, the same order of checks and the same
// messages. The API validates with `normalize`; the worker re-parses with `ReportParameters.of`.

import {
  formatLocalDate,
  isAfter,
  isBlank,
  isISOControl,
  parseInteger,
  parseLocalDate,
  trim,
  type LocalDate,
} from './java.ts'
import type { ReportType } from './types.ts'

export const MAX_VALUE_LENGTH = 100
export const MAX_THRESHOLD = 1_000_000

/** Raw parameters as the request carries them; a JSON null arrives as null. */
export type RawParameters = Readonly<Record<string, string | null>>

type Rule = (value: string, problems: string[]) => void

/** InvalidReportParametersException: every problem with the parameters, listed at once. */
export class InvalidReportParametersException extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid report parameters: ${problems.join('; ')}`)
    this.name = 'InvalidReportParametersException'
    this.problems = [...problems]
  }
}

function isoDate(name: string): Rule {
  return (value, problems) => {
    if (parseLocalDate(value) === null) {
      problems.push(`parameter '${name}' must be an ISO-8601 date (yyyy-MM-dd), got '${value}'`)
    }
  }
}

function text(name: string): Rule {
  return (value, problems) => {
    for (let i = 0; i < value.length; i++) {
      if (isISOControl(value.charCodeAt(i))) {
        problems.push(`parameter '${name}' must not contain control characters`)
        return
      }
    }
  }
}

function boundedInt(name: string, min: number, max: number): Rule {
  return (value, problems) => {
    const n = parseInteger(value, 32)
    if (n === null) {
      problems.push(`parameter '${name}' must be an integer, got '${value}'`)
    } else if (n < BigInt(min) || n > BigInt(max)) {
      problems.push(`parameter '${name}' must be between ${min} and ${max}, got ${n}`)
    }
  }
}

function positiveLong(name: string): Rule {
  return (value, problems) => {
    const n = parseInteger(value, 64)
    if (n === null) {
      problems.push(`parameter '${name}' must be a positive integer, got '${value}'`)
    } else if (n <= 0n) {
      problems.push(`parameter '${name}' must be a positive integer, got ${n}`)
    }
  }
}

// Insertion order is the order of the "allowed:" list in the messages, as with the LinkedHashMaps.
const RULES: Readonly<Record<ReportType, ReadonlyMap<string, Rule>>> = {
  SALES_SUMMARY: new Map([
    ['dateFrom', isoDate('dateFrom')],
    ['dateTo', isoDate('dateTo')],
    ['region', text('region')],
  ]),
  INVENTORY_SNAPSHOT: new Map([
    ['warehouse', text('warehouse')],
    ['lowStockThreshold', boundedInt('lowStockThreshold', 0, MAX_THRESHOLD)],
  ]),
  USER_ACTIVITY: new Map([
    ['dateFrom', isoDate('dateFrom')],
    ['dateTo', isoDate('dateTo')],
    ['userId', positiveLong('userId')],
  ]),
}

/** Names accepted for a type, in a stable order for error messages. */
export function allowedNames(type: ReportType): string[] {
  return [...RULES[type].keys()]
}

/** Every problem with `raw` for `type`; empty when the parameters are valid. */
export function validate(type: ReportType, raw: RawParameters | null | undefined): string[] {
  const problems: string[] = []
  if (raw === null || raw === undefined) return problems
  const rules = RULES[type]
  for (const [name, value] of Object.entries(raw)) {
    const rule = rules.get(name)
    if (rule === undefined) {
      problems.push(
        `unknown parameter '${name}' for ${type}; allowed: ${allowedNames(type).join(', ')}`
      )
      continue
    }
    if (value === null || isBlank(value)) {
      problems.push(`parameter '${name}' must not be blank`)
      continue
    }
    if (value.length > MAX_VALUE_LENGTH) {
      problems.push(`parameter '${name}' must be at most ${MAX_VALUE_LENGTH} characters`)
      continue
    }
    rule(trim(value), problems)
  }
  const dateFrom = raw['dateFrom']
  const dateTo = raw['dateTo']
  if (problems.length === 0 && typeof dateFrom === 'string' && typeof dateTo === 'string') {
    const from = parseLocalDate(trim(dateFrom))
    const to = parseLocalDate(trim(dateTo))
    if (from !== null && to !== null && isAfter(from, to)) {
      problems.push(
        `parameter 'dateFrom' (${formatLocalDate(from)}) must not be after 'dateTo' (${formatLocalDate(to)})`
      )
    }
  }
  return problems
}

/** Validates and returns a trimmed copy, or throws with every problem listed. */
export function normalize(
  type: ReportType,
  raw: RawParameters | null | undefined
): Record<string, string> {
  const problems = validate(type, raw)
  if (problems.length > 0) throw new InvalidReportParametersException(problems)
  const trimmed: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw ?? {})) {
    trimmed[name] = trim(value ?? '')
  }
  return trimmed
}

/** The typed view the generators read; `of` throws when the parameters are not valid for the type. */
export class ReportParameters {
  private readonly values: Readonly<Record<string, string>>

  private constructor(values: Record<string, string>) {
    this.values = values
  }

  static of(type: ReportType, raw: RawParameters | null | undefined): ReportParameters {
    return new ReportParameters(normalize(type, raw))
  }

  dateFrom(fallback: LocalDate): LocalDate {
    return this.date('dateFrom') ?? fallback
  }

  dateTo(fallback: LocalDate): LocalDate {
    return this.date('dateTo') ?? fallback
  }

  region(): string | null {
    return this.values['region'] ?? null
  }

  warehouse(): string | null {
    return this.values['warehouse'] ?? null
  }

  lowStockThreshold(fallback: number): number {
    const value = this.values['lowStockThreshold']
    return value === undefined ? fallback : Number(parseInteger(value, 32))
  }

  userId(): bigint | null {
    const value = this.values['userId']
    return value === undefined ? null : parseInteger(value, 64)
  }

  asMap(): Readonly<Record<string, string>> {
    return this.values
  }

  private date(name: string): LocalDate | null {
    const value = this.values[name]
    return value === undefined ? null : parseLocalDate(value)
  }
}
