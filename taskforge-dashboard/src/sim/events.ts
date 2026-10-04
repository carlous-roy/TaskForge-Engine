// The simulation's clock and agenda, which stand in for the JVM's threads, sleeps and timers: a
// priority queue of callbacks ordered by time, then lane, then the order they were scheduled in.
// Nothing here reads the wall clock; time moves only when the simulation runs the agenda forward.

export interface Timer {
  cancel(): void
}

export interface Clock {
  /** The current simulation time in milliseconds. */
  readonly now: number
}

/** Lane 1 runs after every lane-0 event of the same millisecond: for samples of settled state. */
export type Lane = 0 | 1

export interface Scheduler extends Clock {
  /** Runs `run` at `time`, or at the current time if `time` has already passed. */
  at(time: number, run: () => void, lane?: Lane): Timer
}

interface Entry {
  readonly time: number
  readonly lane: Lane
  readonly seq: number
  readonly run: () => void
  cancelled: boolean
}

function before(a: Entry, b: Entry): boolean {
  if (a.time !== b.time) return a.time < b.time
  if (a.lane !== b.lane) return a.lane < b.lane
  return a.seq < b.seq
}

export class EventLoop implements Scheduler {
  private readonly heap: Entry[] = []
  private nextSeq = 0
  private current = 0

  get now(): number {
    return this.current
  }

  at(time: number, run: () => void, lane: Lane = 0): Timer {
    const entry: Entry = {
      time: Math.max(time, this.current),
      lane,
      seq: this.nextSeq++,
      run,
      cancelled: false,
    }
    this.push(entry)
    return {
      cancel: () => {
        entry.cancelled = true
      },
    }
  }

  /** Runs every event due at or before `target`, in order, then leaves the clock at `target`. */
  runUntil(target: number): void {
    for (;;) {
      const next = this.heap[0]
      if (next === undefined || next.time > target) break
      this.pop()
      if (next.cancelled) continue
      this.current = next.time
      next.run()
    }
    this.current = Math.max(this.current, target)
  }

  private push(entry: Entry): void {
    const heap = this.heap
    heap.push(entry)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      const above = heap[parent]
      if (above === undefined || !before(entry, above)) break
      heap[i] = above
      i = parent
    }
    heap[i] = entry
  }

  private pop(): void {
    const heap = this.heap
    const last = heap.pop()
    if (last === undefined || heap.length === 0) return
    let i = 0
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let smallest = last
      let at = i
      const l = heap[left]
      if (l !== undefined && before(l, smallest)) {
        smallest = l
        at = left
      }
      const r = heap[right]
      if (r !== undefined && before(r, smallest)) {
        smallest = r
        at = right
      }
      if (at === i) break
      heap[i] = smallest
      i = at
    }
    heap[i] = last
  }
}
