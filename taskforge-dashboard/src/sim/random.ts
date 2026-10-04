// A seeded generator (mulberry32) that stands in for every source of randomness in the services:
// ThreadLocalRandom in BackoffPolicy, UUID.randomUUID in ReportJob.create and SQS message ids, and
// the SecureRandom behind CorrelationId.generate. One seed replays a run exactly.

const TWO_POW_32 = 0x1_0000_0000
const TWO_POW_53 = 2 ** 53

export class Random {
  private state: number

  /** Uses the seed's low 32 bits. */
  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** The next 32 random bits, as an unsigned integer. */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  /** Uniform on [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / TWO_POW_32
  }

  /**
   * Uniform on [0, boundInclusive], as Java's nextLong(bound + 1) is: a draw from the incomplete
   * top slice of the range is rejected and redrawn rather than folded in with a modulo, which
   * would favour small values.
   */
  nextInt(boundInclusive: number): number {
    if (!Number.isSafeInteger(boundInclusive) || boundInclusive < 0) {
      throw new RangeError(`bound must be a non-negative safe integer, got ${boundInclusive}`)
    }
    const range = boundInclusive + 1
    if (range <= TWO_POW_32) {
      const limit = TWO_POW_32 - (TWO_POW_32 % range)
      for (;;) {
        const x = this.nextUint32()
        if (x < limit) return x % range
      }
    }
    const limit = TWO_POW_53 - (TWO_POW_53 % range)
    for (;;) {
      const x = (this.nextUint32() >>> 11) * TWO_POW_32 + this.nextUint32()
      if (x < limit) return x % range
    }
  }

  /** `count` random bytes in lower-case hexadecimal, as HexFormat.of().formatHex prints them. */
  hex(count: number): string {
    let text = ''
    let word = 0
    for (let i = 0; i < count; i++) {
      if (i % 4 === 0) word = this.nextUint32()
      const byte = (word >>> ((3 - (i % 4)) * 8)) & 0xff
      text += byte.toString(16).padStart(2, '0')
    }
    return text
  }

  /** A version 4 UUID in UUID.toString form. */
  uuid(): string {
    const h = this.hex(16)
    const variant = ((Number.parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16)
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      `4${h.slice(13, 16)}`,
      `${variant}${h.slice(17, 20)}`,
      h.slice(20, 32),
    ].join('-')
  }
}
