import type { AdminMutationResult, DeadLetterPage, PageOptions, QueuedContext, TaskOwnerFence, WorkQueueCapacity, WorkQueueRetryPolicy, WorkQueueSnapshot } from './Contract.js'

/**
 * The store is the queue's authoritative state machine; the service around it holds no task state
 * of its own. The line between them: policy - retry backoff, lease clamps, wait bounds - belongs
 * to the service, because policy is part of the introspectable contract; transitions belong to the
 * store, because atomicity does. That is why reap() and fail() receive the retry policy as an
 * argument rather than the store being configured with one.
 */

export interface StoredWorkTask<TStoredPayload> {
    taskId: string
    payload: TStoredPayload
    /** A defensible estimate, computed by the service before storage - the store only accounts it. */
    payloadBytes: number
    headers: Readonly<Record<string, string>>
    priority: number
    acceptedAt: number
    expiresAt?: number
    deduplicationKey?: string
    context?: QueuedContext
    ownerFence?: TaskOwnerFence
}

export type StoreEnqueueResult = { status: 'accepted'; acceptedAt: number; duplicate: boolean } | { status: 'full' }

export interface StoreAcquireRequest {
    acquireId: string
    consumerId: string
    leaseMs: number
    now: number
}

export type StoreAcquireResult<TStoredPayload> =
    | {
          status: 'lease'
          taskId: string
          leaseToken: string
          payload: TStoredPayload
          headers: Readonly<Record<string, string>>
          attempt: number
          leasedUntil: number
          context?: QueuedContext
          ownerFence?: TaskOwnerFence
      }
    | { status: 'empty' }

export type StoreLeaseMutationResult = { status: 'ok'; leasedUntil?: number } | { status: 'already-completed' } | { status: 'lease-lost' } | { status: 'not-found' }

export interface StoreFailRequest {
    taskId: string
    leaseToken: string
    failure: string
    now: number
}

export interface StoreRenewRequest {
    taskId: string
    leaseToken: string
    extensionMs: number
    now: number
}

export interface StoreReapResult {
    /** True when the sweep made at least one task ready, so waiting acquirers are worth waking. */
    freed: boolean
}

/**
 * What a conforming store must provide **atomically**: deduplicated enqueue with capacity
 * reservation; selection plus ready-to-leased transition; acquire-ID replay; lease-token
 * comparison on complete/fail/renew; attempt bookkeeping with the ready/delayed/dead-letter
 * transition; and expired-task removal with byte-count correction. A store that cannot guarantee
 * these must not describe itself as durable or shared.
 */
export interface WorkQueueStore<TStoredPayload = unknown> {
    readonly capabilities: {
        durable: boolean
        shared: boolean
    }

    enqueue(queue: string, task: StoredWorkTask<TStoredPayload>, limits: WorkQueueCapacity, now: number): Promise<StoreEnqueueResult>

    acquire(queue: string, request: StoreAcquireRequest): Promise<StoreAcquireResult<TStoredPayload>>

    complete(queue: string, taskId: string, leaseToken: string): Promise<StoreLeaseMutationResult>

    fail(queue: string, request: StoreFailRequest, retry: WorkQueueRetryPolicy): Promise<StoreLeaseMutationResult>

    renew(queue: string, request: StoreRenewRequest): Promise<StoreLeaseMutationResult>

    /** Sweep lapsed leases, elapsed delays and expired TTLs forward to where they now belong. */
    reap(queue: string, now: number, retry: WorkQueueRetryPolicy): Promise<StoreReapResult>

    /** Everything but activeConsumers, which is the service's knowledge - a store never meets a consumer. */
    snapshot(queue: string, now: number): Promise<Omit<WorkQueueSnapshot, 'activeConsumers'>>

    /** When the earliest lease, delay or TTL next lapses, so the service can hold exactly one timer. */
    nextDeadline(queue: string): Promise<number | undefined>

    listDeadLetters(queue: string, options: PageOptions): Promise<DeadLetterPage>

    retryDeadLetter(queue: string, taskId: string, now: number): Promise<AdminMutationResult>

    discardDeadLetter(queue: string, taskId: string): Promise<AdminMutationResult>
}
