import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { RpcComponentLike, RpcComponentProxy, RpcComponentStore } from '@source-repo/rpc'
import { rpcComponent } from '@source-repo/rpc'
import type { AcquireResult, EnqueueOptions, EnqueueReceipt, WorkLease, WorkQueueCapacity, WorkQueueProtocol, WorkQueueSnapshot } from './Contract.js'
import type { WorkQueueProps, WorkQueueState } from './Service.js'

/**
 * The public producer/consumer surface. The wrapper hides the acquire loop and the retry
 * discipline; what it does not hide is the nature of the thing:
 *
 * A work-queue handler may run more than once. A lease can expire after the handler changed the
 * world but before completion reached the queue. Task IDs and lease tokens protect queue state;
 * they do not make arbitrary external side effects exactly once.
 */

export class QueueFullError extends Error {
    constructor(
        public readonly queue: string,
        public readonly retryAfterMs?: number,
        public readonly capacity?: Readonly<WorkQueueCapacity>
    ) {
        super(`work queue '${queue}' is full - it rejects new tasks rather than dropping old ones`)
        this.name = 'QueueFullError'
    }
}

export type WorkHandler<TTask> = (task: TTask, context: WorkContext<TTask>) => Promise<void>

export interface WorkContext<TTask = unknown> {
    readonly taskId: string
    readonly attempt: number
    readonly headers: Readonly<Record<string, string>>
    /** Aborted when the lease is known lost or the consumer is closed without drain. */
    readonly signal: AbortSignal
    /** The lease as delivered - including any queued context and owner fence the task carries. */
    readonly lease: WorkLease<TTask>
    renew(extensionMs?: number): Promise<void>
}

export interface ConsumeOptions {
    /** A claim, not an identity: the server trusts it only as far as its transport identity goes. */
    consumerId: string
    concurrency?: number
    leaseMs?: number
    waitMs?: number
    autoRenew?: boolean
    /** How long a slot rests after an operational failure before asking again. */
    retryDelayMs?: number
}

export interface WorkConsumer {
    readonly id: string
    readonly closed: boolean
    /** Operational trouble - transport loss, refusals - lands here, never in the task handler. */
    on(event: 'trouble', listener: (error: unknown) => void): this
    close(options?: { drain?: boolean; timeoutMs?: number }): Promise<void>
}

export interface WorkQueue<TTask> {
    enqueue(task: TTask, options?: EnqueueOptions): Promise<EnqueueReceipt>
    consume(handler: WorkHandler<TTask>, options: ConsumeOptions): Promise<WorkConsumer>
    stats(): Promise<WorkQueueSnapshot>
    /** Live coalesced metrics as a component store. The authoritative point-in-time is stats(). */
    metrics(): Promise<RpcComponentStore<WorkQueueProps, WorkQueueState>>
}

/** What connectWorkQueue needs from a peer: RpcClient and RpcServer both have exactly this. */
export interface QueuePeer {
    proxy<T>(name: string, target?: string): Promise<T>
    component<T extends RpcComponentLike>(name: string, target?: string): Promise<RpcComponentProxy<T>>
}

type MaybeOptioned<T> = T & { $with?(options: { timeoutMs?: number }): T }

/** The per-call timeout when the protocol can carry one; the protocol itself when it cannot. */
const withTimeout = <T>(protocol: MaybeOptioned<T>, timeoutMs: number): T => (typeof protocol.$with === 'function' ? protocol.$with({ timeoutMs }) : protocol)

const uncertain = (error: unknown) => {
    const code = (error as { code?: string }).code ?? String((error as Error)?.message ?? '')
    return ['Timeout', 'UnknownOutcome', 'TransportError'].some((known) => code.includes(known))
}

const delay = (ms: number) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })

const DEFAULT_WAIT_MS = 20_000
/** The margin the RPC timeout keeps beyond the queue's own wait, so the queue answers first. */
const RPC_MARGIN_MS = 5_000
const ENQUEUE_ATTEMPTS = 3

class Consumer<TTask> extends EventEmitter implements WorkConsumer {
    closed = false
    private readonly slots: Promise<void>[] = []
    private readonly inFlight = new Set<AbortController>()

    constructor(
        public readonly id: string,
        private readonly protocol: MaybeOptioned<WorkQueueProtocol<TTask>>,
        private readonly handler: WorkHandler<TTask>,
        private readonly options: ConsumeOptions
    ) {
        super()
        const concurrency = Math.max(1, options.concurrency ?? 1)
        for (let slot = 0; slot < concurrency; slot++) this.slots.push(this.runSlot())
    }

    /**
     * One acquire loop per slot, and a slot never holds two tasks: the current handler settles
     * before the next acquire, which is the whole of consumer backpressure - no prefetch, no
     * fairness algorithm, faster workers simply ask more often.
     */
    private async runSlot() {
        const waitMs = this.options.waitMs ?? DEFAULT_WAIT_MS
        const leaseMs = this.options.leaseMs ?? 0
        while (!this.closed) {
            // A fresh identity per definitive attempt; the same identity across uncertainty. This
            // is what makes a lost acquire answer safe: the retry returns the same lease instead
            // of leasing a second task to a consumer that only ever asked for one.
            const acquireId = uuidv4()
            let result: AcquireResult<TTask> | undefined
            while (!this.closed && !result) {
                try {
                    result = await withTimeout(this.protocol, waitMs + RPC_MARGIN_MS).acquire({ acquireId, consumerId: this.id, leaseMs, waitMs })
                } catch (e) {
                    this.emit('trouble', e)
                    if (!uncertain(e)) return
                    await delay(this.options.retryDelayMs ?? 1000)
                }
            }
            if (!result || result.status === 'empty') continue
            await this.handle(result.lease)
        }
    }

    private async handle(lease: WorkLease<TTask>) {
        const aborter = new AbortController()
        this.inFlight.add(aborter)
        let leaseLost = false
        const renew = async (extensionMs?: number) => {
            const answer = await withTimeout(this.protocol, RPC_MARGIN_MS).renew({ taskId: lease.taskId, leaseToken: lease.leaseToken, consumerId: this.id, extensionMs })
            if (answer.status !== 'ok') {
                // The lease is provably someone else's problem now. The handler is told to stop;
                // whatever it already did is the at-least-once statement made concrete.
                leaseLost = true
                aborter.abort()
            }
        }

        const leaseSpan = Math.max(1000, lease.leasedUntil - Date.now())
        const renewTimer =
            (this.options.autoRenew ?? true)
                ? setInterval(() => {
                      renew().catch((e) => {
                          // Uncertainty is tolerated - the next tick tries again, and expiry is
                          // the backstop the queue already handles.
                          if (!uncertain(e)) this.emit('trouble', e)
                      })
                  }, Math.max(1000, Math.floor(leaseSpan / 3)))
                : undefined
        renewTimer?.unref?.()

        try {
            const context: WorkContext<TTask> = {
                taskId: lease.taskId,
                attempt: lease.attempt,
                headers: lease.headers,
                signal: aborter.signal,
                lease,
                renew
            }
            await this.handler(lease.payload, context)
            // Completion after a known lease loss is uncertain by definition: the queue has moved
            // on, and completing under the stale token would be answered lease-lost anyway.
            if (!leaseLost) await this.settle(() => this.protocol.complete({ taskId: lease.taskId, leaseToken: lease.leaseToken, consumerId: this.id }))
        } catch (failure) {
            if (!leaseLost)
                await this.settle(() =>
                    this.protocol.fail({
                        taskId: lease.taskId,
                        leaseToken: lease.leaseToken,
                        consumerId: this.id,
                        failure: String((failure as Error)?.message ?? failure)
                    })
                )
        } finally {
            if (renewTimer) clearInterval(renewTimer)
            this.inFlight.delete(aborter)
        }
    }

    /** Complete and fail are idempotent under their token, so uncertainty is retried a few times. */
    private async settle(mutate: () => Promise<unknown>) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await mutate()
                return
            } catch (e) {
                this.emit('trouble', e)
                if (!uncertain(e)) return
                await delay(500 * (attempt + 1))
            }
        }
    }

    async close(options: { drain?: boolean; timeoutMs?: number } = {}) {
        const drain = options.drain ?? true
        this.closed = true
        if (!drain) for (const aborter of [...this.inFlight]) aborter.abort()
        // Slots settle when their current handler does; an idle slot settles when its bounded long
        // poll answers empty. The timeout bounds the goodbye, not the work.
        await Promise.race([Promise.allSettled(this.slots), delay(options.timeoutMs ?? 30_000)])
    }
}

/**
 * The wrapper over any protocol carrier: a remote proxy from connectWorkQueue, or the service
 * instance itself for in-process use - which is what lets one conformance suite cover both.
 */
export const workQueueOver = <TTask>(
    protocol: MaybeOptioned<WorkQueueProtocol<TTask>>,
    name: string,
    metrics?: () => Promise<RpcComponentStore<WorkQueueProps, WorkQueueState>>
): WorkQueue<TTask> => ({
    async enqueue(task, options = {}) {
        const request = {
            taskId: options.taskId ?? uuidv4(),
            payload: task,
            headers: options.headers ?? {},
            priority: options.priority ?? 0,
            ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
            ...(options.deduplicationKey ? { deduplicationKey: options.deduplicationKey } : {}),
            ...(options.context ? { context: options.context } : {}),
            ...(options.ownerFence ? { ownerFence: options.ownerFence } : {})
        }
        // The taskId is stable across these attempts, so the server's identity window makes the
        // retry of an uncertain outcome safe: the duplicate answers with the original receipt.
        let lastFailure: unknown
        for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt++) {
            try {
                const result = await protocol.enqueue(request)
                if (result.status === 'full') throw new QueueFullError(name, result.retryAfterMs)
                return result.receipt
            } catch (e) {
                if (!uncertain(e)) throw e
                lastFailure = e
                await delay(500 * (attempt + 1))
            }
        }
        throw lastFailure
    },

    async consume(handler, options) {
        return new Consumer(options.consumerId, protocol, handler, options)
    },

    stats: () => protocol.stats(),

    metrics: metrics ?? (() => Promise.reject(new Error(`work queue '${name}' has no component channel here - in-process callers read the service state directly`)))
})

/** Connect to a queue served elsewhere on the network, under this peer's own name and link. */
export const connectWorkQueue = async <TTask>(peer: QueuePeer, name: string, target?: string): Promise<WorkQueue<TTask>> => {
    const protocol = await peer.proxy<MaybeOptioned<WorkQueueProtocol<TTask>>>(name, target)
    return workQueueOver(protocol, name, async () => {
        const remote = await peer.component<{ props: WorkQueueProps; state: WorkQueueState }>(name, target)
        return remote[rpcComponent] as RpcComponentStore<WorkQueueProps, WorkQueueState>
    })
}
