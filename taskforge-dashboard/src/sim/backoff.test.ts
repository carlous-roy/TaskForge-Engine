// Scenario 11, BackoffPolicy: the upper bounds of the delay window, the argument checks, and
// delays that stay inside the window and spread over it. The cases follow BackoffPolicyTest.

import { describe, expect, it } from 'vitest'
import { BackoffPolicy } from './backoff.ts'
import { Random } from './random.ts'

const policy = (seed = 1) => new BackoffPolicy(2, 60, new Random(seed))

describe('BackoffPolicy', () => {
  it('doubles the upper bound from the base and stops at the cap', () => {
    const bounds = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => policy().upperBoundSeconds(attempt))
    expect(bounds).toEqual([4, 8, 16, 32, 60, 60, 60, 60])
    expect(policy().upperBoundSeconds(40)).toBe(60)
    expect(policy().upperBoundSeconds(70)).toBe(60)
  })

  it('treats a shift that overflows a Java long as the Java does', () => {
    const big = new BackoffPolicy(1, 1e15, new Random(1))
    expect(big.upperBoundSeconds(40)).toBe(2 ** 40)
    expect(big.upperBoundSeconds(62)).toBe(1e15)
    // 5 << 61 wraps into the sign bit: overflow, so the cap.
    expect(new BackoffPolicy(5, 1e15, new Random(1)).upperBoundSeconds(61)).toBe(1e15)
    // 8 << 61 shifts every bit out and leaves 0, which the Java's check lets through.
    expect(new BackoffPolicy(8, 1e15, new Random(1)).upperBoundSeconds(61)).toBe(0)
  })

  it('rejects the configurations and attempts the Java rejects, with its messages', () => {
    expect(() => new BackoffPolicy(0, 1, new Random(1))).toThrow('base must be positive')
    expect(() => new BackoffPolicy(5, 1, new Random(1))).toThrow('cap must be at least base')
    expect(() => policy().delaySeconds(0)).toThrow('attempt must be at least 1')
    expect(() => policy().upperBoundSeconds(-3)).toThrow('attempt must be at least 1')
  })

  it('counts whole seconds, so a fractional base still counts as at least one second', () => {
    const half = new BackoffPolicy(0.5, 0.5, new Random(1))
    expect(half.base()).toBe(1)
    expect(half.cap()).toBe(1)
    expect(half.upperBoundSeconds(1)).toBe(1)
  })

  it('keeps 1,000 delays inside the window for each attempt, and they vary', () => {
    const backoff = policy(17)
    for (let attempt = 1; attempt <= 6; attempt++) {
      const upper = backoff.upperBoundSeconds(attempt)
      const seen = new Set<number>()
      for (let i = 0; i < 1000; i++) {
        const delay = backoff.delaySeconds(attempt)
        expect(Number.isInteger(delay)).toBe(true)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(upper)
        seen.add(delay)
      }
      expect(seen.size).toBe(upper + 1)
    }
  })

  it('draws uniformly over whole seconds', () => {
    const backoff = policy(23)
    const counts = [0, 0, 0, 0, 0]
    for (let i = 0; i < 5000; i++) {
      const delay = backoff.delaySeconds(1)
      counts[delay] = (counts[delay] ?? 0) + 1
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(700)
      expect(count).toBeLessThanOrEqual(1300)
    }
  })

  it('repeats its delays for the same seed', () => {
    const a = policy(7)
    const b = policy(7)
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(a.delaySeconds(attempt)).toBe(b.delaySeconds(attempt))
    }
  })
})
