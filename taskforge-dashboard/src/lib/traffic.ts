// Background submissions for the browser edition, so the board has work on it before the visitor
// touches anything. Arrivals are drawn from the simulator's own generator seeded with the run's
// seed, so a run replays exactly, traffic included. The rate averages 24 requests a minute, under
// half of the API's 60, which leaves the visitor's own submissions room inside the window.

import { Random } from '../sim/random.ts'
import type { ReportType, SubmitRequest } from '../sim/types.ts'
import { presetFor } from './presets.ts'

const MIN_GAP_MS = 1_200
const MAX_GAP_MS = 3_800

const REGIONS = ['North', 'South', 'East', 'West']
const WAREHOUSES = ['WH-NORTH', 'WH-SOUTH', 'WH-EAST', 'WH-WEST']

export class Traffic {
  private readonly random: Random
  /** Simulation time of the next arrival. */
  nextAt: number

  constructor(seed: number, startAt = 0) {
    this.random = new Random(seed ^ 0x5bd1e995)
    this.nextAt = startAt + this.gap()
  }

  private gap(): number {
    return MIN_GAP_MS + Math.floor(this.random.nextFloat() * (MAX_GAP_MS - MIN_GAP_MS))
  }

  private pick<T>(items: readonly T[]): T {
    return items[this.random.nextInt(items.length - 1)] as T
  }

  /** After traffic was off for a while, the next arrival is a fresh gap from `now`, not a backlog. */
  resumeAt(now: number): void {
    if (this.nextAt < now) this.nextAt = now + this.gap()
  }

  /** The request due at `nextAt`, and schedules the one after it. `todayMs` dates the presets. */
  next(todayMs: number): SubmitRequest {
    const roll = this.random.nextFloat()
    const type: ReportType =
      roll < 0.45 ? 'SALES_SUMMARY' : roll < 0.75 ? 'INVENTORY_SNAPSHOT' : 'USER_ACTIVITY'
    const parameters = presetFor(type, todayMs)
    if (type === 'SALES_SUMMARY') parameters.region = this.pick(REGIONS)
    if (type === 'INVENTORY_SNAPSHOT' && this.random.nextFloat() < 0.5) {
      parameters.warehouse = this.pick(WAREHOUSES)
    }
    if (type === 'USER_ACTIVITY' && this.random.nextFloat() < 0.3) {
      parameters.userId = String(1 + this.random.nextInt(24))
    }
    this.nextAt += this.gap()
    return { type, parameters }
  }
}
