import { v4 as uuidv4 } from 'uuid'
import type { AdminMutationResult, DeadLetterPage, EnqueueReceipt, PageOptions, WorkQueueCapacity, WorkQueueRetryPolicy, WorkQueueSnapshot } from './Contract.js'
import type {
    StoreAcquireRequest,
    StoreAcquireResult,
    StoredWorkTask,
    StoreEnqueueResult,
    StoreFailRequest,
    StoreLeaseMutationResult,
    StoreRenewRequest,
    StoreReapResult,
    WorkQueueStore
} from './Store.js'

/**
 * The reference store. `durable: false, shared: false`: every ready, leased, delayed,
 * deduplication and dead-letter record is lost when the process ends, and that loss is a
 * documented property, not a bug. It exists to define conformance and to serve queues whose work
 * is re-creatable; anything that must survive a restart needs a durable adapter in its own
 * package.
 *
 * Selection is an ordered scan rather than a heap: correctness is what a reference implementation
 * is for, and the scan is the version whose correctness is visible. Node is single-threaded and
 * every method completes synchronously inside its promise, which is what makes the atomicity
 * requirements hold without locks.
 */

interface HeldTask {
    stored: StoredWorkTask<unknown>
    /** Tie-break within one priority: FIFO by arrival, not by clock, so equal timestamps stay ordered. */
    sequence: number
    state: 'ready' | 'leased' | 'delayed' | 'dead'
    attempt: number
    leaseToken?: string
    leasedUntil?: number
    consumerId?: string
    /** When a delayed task may be offered again. */
    notBefore?: number
    failure?: string
    failedAt?: number
}

interface Remembered<T> {
    value: T
    until: number
}

class QueueState {
    tasks = new Map<string, HeldTask>()
    readyBytes = 0
    expired = 0
    sequence = 0
    /** Accepted receipts by taskId, kept past completion so a duplicate enqueue answers honestly. */
    receipts = new Map<string, Remembered<EnqueueReceipt>>()
    /** Deduplication keys to the taskId that claimed them. */
    dedup = new Map<string, Remembered<string>>()
    /**
     * Leases by acquireId, so an acquire retried after an uncertain outcome returns the same lease
     * instead of a second task. Only leases are remembered: replaying an *empty* answer would pin
     * a long-poll's repeated attempts under one id to emptiness forever, and handing a retrying
     * consumer a task that has become ready is correct - it asked for one and never got an answer.
     */
    acquired = new Map<string, Remembered<StoreAcquireResult<unknown>>>()
    /** Completed taskIds, so a duplicate complete/fail answers 'already-completed', not 'not-found'. */
    completed = new Map<string, Remembered<true>>()
}

/** The exponential backoff a failed task waits out, jittered so a herd does not retry as one. */
const backoffMs = (retry: WorkQueueRetryPolicy, attempt: number) => {
    const raw = retry.delayMs * Math.pow(2, Math.max(0, attempt - 1))
    const clamped = Math.min(raw, retry.maxDelayMs ?? raw)
    const jitter = Math.min(Math.max(retry.jitter ?? 0, 0), 1)
    return Math.max(0, Math.round(clamped * (1 - jitter * Math.random())))
}

/** How long completion and deduplication identities outlive their tasks. */
const DEFAULT_RETENTION_MS = 300_000
/** How long past its lease an acquire replay stays answerable - the retry margin of §23. */
const ACQUIRE_REPLAY_MARGIN_MS = 60_000

export class MemoryWorkQueueStore implements WorkQueueStore<unknown> {
    readonly capabilities = { durable: false, shared: false } as const
    private readonly queues = new Map<string, QueueState>()

    constructor(private readonly options: { retentionMs?: number } = {}) {}

    private queue(name: string) {
        let state = this.queues.get(name)
        if (!state) this.queues.set(name, (state = new QueueState()))
        return state
    }

    private get retention() {
        return this.options.retentionMs ?? DEFAULT_RETENTION_MS
    }

    /** Forget remembered identities whose windows have lapsed. Called from the mutating paths. */
    private prune(state: QueueState, now: number) {
        for (const [key, held] of state.receipts) if (held.until <= now) state.receipts.delete(key)
        for (const [key, held] of state.dedup) if (held.until <= now) state.dedup.delete(key)
        for (const [key, held] of state.acquired) if (held.until <= now) state.acquired.delete(key)
        for (const [key, held] of state.completed) if (held.until <= now) state.completed.delete(key)
    }

    async enqueue(queue: string, task: StoredWorkTask<unknown>, limits: WorkQueueCapacity, now: number): Promise<StoreEnqueueResult> {
        const state = this.queue(queue)
        this.prune(state, now)

        // Identity first, capacity second: a duplicate of an accepted task is that task, and
        // refusing it `full` would tell one caller their intent was both accepted and refused.
        const byId = state.receipts.get(task.taskId)
        if (byId) return { status: 'accepted', acceptedAt: byId.value.acceptedAt, duplicate: true }
        const byKey = task.deduplicationKey ? state.dedup.get(task.deduplicationKey) : undefined
        if (byKey) {
            const original = state.receipts.get(byKey.value)
            if (original) return { status: 'accepted', acceptedAt: original.value.acceptedAt, duplicate: true }
        }

        let ready = 0
        for (const held of state.tasks.values()) if (held.state === 'ready') ready++
        if (ready >= limits.maxReadyTasks) return { status: 'full' }
        if (state.readyBytes + task.payloadBytes > limits.maxReadyBytes) return { status: 'full' }
        if (task.payloadBytes > limits.maxPayloadBytes) return { status: 'full' }

        state.tasks.set(task.taskId, { stored: task, sequence: state.sequence++, state: 'ready', attempt: 0 })
        state.readyBytes += task.payloadBytes
        const receipt: EnqueueReceipt = { taskId: task.taskId, acceptedAt: now, duplicate: false }
        state.receipts.set(task.taskId, { value: receipt, until: now + this.retention })
        if (task.deduplicationKey) state.dedup.set(task.deduplicationKey, { value: task.taskId, until: now + this.retention })
        return { status: 'accepted', acceptedAt: now, duplicate: false }
    }

    async acquire(queue: string, request: StoreAcquireRequest): Promise<StoreAcquireResult<unknown>> {
        const state = this.queue(queue)
        const replayed = state.acquired.get(request.acquireId)
        if (replayed && replayed.until > request.now) return replayed.value

        // Highest priority first, FIFO within it. Expired ready tasks are swept as they are met,
        // so a TTL lapse never depends on the reap timer having fired first.
        let chosen: HeldTask | undefined
        for (const held of state.tasks.values()) {
            if (held.state !== 'ready') continue
            if (held.stored.expiresAt !== undefined && held.stored.expiresAt <= request.now) {
                this.expire(state, held)
                continue
            }
            if (!chosen || held.stored.priority > chosen.stored.priority || (held.stored.priority === chosen.stored.priority && held.sequence < chosen.sequence)) chosen = held
        }
        if (!chosen) return { status: 'empty' }

        chosen.state = 'leased'
        chosen.attempt++
        chosen.leaseToken = uuidv4()
        chosen.leasedUntil = request.now + request.leaseMs
        chosen.consumerId = request.consumerId
        state.readyBytes -= chosen.stored.payloadBytes
        const result: StoreAcquireResult<unknown> = {
            status: 'lease',
            taskId: chosen.stored.taskId,
            leaseToken: chosen.leaseToken,
            payload: chosen.stored.payload,
            headers: chosen.stored.headers,
            attempt: chosen.attempt,
            leasedUntil: chosen.leasedUntil,
            ...(chosen.stored.context ? { context: chosen.stored.context } : {}),
            ...(chosen.stored.ownerFence ? { ownerFence: chosen.stored.ownerFence } : {})
        }
        state.acquired.set(request.acquireId, { value: result, until: request.now + request.leaseMs + ACQUIRE_REPLAY_MARGIN_MS })
        return result
    }

    private expire(state: QueueState, held: HeldTask) {
        if (held.state === 'ready') state.readyBytes -= held.stored.payloadBytes
        state.tasks.delete(held.stored.taskId)
        state.expired++
    }

    /**
     * The token comparison every mutation shares: the fence that stops a stale worker's answer.
     * Deliberately no wall-clock check here - the token is the fence, and it stays valid until the
     * reaper acts on the expiry and replaces it. A completion that arrives late but before any
     * redelivery finished real work, and refusing it would only schedule the same work twice.
     */
    private located(state: QueueState, taskId: string, leaseToken: string): { held?: HeldTask; refusal?: StoreLeaseMutationResult } {
        const held = state.tasks.get(taskId)
        if (!held) {
            if (state.completed.has(taskId)) return { refusal: { status: 'already-completed' } }
            return { refusal: { status: 'not-found' } }
        }
        if (held.state !== 'leased' || held.leaseToken !== leaseToken) return { refusal: { status: 'lease-lost' } }
        return { held }
    }

    async complete(queue: string, taskId: string, leaseToken: string): Promise<StoreLeaseMutationResult> {
        const state = this.queue(queue)
        const now = Date.now()
        const { held, refusal } = this.located(state, taskId, leaseToken)
        if (!held) return refusal!
        state.tasks.delete(taskId)
        state.completed.set(taskId, { value: true, until: now + this.retention })
        return { status: 'ok' }
    }

    async fail(queue: string, request: StoreFailRequest, retry: WorkQueueRetryPolicy): Promise<StoreLeaseMutationResult> {
        const state = this.queue(queue)
        const { held, refusal } = this.located(state, request.taskId, request.leaseToken)
        if (!held) return refusal!
        this.settleFailure(state, held, request.failure, request.now, retry)
        return { status: 'ok' }
    }

    /** One disposition for a thrown handler and a lapsed lease: both were deliveries that failed. */
    private settleFailure(state: QueueState, held: HeldTask, failure: string, now: number, retry: WorkQueueRetryPolicy): 'ready' | 'delayed' | 'dead' | 'expired' {
        held.leaseToken = undefined
        held.leasedUntil = undefined
        held.consumerId = undefined
        held.failure = failure
        held.failedAt = now
        if (held.attempt >= retry.maxAttempts) {
            held.state = 'dead'
            return 'dead'
        }
        // TTL binds the *start* of work, and a retry is a new start: a task whose time has lapsed
        // while it waited out its backoff expires instead of returning to ready.
        if (held.stored.expiresAt !== undefined && held.stored.expiresAt <= now) {
            this.expire(state, held)
            return 'expired'
        }
        const wait = backoffMs(retry, held.attempt)
        if (wait <= 0) {
            held.state = 'ready'
            state.readyBytes += held.stored.payloadBytes
            return 'ready'
        }
        held.state = 'delayed'
        held.notBefore = now + wait
        return 'delayed'
    }

    async renew(queue: string, request: StoreRenewRequest): Promise<StoreLeaseMutationResult> {
        const state = this.queue(queue)
        const { held, refusal } = this.located(state, request.taskId, request.leaseToken)
        if (!held) return refusal!
        held.leasedUntil = request.now + request.extensionMs
        return { status: 'ok', leasedUntil: held.leasedUntil }
    }

    async reap(queue: string, now: number, retry: WorkQueueRetryPolicy): Promise<StoreReapResult> {
        const state = this.queue(queue)
        this.prune(state, now)
        let freed = false
        for (const held of [...state.tasks.values()]) {
            if (held.state === 'leased' && (held.leasedUntil ?? 0) <= now) {
                if (this.settleFailure(state, held, 'lease expired: the worker never answered', now, retry) === 'ready') freed = true
            } else if (held.state === 'delayed' && (held.notBefore ?? 0) <= now) {
                if (held.stored.expiresAt !== undefined && held.stored.expiresAt <= now) {
                    this.expire(state, held)
                } else {
                    held.state = 'ready'
                    held.notBefore = undefined
                    state.readyBytes += held.stored.payloadBytes
                    freed = true
                }
            } else if (held.state === 'ready' && held.stored.expiresAt !== undefined && held.stored.expiresAt <= now) {
                this.expire(state, held)
            }
        }
        return { freed }
    }

    async snapshot(queue: string, now: number): Promise<Omit<WorkQueueSnapshot, 'activeConsumers'>> {
        const state = this.queue(queue)
        let ready = 0
        let leased = 0
        let delayed = 0
        let dead = 0
        let oldest: number | undefined
        for (const held of state.tasks.values()) {
            if (held.state === 'ready') {
                ready++
                if (oldest === undefined || held.stored.acceptedAt < oldest) oldest = held.stored.acceptedAt
            } else if (held.state === 'leased') leased++
            else if (held.state === 'delayed') delayed++
            else dead++
        }
        return {
            ready,
            leased,
            delayed,
            deadLettered: dead,
            expired: state.expired,
            readyBytes: state.readyBytes,
            ...(oldest !== undefined ? { oldestReadyAgeMs: Math.max(0, now - oldest) } : {}),
            saturated: false
        }
    }

    async nextDeadline(queue: string): Promise<number | undefined> {
        const state = this.queue(queue)
        let next: number | undefined
        const consider = (at?: number) => {
            if (at !== undefined && (next === undefined || at < next)) next = at
        }
        for (const held of state.tasks.values()) {
            if (held.state === 'leased') consider(held.leasedUntil)
            else if (held.state === 'delayed') {
                consider(held.notBefore)
                consider(held.stored.expiresAt)
            } else if (held.state === 'ready') consider(held.stored.expiresAt)
        }
        return next
    }

    async listDeadLetters(queue: string, options: PageOptions): Promise<DeadLetterPage> {
        const state = this.queue(queue)
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
        const dead = [...state.tasks.values()]
            .filter((held) => held.state === 'dead')
            .sort((a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0) || a.sequence - b.sequence)
        const start = options.after ? dead.findIndex((held) => held.stored.taskId === options.after) + 1 : 0
        const page = dead.slice(start, start + limit)
        return {
            entries: page.map((held) => ({
                taskId: held.stored.taskId,
                headers: held.stored.headers,
                priority: held.stored.priority,
                attempts: held.attempt,
                failedAt: held.failedAt ?? 0,
                failure: held.failure ?? '',
                payloadBytes: held.stored.payloadBytes
            })),
            ...(start + limit < dead.length ? { next: page[page.length - 1]?.stored.taskId } : {})
        }
    }

    async retryDeadLetter(queue: string, taskId: string, _now: number): Promise<AdminMutationResult> {
        const state = this.queue(queue)
        const held = state.tasks.get(taskId)
        if (!held || held.state !== 'dead') return { status: 'not-found' }
        // A fresh start by decree: the attempts that killed it are history the operator has read
        // and chosen to overrule, so the counter restarts rather than dead-lettering on arrival.
        held.state = 'ready'
        held.attempt = 0
        held.failure = undefined
        held.failedAt = undefined
        state.readyBytes += held.stored.payloadBytes
        return { status: 'ok' }
    }

    async discardDeadLetter(queue: string, taskId: string): Promise<AdminMutationResult> {
        const state = this.queue(queue)
        const held = state.tasks.get(taskId)
        if (!held || held.state !== 'dead') return { status: 'not-found' }
        state.tasks.delete(taskId)
        return { status: 'ok' }
    }
}
