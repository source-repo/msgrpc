import { RpcComponent, rpc, type ExposeOptions } from '@source-repo/rpc'
import type {
    AcquireRequest,
    AcquireResult,
    AdminMutationResult,
    CompleteRequest,
    DeadLetterPage,
    EnqueueRequest,
    EnqueueResult,
    FailRequest,
    LeaseMutationResult,
    PageOptions,
    RenewRequest,
    WorkQueueCapacity,
    WorkQueueProtocol,
    WorkQueueRetryPolicy,
    WorkQueueSnapshot
} from './Contract.js'
import { MemoryWorkQueueStore } from './MemoryStore.js'
import type { WorkQueueStore } from './Store.js'

/**
 * The queue service: a thin, policy-holding shell around an authoritative store, exposed as an
 * ordinary Source RPC namespace and observable as a component.
 *
 * Everything a caller can reach is a marked method - queue internals must never leak through
 * prototype traversal - and the namespace runs `parallel`, because a long-polling acquire that
 * serialised enqueue and completion behind it would deadlock the queue against its own consumers.
 * Atomicity lives in the store, not in call ordering.
 */

export interface WorkQueueOptions {
    store?: WorkQueueStore<unknown>
    capacity?: Partial<WorkQueueCapacity>
    lease?: { defaultMs?: number; maximumMs?: number }
    retry?: Partial<WorkQueueRetryPolicy>
    /** The server-side bound on one long poll. A client asking for more is clamped, not refused. */
    waitMaximumMs?: number
    /** Failure summaries beyond this are truncated - the queue stores verdicts, not stack archives. */
    failureMaxChars?: number
}

export interface WorkQueueProps {
    name: string
    capacity: WorkQueueCapacity
    lease: { defaultMs: number; maximumMs: number }
    retry: WorkQueueRetryPolicy
    store: { durable: boolean; shared: boolean }
    [key: string]: unknown
}

export interface WorkQueueState {
    ready: number
    leased: number
    delayed: number
    deadLettered: number
    expired: number
    readyBytes: number
    oldestReadyAgeMs?: number
    saturated: boolean
    activeConsumers: number
    [key: string]: unknown
}

const DEFAULT_CAPACITY: WorkQueueCapacity = {
    maxReadyTasks: 10_000,
    maxReadyBytes: 64 * 1024 * 1024,
    maxPayloadBytes: 1024 * 1024,
    maxHeaders: 16,
    maxHeaderBytes: 8192
}

const DEFAULT_RETRY: WorkQueueRetryPolicy = { maxAttempts: 5, delayMs: 1000, maxDelayMs: 30_000, jitter: 0.2 }

/** A consumer is active while it has spoken within this window. Presence, not a registration. */
const CONSUMER_SEEN_MS = 60_000

/**
 * A conservative byte estimate: exact for the opaque binary payload the queue never decodes,
 * JSON-shaped for everything else. A tripwire for capacity accounting, not a codec.
 */
const estimateBytes = (payload: unknown): number => {
    if (payload instanceof Uint8Array) return payload.byteLength
    const text = JSON.stringify(payload)
    return text === undefined ? 16 : text.length
}

export class WorkQueueService<TTask> extends RpcComponent<WorkQueueProps, WorkQueueState> implements WorkQueueProtocol<TTask> {
    private readonly store: WorkQueueStore<unknown>
    private readonly capacity: WorkQueueCapacity
    private readonly lease: { defaultMs: number; maximumMs: number }
    private readonly retry: WorkQueueRetryPolicy
    private readonly waitMaximumMs: number
    private readonly failureMaxChars: number
    /** Long-poll parking: resolved early by whatever makes a task ready. */
    private readonly waiters = new Set<() => void>()
    private readonly consumers = new Map<string, number>()
    private reapTimer?: NodeJS.Timeout

    constructor(
        public readonly queueName: string,
        options: WorkQueueOptions = {}
    ) {
        const store = options.store ?? new MemoryWorkQueueStore()
        const capacity = { ...DEFAULT_CAPACITY, ...options.capacity }
        const lease = { defaultMs: options.lease?.defaultMs ?? 30_000, maximumMs: options.lease?.maximumMs ?? 5 * 60_000 }
        const retry = { ...DEFAULT_RETRY, ...options.retry }
        super(
            { name: queueName, capacity, lease, retry, store: { ...store.capabilities } },
            { ready: 0, leased: 0, delayed: 0, deadLettered: 0, expired: 0, readyBytes: 0, saturated: false, activeConsumers: 0 }
        )
        this.store = store
        this.capacity = capacity
        this.lease = lease
        this.retry = retry
        this.waitMaximumMs = options.waitMaximumMs ?? 30_000
        this.failureMaxChars = options.failureMaxChars ?? 2000
    }

    @rpc({ semantics: 'idempotent-command' })
    async enqueue(request: EnqueueRequest<TTask>): Promise<EnqueueResult> {
        if (!request || typeof request.taskId !== 'string' || !request.taskId) throw new Error('enqueue: a task carries a non-empty string taskId')
        const headers = request.headers ?? {}
        const names = Object.keys(headers)
        const maxHeaders = this.capacity.maxHeaders ?? DEFAULT_CAPACITY.maxHeaders!
        const maxHeaderBytes = this.capacity.maxHeaderBytes ?? DEFAULT_CAPACITY.maxHeaderBytes!
        // A caller bug, not a capacity condition: `full` invites retrying later, and these will
        // never fit later either.
        if (names.length > maxHeaders) throw new Error(`enqueue: ${names.length} headers exceed the ${maxHeaders} allowed`)
        const headerBytes = names.reduce((total, name) => total + name.length + String(headers[name]).length, 0)
        if (headerBytes > maxHeaderBytes) throw new Error(`enqueue: ${headerBytes} header bytes exceed the ${maxHeaderBytes} allowed`)

        const now = Date.now()
        const accepted = await this.store.enqueue(
            this.queueName,
            {
                taskId: request.taskId,
                payload: request.payload,
                payloadBytes: estimateBytes(request.payload),
                headers,
                priority: request.priority ?? 0,
                acceptedAt: now,
                ...(request.ttlMs !== undefined ? { expiresAt: now + request.ttlMs } : {}),
                ...(request.deduplicationKey ? { deduplicationKey: request.deduplicationKey } : {}),
                ...(request.context ? { context: request.context } : {}),
                ...(request.ownerFence ? { ownerFence: request.ownerFence } : {})
            },
            this.capacity,
            now
        )
        if (accepted.status === 'full') {
            void this.publishMetrics()
            return { status: 'full' }
        }
        if (!accepted.duplicate) {
            this.wake()
            this.scheduleReap()
            void this.publishMetrics()
        }
        return { status: 'accepted', receipt: { taskId: request.taskId, acceptedAt: accepted.acceptedAt, duplicate: accepted.duplicate } }
    }

    @rpc({ semantics: 'idempotent-command' })
    async acquire(request: AcquireRequest): Promise<AcquireResult<TTask>> {
        if (!request || typeof request.acquireId !== 'string' || !request.acquireId) throw new Error('acquire: an acquire carries a non-empty string acquireId')
        this.touch(request.consumerId)
        const leaseMs = Math.min(Math.max(request.leaseMs || this.lease.defaultMs, 1000), this.lease.maximumMs)
        const waitMs = Math.min(Math.max(request.waitMs ?? 0, 0), this.waitMaximumMs)
        const deadline = Date.now() + waitMs
        for (;;) {
            const now = Date.now()
            await this.store.reap(this.queueName, now, this.retry)
            const result = await this.store.acquire(this.queueName, { acquireId: request.acquireId, consumerId: request.consumerId, leaseMs, now })
            if (result.status === 'lease') {
                this.scheduleReap()
                void this.publishMetrics()
                return {
                    status: 'lease',
                    lease: {
                        taskId: result.taskId,
                        leaseToken: result.leaseToken,
                        payload: result.payload as TTask,
                        headers: result.headers,
                        attempt: result.attempt,
                        leasedUntil: result.leasedUntil,
                        ...(result.context ? { context: result.context } : {}),
                        ...(result.ownerFence ? { ownerFence: result.ownerFence } : {})
                    }
                }
            }
            const remaining = deadline - Date.now()
            // An explicit empty at the bound, so no promise is held indefinitely and the consumer
            // knows this acquireId is spent - the next wait starts a fresh identity.
            if (remaining <= 0) return { status: 'empty' }
            await this.parked(Math.min(remaining, 1000))
        }
    }

    @rpc({ semantics: 'idempotent-command' })
    async complete(request: CompleteRequest): Promise<LeaseMutationResult> {
        this.touch(request.consumerId)
        const result = await this.store.complete(this.queueName, request.taskId, request.leaseToken)
        this.scheduleReap()
        void this.publishMetrics()
        return result
    }

    @rpc({ semantics: 'idempotent-command' })
    async fail(request: FailRequest): Promise<LeaseMutationResult> {
        this.touch(request.consumerId)
        const failure = String(request.failure ?? '').slice(0, this.failureMaxChars)
        const result = await this.store.fail(this.queueName, { taskId: request.taskId, leaseToken: request.leaseToken, failure, now: Date.now() }, this.retry)
        if (result.status === 'ok') this.wake()
        this.scheduleReap()
        void this.publishMetrics()
        return result
    }

    @rpc({ semantics: 'idempotent-command' })
    async renew(request: RenewRequest): Promise<LeaseMutationResult> {
        this.touch(request.consumerId)
        const extension = Math.min(Math.max(request.extensionMs ?? this.lease.defaultMs, 1000), this.lease.maximumMs)
        const result = await this.store.renew(this.queueName, { taskId: request.taskId, leaseToken: request.leaseToken, extensionMs: extension, now: Date.now() })
        this.scheduleReap()
        return result
    }

    @rpc({ semantics: 'query' })
    async stats(): Promise<WorkQueueSnapshot> {
        const now = Date.now()
        await this.store.reap(this.queueName, now, this.retry)
        return this.snapshotNow(now)
    }

    @rpc({ semantics: 'query' })
    async listDeadLetters(options?: PageOptions): Promise<DeadLetterPage> {
        return this.store.listDeadLetters(this.queueName, options ?? {})
    }

    @rpc({ semantics: 'idempotent-command' })
    async retryDeadLetter(taskId: string): Promise<AdminMutationResult> {
        const result = await this.store.retryDeadLetter(this.queueName, taskId, Date.now())
        if (result.status === 'ok') {
            this.wake()
            void this.publishMetrics()
        }
        return result
    }

    @rpc({ semantics: 'idempotent-command' })
    async discardDeadLetter(taskId: string): Promise<AdminMutationResult> {
        const result = await this.store.discardDeadLetter(this.queueName, taskId)
        if (result.status === 'ok') void this.publishMetrics()
        return result
    }

    /** Stop the reap timer and unpark every waiter, so a closing server does not idle on the queue. */
    close() {
        if (this.reapTimer) clearTimeout(this.reapTimer)
        this.reapTimer = undefined
        this.wake()
    }

    private touch(consumerId: string | undefined) {
        if (typeof consumerId === 'string' && consumerId) this.consumers.set(consumerId, Date.now())
    }

    private activeConsumers(now: number) {
        for (const [id, seen] of this.consumers) if (now - seen > CONSUMER_SEEN_MS) this.consumers.delete(id)
        return this.consumers.size
    }

    private async snapshotNow(now: number): Promise<WorkQueueSnapshot> {
        const snapshot = await this.store.snapshot(this.queueName, now)
        return {
            ...snapshot,
            saturated: snapshot.ready >= this.capacity.maxReadyTasks || snapshot.readyBytes >= this.capacity.maxReadyBytes,
            activeConsumers: this.activeConsumers(now)
        }
    }

    private wake() {
        for (const waiter of [...this.waiters]) waiter()
    }

    /** Park one long-poll iteration: woken by new work, or by its own bounded timer - never held. */
    private parked(ms: number) {
        return new Promise<void>((resolve) => {
            const waiter = () => {
                clearTimeout(timer)
                this.waiters.delete(waiter)
                resolve()
            }
            const timer = setTimeout(waiter, ms)
            timer.unref?.()
            this.waiters.add(waiter)
        })
    }

    /**
     * One timer for the whole queue, re-aimed at the store's nearest deadline - a lease about to
     * lapse, a backoff about to end, a TTL about to bind. Not one timer per task, ever.
     */
    private scheduleReap() {
        if (this.reapTimer) clearTimeout(this.reapTimer)
        this.reapTimer = undefined
        void this.store.nextDeadline(this.queueName).then((deadline) => {
            if (deadline === undefined) return
            this.reapTimer = setTimeout(() => {
                this.reapTimer = undefined
                void this.store
                    .reap(this.queueName, Date.now(), this.retry)
                    .then((result) => {
                        if (result.freed) this.wake()
                        void this.publishMetrics()
                        this.scheduleReap()
                    })
                    .catch(() => undefined)
            }, Math.max(deadline - Date.now(), 5))
            this.reapTimer.unref?.()
        })
    }

    /**
     * Metrics ride the component snapshot, coalesced by the publisher's interval rather than per
     * transition - stats() stays the authoritative point-in-time answer.
     */
    private async publishMetrics() {
        try {
            const snapshot = await this.snapshotNow(Date.now())
            this.setState({ ...snapshot })
        } catch {
            // Metrics must never take the queue down; the next transition publishes again.
        }
    }
}

/** How often the metrics component publishes at most, whatever the transition rate does. */
const METRICS_INTERVAL_MS = 250

/**
 * Stand a queue up on a server: the service exposed under its own name, running `parallel` so
 * long polls never serialise the queue against itself, with metrics as an observable component.
 */
export const exposeWorkQueue = <TTask>(
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    name: string,
    options: WorkQueueOptions = {}
): WorkQueueService<TTask> => {
    const service = new WorkQueueService<TTask>(name, options)
    server.exposeClassInstance(service, name, { execution: 'parallel', component: { minPublishIntervalMs: METRICS_INTERVAL_MS } })
    return service
}
