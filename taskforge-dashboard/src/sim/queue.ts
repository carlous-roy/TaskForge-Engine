// com.taskforge.common.service.QueueService together with the SQS behaviour it relies on: a main
// queue whose redrive policy has maxReceiveCount = taskforge.retry.max-attempts, and a dead-letter
// queue. Each receive hides a message for the visibility timeout, counts the delivery and issues a
// receipt handle that belongs to that receive only. A message already received maxReceiveCount
// times is moved to the dead-letter queue by the next receive instead of being delivered, which is
// what "ReceiveCount > maxReceiveCount" means: the move keeps its receive count, and the first
// receive from the dead-letter queue makes it maxReceiveCount + 1.

import type { Scheduler, Timer } from './events.ts'
import type { Log } from './log.ts'
import type { Random } from './random.ts'
import type { QueueMessage } from './types.ts'

/** SQS rejects visibility timeouts above 12 hours; QueueService clamps to this. */
export const MAX_VISIBILITY_SECONDS = 43_200
/** SQS returns at most ten messages per receive; QueueService clamps to this. */
export const MAX_BATCH = 10
/**
 * How long after a message becomes visible a waiting long poll returns it. It is never zero in
 * SQS, and it matters: the redelivery that follows a dead worker's visibility timeout must look
 * at the lock strictly later than the timeout, or isLockStale (a strict comparison) says no.
 */
export const LONG_POLL_PICKUP_MS = 1

/** QueueService.ReceivedMessage. */
export interface ReceivedMessage {
  readonly messageId: string
  readonly receiptHandle: string
  readonly jobId: string
  readonly correlationId: string
  readonly receiveCount: number
}

/** An error answer from SQS (an SqsException, so an SdkException, on the Java side). */
export class SqsException extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SqsException'
    this.code = code
  }
}

interface Entry {
  readonly messageId: string
  readonly jobId: string
  readonly correlationId: string
  readonly sentAt: number
  receiveCount: number
  invisibleUntil: number | null
  /** Whether a receive or a changeVisibility hid it: only an unanswered receive is worth logging. */
  hiddenBy: 'receive' | 'delay' | null
  receiptHandle: string | null
  deadLetteredAt: number | null
  /** Bumped on every visibility change, so an expiry scheduled earlier can tell it is stale. */
  visibilityToken: number
}

interface Waiter {
  readonly ready: () => void
}

export interface QueueOptions {
  readonly name: string
  /** The queue's VisibilityTimeout attribute, in whole seconds. */
  readonly visibilityTimeoutS: number
  /** The redrive policy's maxReceiveCount, or null for a queue without one. */
  readonly maxReceiveCount: number | null
  readonly deadLetterQueue: SqsQueue | null
  readonly scheduler: Scheduler
  readonly random: Random
  /** Queue events, such as the redrive, under the `sqs` source. */
  readonly log: Log
  readonly onRedrive?: () => void
}

function isVisible(entry: Entry, now: number): boolean {
  return entry.invisibleUntil === null || entry.invisibleUntil <= now
}

export class SqsQueue {
  readonly name: string
  private readonly options: QueueOptions
  private readonly entries = new Map<string, Entry>()
  private readonly waiters: Waiter[] = []
  private pickupScheduled = false
  private listing: readonly QueueMessage[] | null = null
  private changes = 0

  constructor(options: QueueOptions) {
    this.name = options.name
    this.options = options
  }

  /** Counts changes to the messages, so a snapshot can tell whether anything changed. */
  get revision(): number {
    return this.changes
  }

  /** QueueService.enqueue: the body carries the job id, the correlation id travels as an attribute. */
  send(jobId: string, correlationId: string): void {
    const now = this.options.scheduler.now
    this.add({
      messageId: this.options.random.uuid(),
      jobId,
      correlationId,
      sentAt: now,
      receiveCount: 0,
      invisibleUntil: null,
      hiddenBy: null,
      receiptHandle: null,
      deadLetteredAt: null,
      visibilityToken: 0,
    })
  }

  /** QueueService.receive: up to `maxMessages` visible messages (1 to 10), hidden as they are delivered. */
  receive(maxMessages: number, consumer: string): ReceivedMessage[] {
    const max = Math.max(1, Math.min(maxMessages, MAX_BATCH))
    const now = this.options.scheduler.now
    const { maxReceiveCount } = this.options
    const received: ReceivedMessage[] = []
    for (const entry of this.entries.values()) {
      if (received.length >= max) break
      if (!isVisible(entry, now)) continue
      if (maxReceiveCount !== null && entry.receiveCount >= maxReceiveCount) {
        this.redrive(entry, consumer)
        continue
      }
      entry.receiveCount++
      entry.receiptHandle = `${entry.messageId}:${entry.receiveCount}`
      this.hide(entry, now + this.options.visibilityTimeoutS * 1000, 'receive')
      received.push({
        messageId: entry.messageId,
        receiptHandle: entry.receiptHandle,
        jobId: entry.jobId,
        correlationId: entry.correlationId,
        receiveCount: entry.receiveCount,
      })
    }
    return received
  }

  /**
   * DeleteMessage. SQS answers a superseded receipt handle (the message has been received again
   * since) with success but keeps the message, and a handle of a message already gone is a no-op.
   */
  delete(receiptHandle: string): void {
    const entry = this.byHandle(receiptHandle)
    if (entry === undefined || entry.receiptHandle !== receiptHandle) return
    this.entries.delete(entry.messageId)
    this.changed()
  }

  /** QueueService.changeVisibility: hides the message `seconds` more (clamped); 0 shows it at once. */
  changeVisibility(receiptHandle: string, seconds: number): void {
    const clamped = Math.max(0, Math.min(Math.trunc(seconds), MAX_VISIBILITY_SECONDS))
    const now = this.options.scheduler.now
    const entry = this.byHandle(receiptHandle)
    if (entry === undefined || entry.receiptHandle !== receiptHandle) {
      throw new SqsException(
        'InvalidParameterValue',
        `Value ${receiptHandle} for parameter ReceiptHandle is invalid. Reason: Message does not exist or is not available for visibility timeout change.`
      )
    }
    if (isVisible(entry, now)) {
      throw new SqsException('MessageNotInflight', "The specified message isn't in flight.")
    }
    if (clamped === 0) {
      this.show(entry)
    } else {
      this.hide(entry, now + clamped * 1000, 'delay')
    }
  }

  /**
   * Parks a long poll: `ready` runs once a message is visible (LONG_POLL_PICKUP_MS after it
   * becomes so) and the consumer then receives. Waiters are served in the order they arrived; one
   * that is still waiting keeps its place. Cancel the timer to withdraw the poll.
   */
  waitForMessages(ready: () => void): Timer {
    const waiter: Waiter = { ready }
    this.waiters.push(waiter)
    if (this.hasVisible()) this.schedulePickup()
    return {
      cancel: () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
      },
    }
  }

  /** ApproximateNumberOfMessages: visible messages. */
  visibleCount(): number {
    let count = 0
    const now = this.options.scheduler.now
    for (const entry of this.entries.values()) if (isVisible(entry, now)) count++
    return count
  }

  /** ApproximateNumberOfMessagesNotVisible: messages in flight (received, or delayed for a retry). */
  inFlightCount(): number {
    return this.entries.size - this.visibleCount()
  }

  size(): number {
    return this.entries.size
  }

  /** Every message, oldest first, frozen and shared until the next change. */
  messages(): readonly QueueMessage[] {
    if (this.listing === null) {
      const views: QueueMessage[] = []
      for (const entry of this.entries.values()) {
        views.push(
          Object.freeze({
            messageId: entry.messageId,
            jobId: entry.jobId,
            correlationId: entry.correlationId,
            receiveCount: entry.receiveCount,
            invisibleUntil: entry.invisibleUntil,
            sentAt: entry.sentAt,
            deadLetteredAt: entry.deadLetteredAt,
          })
        )
      }
      this.listing = Object.freeze(views)
    }
    return this.listing
  }

  /** The redrive's other end: the message arrives with its receive count and attributes. */
  private accept(moved: Entry): void {
    this.add({
      ...moved,
      invisibleUntil: null,
      hiddenBy: null,
      receiptHandle: null,
      deadLetteredAt: this.options.scheduler.now,
      visibilityToken: 0,
    })
  }

  private add(entry: Entry): void {
    this.entries.set(entry.messageId, entry)
    this.changed()
    this.becameVisible()
  }

  private redrive(entry: Entry, consumer: string): void {
    const dlq = this.options.deadLetterQueue
    if (dlq === null) return
    this.entries.delete(entry.messageId)
    this.changed()
    this.options.log(
      'WARN',
      entry.correlationId,
      `Moved message ${entry.messageId} for job ${entry.jobId} to ${dlq.name} on a receive by ${consumer}: it had been received ${entry.receiveCount} times and maxReceiveCount is ${this.options.maxReceiveCount}`
    )
    dlq.accept(entry)
    this.options.onRedrive?.()
  }

  private hide(entry: Entry, until: number, by: 'receive' | 'delay'): void {
    entry.invisibleUntil = until
    entry.hiddenBy = by
    const token = ++entry.visibilityToken
    this.changed()
    this.options.scheduler.at(until, () => this.expire(entry, token))
  }

  private show(entry: Entry): void {
    entry.invisibleUntil = null
    entry.hiddenBy = null
    entry.visibilityToken++
    this.changed()
    this.becameVisible()
  }

  private expire(entry: Entry, token: number): void {
    if (this.entries.get(entry.messageId) !== entry || entry.visibilityToken !== token) return
    if (entry.hiddenBy === 'receive') {
      this.options.log(
        'INFO',
        entry.correlationId,
        `Visibility timeout of ${this.options.visibilityTimeoutS} s expired for message ${entry.messageId} (job ${entry.jobId}) after receive ${entry.receiveCount}; it is visible again`
      )
    }
    this.show(entry)
  }

  private byHandle(receiptHandle: string): Entry | undefined {
    return this.entries.get(receiptHandle.slice(0, receiptHandle.lastIndexOf(':')))
  }

  private hasVisible(): boolean {
    const now = this.options.scheduler.now
    for (const entry of this.entries.values()) if (isVisible(entry, now)) return true
    return false
  }

  private becameVisible(): void {
    if (this.waiters.length > 0) this.schedulePickup()
  }

  private schedulePickup(): void {
    if (this.pickupScheduled) return
    this.pickupScheduled = true
    const scheduler = this.options.scheduler
    scheduler.at(scheduler.now + LONG_POLL_PICKUP_MS, () => this.serveWaiters())
  }

  private serveWaiters(): void {
    this.pickupScheduled = false
    while (this.waiters.length > 0 && this.hasVisible()) {
      this.waiters.shift()?.ready()
    }
  }

  private changed(): void {
    this.changes++
    this.listing = null
  }
}
