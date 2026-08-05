import { TransportEvent, rpcComponent, type RpcComponentLike, type RpcComponentProxy } from '@source-repo/rpc'
import type { SparkplugEdgeNodeSession } from './EdgeNodeSession.js'
import type { SparkplugComponentProjectionStore } from './Projection.js'
import { canonicalSparkplugProjectionJson, type SparkplugCompiledProjectionContract } from './ProjectionContract.js'

export function sourceRpcComponentStore<T extends RpcComponentLike>(component: RpcComponentProxy<T>): SparkplugComponentProjectionStore {
    return component[rpcComponent]
}

export interface SourceRpcPeerShapeEvents {
    on(event: typeof TransportEvent.peerShape, listener: (peer: string, shape: string) => void): unknown
    off(event: typeof TransportEvent.peerShape, listener: (peer: string, shape: string) => void): unknown
}

export interface SparkplugSourceRpcProjectionRevalidatorOptions {
    readonly client: SourceRpcPeerShapeEvents
    readonly session: SparkplugEdgeNodeSession
    readonly compiled: SparkplugCompiledProjectionContract
    readonly recompile: () => SparkplugCompiledProjectionContract | Promise<SparkplugCompiledProjectionContract>
    readonly onError?: (error: unknown) => void
}

/** Revalidates relevant peer shape signals against the canonical projection hash. */
export class SparkplugSourceRpcProjectionRevalidator {
    #compiled: SparkplugCompiledProjectionContract
    readonly #contractJson: string
    readonly #sourcePeers: ReadonlySet<string>
    #started = false
    #closed = false
    #pending = false
    #failed = false
    #drain?: Promise<void>
    #queuedError?: unknown

    readonly #onPeerShape = (peer: string): void => {
        if (!this.#sourcePeers.has(peer)) return
        this.queueRevalidation()
        void this.flush().catch((error: unknown) => this.options.onError?.(error))
    }

    constructor(private readonly options: SparkplugSourceRpcProjectionRevalidatorOptions) {
        this.#compiled = options.compiled
        this.#contractJson = canonicalSparkplugProjectionJson(options.compiled.contract)
        this.#sourcePeers = new Set(options.compiled.devices.map((device) => device.source.peer))
    }

    get compiled(): SparkplugCompiledProjectionContract {
        return this.#compiled
    }

    start(): void {
        if (this.#closed) throw new Error('Sparkplug projection revalidator is closed')
        if (this.#started) throw new Error('Sparkplug projection revalidator is already started')
        this.#started = true
        this.options.client.on(TransportEvent.peerShape, this.#onPeerShape)
    }

    async revalidate(): Promise<void> {
        if (this.#closed) throw new Error('Sparkplug projection revalidator is closed')
        this.queueRevalidation()
        await this.flush()
    }

    async flush(): Promise<void> {
        while (this.#drain) await this.#drain
        if (this.#queuedError !== undefined) {
            const error = this.#queuedError
            this.#queuedError = undefined
            throw error
        }
    }

    async retry(): Promise<void> {
        if (this.#closed) throw new Error('Sparkplug projection revalidator is closed')
        this.#queuedError = undefined
        this.#failed = false
        this.#pending = true
        this.startDrain()
        await this.flush()
    }

    async close(): Promise<void> {
        if (this.#closed) return
        this.#closed = true
        if (this.#started) this.options.client.off(TransportEvent.peerShape, this.#onPeerShape)
        this.#started = false
        this.#pending = false
        await this.flush()
    }

    private queueRevalidation(): void {
        this.#pending = true
        this.#failed = false
        this.startDrain()
    }

    private startDrain(): void {
        if (this.#drain || this.#failed || !this.#pending) return
        const drain = this.drainPending()
        this.#drain = drain
        void drain.then(() => {
            if (this.#drain !== drain) return
            this.#drain = undefined
            if (this.#pending && !this.#failed) this.startDrain()
        })
    }

    private async drainPending(): Promise<void> {
        while (this.#pending) {
            this.#pending = false
            try {
                const next = await this.options.recompile()
                if (canonicalSparkplugProjectionJson(next.contract) !== this.#contractJson)
                    throw new Error('running Sparkplug projection contract changed; restart the projection runners before applying it')
                if (next.hash === this.#compiled.hash) continue
                await this.options.session.rebirth()
                this.#compiled = next
            } catch (error) {
                this.#pending = true
                this.#queuedError ??= error
                this.#failed = true
                return
            }
        }
    }
}
