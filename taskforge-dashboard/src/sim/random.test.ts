// Tests for random.ts: one seed gives one sequence, draws are uniform and unbiased, and the ids
// it makes have the services' formats.

import { describe, expect, it } from 'vitest'
import { Random } from './random.ts'

describe('Random', () => {
  it('replays the same sequence for the same seed and a different one for another', () => {
    const draw = (seed: number) => Array.from({ length: 5 }, () => new Random(seed).nextUint32())
    const a = new Random(42)
    const b = new Random(42)
    const sequenceA = Array.from({ length: 20 }, () => a.nextUint32())
    expect(Array.from({ length: 20 }, () => b.nextUint32())).toEqual(sequenceA)
    expect(new Random(43).nextUint32()).not.toBe(sequenceA[0])
    expect(draw(1)).toEqual(draw(1))
  })

  it('draws floats in [0, 1)', () => {
    const random = new Random(9)
    for (let i = 0; i < 1000; i++) {
      const x = random.nextFloat()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('draws whole numbers on [0, bound] with every value about equally often', () => {
    const random = new Random(5)
    const counts = [0, 0, 0, 0, 0]
    for (let i = 0; i < 5000; i++) {
      const x = random.nextInt(4)
      expect(Number.isInteger(x)).toBe(true)
      counts[x] = (counts[x] ?? 0) + 1
    }
    for (const count of counts) expect(count).toBeGreaterThan(850)
    for (const count of counts) expect(count).toBeLessThan(1150)
    expect(new Random(1).nextInt(0)).toBe(0)
  })

  it('covers ranges wider than 32 bits', () => {
    const random = new Random(11)
    const bound = 2 ** 40
    let max = 0
    for (let i = 0; i < 200; i++) max = Math.max(max, random.nextInt(bound))
    expect(max).toBeGreaterThan(2 ** 32)
    expect(max).toBeLessThanOrEqual(bound)
  })

  it('refuses bounds that are not whole, safe and non-negative', () => {
    const random = new Random(1)
    expect(() => random.nextInt(-1)).toThrow(RangeError)
    expect(() => random.nextInt(1.5)).toThrow(RangeError)
    expect(() => random.nextInt(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })

  it('makes version 4 UUIDs and lower-case hexadecimal', () => {
    const random = new Random(3)
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = random.uuid()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(200)
    expect(random.hex(6)).toMatch(/^[0-9a-f]{12}$/)
  })
})
