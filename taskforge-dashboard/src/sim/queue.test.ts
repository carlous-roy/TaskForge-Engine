// Scenario 12, the queue: visibility, receipt handles, changeVisibility, the redrive when a
// receive would take the receive count past maxReceiveCount, batch limits and long polling. The
// first cases follow QueueServiceIT.

import { describe, expect, it } from 'vitest'
import { EventLoop } from './events.ts'
import type { Log } from './log.ts'
import { MAX_VISIBILITY_SECONDS, SqsException, SqsQueue } from './queue.ts'
import { Random } from './random.ts'

function setup(maxReceiveCount = 3) {
  const loop = new EventLoop()
  const random = new Random(3)
  const lines: string[] = []
  const log: Log = (level, cid, message) => {
    lines.push(`${level} [${cid}] ${message}`)
  }
  const dlq = new SqsQueue({
    name: 'taskforge-reports-dlq',
    visibilityTimeoutS: 30,
    maxReceiveCount: null,
    deadLetterQueue: null,
    scheduler: loop,
    random,
    log,
  })
  const redrives: number[] = []
  const queue = new SqsQueue({
    name: 'taskforge-reports',
    visibilityTimeoutS: 120,
    maxReceiveCount,
    deadLetterQueue: dlq,
    scheduler: loop,
    random,
    log,
    onRedrive: () => redrives.push(loop.now),
  })
  return { loop, queue, dlq, lines, redrives }
}

describe('SqsQueue', () => {
  it('carries the job id, the correlation id and the receive count', () => {
    const { queue } = setup()
    queue.send('job-1', 'cid-42')
    const [message] = queue.receive(10, 'worker-1')
    expect(message).toMatchObject({ jobId: 'job-1', correlationId: 'cid-42', receiveCount: 1 })
    expect(message?.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('hides a received message for the visibility timeout, then delivers it again', () => {
    const { loop, queue, lines } = setup()
    queue.send('job-1', 'cid')
    const first = queue.receive(10, 'worker-1')[0]
    expect(queue.messages()[0]?.invisibleUntil).toBe(120_000)
    expect(queue.visibleCount()).toBe(0)
    expect(queue.inFlightCount()).toBe(1)
    loop.runUntil(119_999)
    expect(queue.receive(10, 'worker-2')).toEqual([])
    loop.runUntil(120_000)
    expect(queue.messages()[0]?.invisibleUntil).toBeNull()
    expect(lines.at(-1)).toBe(
      `INFO [cid] Visibility timeout of 120 s expired for message ${first?.messageId} (job job-1) after receive 1; it is visible again`
    )
    const second = queue.receive(10, 'worker-2')[0]
    expect(second?.messageId).toBe(first?.messageId)
    expect(second?.receiveCount).toBe(2)
    expect(second?.receiptHandle).not.toBe(first?.receiptHandle)
  })

  it('deletes only with the latest receipt handle; an older one succeeds but keeps the message', () => {
    const { loop, queue } = setup()
    queue.send('job-1', 'cid')
    const first = queue.receive(1, 'worker-1')[0]
    loop.runUntil(120_000)
    const second = queue.receive(1, 'worker-2')[0]
    queue.delete(first?.receiptHandle ?? '')
    expect(queue.size()).toBe(1)
    queue.delete(second?.receiptHandle ?? '')
    expect(queue.size()).toBe(0)
    expect(() => queue.delete(second?.receiptHandle ?? '')).not.toThrow()
  })

  it('redelivers after changeVisibility and counts the delivery', () => {
    const { loop, queue } = setup()
    queue.send('job-1', 'cid')
    const first = queue.receive(10, 'worker-1')[0]
    queue.changeVisibility(first?.receiptHandle ?? '', 1)
    expect(queue.messages()[0]?.invisibleUntil).toBe(1_000)
    loop.runUntil(999)
    expect(queue.receive(10, 'worker-1')).toEqual([])
    loop.runUntil(1_000)
    const second = queue.receive(10, 'worker-1')[0]
    expect(second).toMatchObject({ messageId: first?.messageId, receiveCount: 2 })
  })

  it('shows a message at once for 0 and clamps to the SQS maximum', () => {
    const { queue } = setup()
    queue.send('job-1', 'cid')
    const handle = queue.receive(1, 'worker-1')[0]?.receiptHandle ?? ''
    queue.changeVisibility(handle, 99_999)
    expect(queue.messages()[0]?.invisibleUntil).toBe(MAX_VISIBILITY_SECONDS * 1000)
    queue.changeVisibility(handle, -5)
    expect(queue.messages()[0]?.invisibleUntil).toBeNull()
    expect(queue.visibleCount()).toBe(1)
  })

  it('refuses changeVisibility with a superseded handle or for a message no longer in flight', () => {
    const { loop, queue } = setup()
    queue.send('job-1', 'cid')
    const first = queue.receive(1, 'worker-1')[0]?.receiptHandle ?? ''
    loop.runUntil(120_000)
    expect(() => queue.changeVisibility(first, 0)).toThrow("The specified message isn't in flight.")
    queue.receive(1, 'worker-2')
    try {
      queue.changeVisibility(first, 0)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SqsException)
      expect((error as SqsException).code).toBe('InvalidParameterValue')
    }
  })

  it('moves a message to the dead-letter queue on the receive after its maxReceiveCount-th', () => {
    const { loop, queue, dlq, lines, redrives } = setup(3)
    queue.send('job-1', 'cid-dlq')
    for (let delivery = 1; delivery <= 3; delivery++) {
      const message = queue.receive(10, 'worker-1')[0]
      expect(message?.receiveCount).toBe(delivery)
      queue.changeVisibility(message?.receiptHandle ?? '', 0)
    }
    loop.runUntil(5)
    expect(queue.receive(10, 'worker-2')).toEqual([])
    expect(queue.size()).toBe(0)
    expect(redrives).toEqual([5])
    expect(dlq.messages()).toEqual([
      expect.objectContaining({
        jobId: 'job-1',
        correlationId: 'cid-dlq',
        receiveCount: 3,
        deadLetteredAt: 5,
      }),
    ])
    expect(lines.at(-1)).toMatch(
      /^WARN \[cid-dlq\] Moved message [0-9a-f-]{36} for job job-1 to taskforge-reports-dlq on a receive by worker-2: it had been received 3 times and maxReceiveCount is 3$/
    )
    const dead = dlq.receive(10, 'dlq')[0]
    expect(dead).toMatchObject({ jobId: 'job-1', correlationId: 'cid-dlq', receiveCount: 4 })
  })

  it('redrives only when a receive reaches the message', () => {
    const { queue, dlq } = setup(1)
    queue.send('job-1', 'cid')
    const handle = queue.receive(1, 'worker-1')[0]?.receiptHandle ?? ''
    queue.changeVisibility(handle, 0)
    expect(queue.size()).toBe(1)
    expect(dlq.size()).toBe(0)
    queue.receive(1, 'worker-1')
    expect(dlq.size()).toBe(1)
  })

  it('returns at most ten messages and at least one per receive', () => {
    const { queue } = setup()
    for (let i = 0; i < 15; i++) queue.send(`job-${i}`, 'cid')
    expect(queue.receive(20, 'worker-1')).toHaveLength(10)
    expect(queue.receive(0, 'worker-1')).toHaveLength(1)
    expect(queue.receive(3, 'worker-1')).toHaveLength(3)
    expect(queue.receive(5, 'worker-1').map((m) => m.jobId)).toEqual(['job-14'])
  })

  it('serves long polls one millisecond after a message appears, in the order they arrived', () => {
    const { loop, queue } = setup()
    const served: string[] = []
    const poll = (name: string) =>
      queue.waitForMessages(() => {
        served.push(`${name}@${loop.now}:${queue.receive(1, name).length}`)
      })
    poll('worker-1')
    poll('worker-2')
    const withdrawn = poll('worker-3')
    withdrawn.cancel()
    loop.runUntil(10)
    queue.send('job-1', 'cid')
    loop.runUntil(10)
    expect(served).toEqual([])
    loop.runUntil(11)
    expect(served).toEqual(['worker-1@11:1'])
    queue.send('job-2', 'cid')
    loop.runUntil(20)
    expect(served).toEqual(['worker-1@11:1', 'worker-2@12:1'])
  })
})
