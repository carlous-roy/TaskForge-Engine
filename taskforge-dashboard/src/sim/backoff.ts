// com.taskforge.common.retry.BackoffPolicy, ported line for line: "full jitter" exponential
// backoff, delay = random(0, min(cap, base * 2^attempt)) in whole seconds, because SQS visibility
// timeouts are whole seconds.

import type { Random } from './random.ts'

const LONG_MAX = 2n ** 63n - 1n

export class BackoffPolicy {
  private readonly baseSeconds: number
  private readonly capSeconds: number
  private readonly random: Random

  /**
   * Takes the configured durations in seconds. Fractions are dropped afterwards, as
   * Duration.toSeconds() drops them, so a base of 0.5 s still counts as positive and becomes 1 s.
   */
  constructor(baseSeconds: number, capSeconds: number, random: Random) {
    if (!(baseSeconds > 0)) throw new RangeError('base must be positive')
    if (capSeconds < baseSeconds) throw new RangeError('cap must be at least base')
    this.baseSeconds = Math.max(1, Math.trunc(baseSeconds))
    this.capSeconds = Math.max(1, Math.trunc(capSeconds))
    this.random = random
  }

  /**
   * Upper bound of the delay window after `attempt` failures (1 for the first failure):
   * min(cap, base * 2^attempt) seconds.
   */
  upperBoundSeconds(attempt: number): number {
    if (attempt < 1) throw new RangeError('attempt must be at least 1')
    // `baseSeconds << attempt` on a Java long: a shift of 62 or more counts as overflow, and so
    // does one that wraps into the sign bit. BigInt.asIntN wraps the way the long does.
    let exponential =
      attempt >= 62 ? LONG_MAX : BigInt.asIntN(64, BigInt(this.baseSeconds) << BigInt(attempt))
    if (exponential < 0n) exponential = LONG_MAX
    const cap = BigInt(this.capSeconds)
    return Number(exponential < cap ? exponential : cap)
  }

  /** A delay drawn uniformly from [0, upperBoundSeconds(attempt)], in whole seconds. */
  delaySeconds(attempt: number): number {
    return this.random.nextInt(this.upperBoundSeconds(attempt))
  }

  /** BackoffPolicy.base(), in seconds. */
  base(): number {
    return this.baseSeconds
  }

  /** BackoffPolicy.cap(), in seconds. */
  cap(): number {
    return this.capSeconds
  }
}
