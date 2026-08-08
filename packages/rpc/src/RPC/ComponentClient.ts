import { TransportEvent } from './Core.js'
import { componentSnapshotEvent, type RpcComponent, type RpcComponentAuthority, type RpcComponentData, type RpcComponentSnapshot } from './Component.js'
import type { RpcCallOptions, RpcClientHandler, WithOptions } from './RpcClientHandler.js'

/**
 * The client side of an observable component: one shared channel per (target, namespace), a cached
 * view read synchronously, and a status that says whether the picture is current.
 *
 * Reads never contend and never cost a network hop; what they cost instead is honesty about age,
 * which is what the status carries. The last snapshot stays readable while stale, because "last
 * known, twenty seconds ago" is an answer and `undefined` is not.
 */

export const rpcComponent = Symbol('@source-repo/rpc/component')

export type RpcComponentStatus = 'initializing' | 'live' | 'stale' | 'closed'

export interface RpcComponentView<P extends RpcComponentData, S extends RpcComponentData> extends RpcComponentSnapshot<P, S> {
    readonly status: RpcComponentStatus
    /** Local receipt time. Useful for display; never for distributed ordering - clocks disagree. */
    readonly receivedAt: number
    readonly staleSince?: number
}

export interface RpcComponentStore<P extends RpcComponentData, S extends RpcComponentData> {
    getSnapshot(): RpcComponentView<P, S>
    subscribe(listener: () => void): () => void
    close(): Promise<void>
}

export type ComponentProps<T> = T extends RpcComponent<infer P, infer _S> ? P : never
export type ComponentState<T> = T extends RpcComponent<infer _P, infer S> ? S : never

/**
 * The constraint is the readable surface, not the base class: `setState`'s parameter makes
 * `RpcComponent<P, S>` contravariant in its generics, so a concrete component never satisfies
 * `RpcComponent<RpcComponentData, RpcComponentData>`. What a client needs proven is only that
 * props and state exist to cache; the server decides at runtime whether it is truly a component.
 */
export type RpcComponentLike = { readonly props: RpcComponentData; readonly state: RpcComponentData }

/** What a caller may ask for beyond the component itself. */
export interface RpcComponentOptions {
    /**
     * Receive only these paths, each spelled from `props` or `state` - `['state', 'zones', 'top',
     * 'setpoint']`, which `rpcPath` produces. Omitted means the whole snapshot, as it always was.
     *
     * What arrives is still a whole snapshot, of the projection: duplicate delivery stays harmless,
     * a reconnect is still repaired by one frame, and the epoch and revision rules are untouched.
     * Only how much of the state is in it changes, which is why this needs no base tracking and no
     * keyframe schedule - and why it is worth reaching for before any delta encoding.
     *
     * One peer holds one subscription per component, so opening a second view of the same component
     * with different paths is refused rather than silently served the first one's.
     */
    paths?: readonly (readonly string[])[]
}


export type RpcComponentProxy<T extends RpcComponentLike> = T & {
    $with(options: RpcCallOptions): RpcComponentProxy<T>
    /**
     * Ask for control of the component. Granted when free, renewed when already held by this peer,
     * refused `NotInControl` naming the holder when held by another - unless `take`, the break-in
     * every plant panel has, which authorize() on the server decides who may use. The lease always
     * expires; who holds it is in every snapshot's `authority`.
     */
    $acquire(ttlMs?: number, options?: { take?: boolean }): Promise<RpcComponentAuthority>
    /** Idempotent: releasing what this peer does not hold answers politely rather than erring. */
    $release(): Promise<'ok' | 'ok - was not holding'>
    readonly [rpcComponent]: RpcComponentStore<ComponentProps<T>, ComponentState<T>>
}

/** The proxy surface a channel drives: the snapshot event, through the ordinary event machinery. */
type Subscribable = {
    on(event: string, handler: (snapshot: unknown) => void, projection?: readonly (readonly string[])[]): Promise<unknown>
    off(event: string, handler: (snapshot: unknown) => void): Promise<unknown>
}

class ComponentChannel {
    /** Replaced whole on every change, so a store consumer can compare by reference. */
    view: RpcComponentView<RpcComponentData, RpcComponentData> = {
        epoch: '',
        revision: -1,
        props: Object.freeze({}),
        state: Object.freeze({}),
        status: 'initializing',
        receivedAt: 0
    }
    users = 0
    readonly inner: object
    readonly store: RpcComponentStore<RpcComponentData, RpcComponentData>
    /** Settles when the first snapshot lands, which is what component() awaits. */
    readonly first: Promise<void>
    private readonly listeners = new Set<() => void>()
    private readonly retired = new Set<string>()
    private settleFirst!: () => void
    private readonly handler = (snapshot: unknown) => this.accept(snapshot as RpcComponentSnapshot<RpcComponentData, RpcComponentData>)

    constructor(
        client: RpcClientHandler,
        readonly namespace: string,
        readonly target: string | undefined,
        private readonly release: () => void,
        /** What this channel asked for, when it asked for less than everything. */
        readonly projection?: readonly (readonly string[])[]
    ) {
        this.inner = client.proxy<object>(namespace, target)
        this.first = new Promise((resolve) => (this.settleFirst = resolve))
        this.store = {
            getSnapshot: () => this.view,
            subscribe: (listener) => {
                this.listeners.add(listener)
                return () => this.listeners.delete(listener)
            },
            close: () => this.close()
        }
    }

    /**
     * Install the local handler, then ask the server - which answers with a targeted snapshot.
     *
     * The projection rides on the subscribe, because that is the only moment a subscriber gets to
     * say what it wants; everything after is the server pushing. What comes back is still a whole
     * snapshot, of the projection, so nothing about the acceptance rules below changes.
     */
    async open() {
        await (this.inner as Subscribable).on(componentSnapshotEvent, this.handler, this.projection)
        await this.first
    }

    /**
     * The acceptance rules, and nothing but them: first wins, then higher revision within an epoch,
     * then a new epoch replaces and retires the old. Wall clocks decide nothing - a browser, an
     * edge box and a plant server do not agree on the time, and do not need to.
     */
    private accept(snapshot: RpcComponentSnapshot<RpcComponentData, RpcComponentData>) {
        if (this.view.status === 'closed') return
        if (this.retired.has(snapshot.epoch)) return
        if (this.view.epoch === snapshot.epoch && snapshot.revision <= this.view.revision) return
        if (this.view.epoch && this.view.epoch !== snapshot.epoch) this.retired.add(this.view.epoch)
        this.view = { ...snapshot, status: 'live', receivedAt: Date.now() }
        this.settleFirst()
        this.notify()
    }

    /** The picture is no longer known to be current. The picture itself stays readable. */
    markStale() {
        if (this.view.status !== 'live') return
        this.view = { ...this.view, status: 'stale', staleSince: Date.now() }
        this.notify()
    }

    private async close() {
        if (this.users > 0) this.users--
        if (this.users > 0) return
        this.view = { ...this.view, status: 'closed' }
        this.notify()
        this.release()
        // The refcounted off: other local handlers would keep the remote subscription, but a
        // channel holds exactly one, so this is what ends it on the server.
        await (this.inner as Subscribable).off(componentSnapshotEvent, this.handler).catch(() => undefined)
    }

    markClosed() {
        if (this.view.status === 'closed') return
        this.view = { ...this.view, status: 'closed' }
        this.notify()
    }

    private notify() {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch {
                // A store consumer's render bug is not this channel's failure to report.
            }
        }
    }
}

/** Whether two projections ask for the same thing. Mirrors the server's comparison exactly. */
const sameProjection = (a: readonly (readonly string[])[] | undefined, b: readonly (readonly string[])[] | undefined) => {
    if (!a || !b) return a === b
    if (a.length !== b.length) return false
    return a.every((path, index) => path.length === b[index].length && path.every((segment, at) => segment === b[index][at]))
}

const describeProjection = (projection: readonly (readonly string[])[] | undefined) =>
    projection ? projection.map((path) => path.join('.')).join(', ') : 'the whole snapshot'

/**
 * One channel per (target, namespace), shared by every component() call for it and reference
 * counted, so two panes watching one pump cost one subscription - and one leaving does not take
 * the feed from the other, which is the client-side half of the rule the subscription refcounting
 * enforces underneath.
 */
export class ComponentChannels {
    private readonly channels = new Map<string, ComponentChannel>()

    constructor(
        private readonly handler: RpcClientHandler,
        lifecycle: { on(event: string, listener: (...args: unknown[]) => void): unknown }
    ) {
        // Link down: every picture is now of unknown age. Peer gone: only that peer's are - which
        // is the distinction the forwarded peer lifecycle exists to make visible.
        lifecycle.on(TransportEvent.disconnected, () => {
            for (const channel of this.channels.values()) channel.markStale()
        })
        for (const event of [TransportEvent.peerGone, TransportEvent.peerDisplaced])
            lifecycle.on(event, (peer: unknown) => {
                for (const channel of this.channels.values()) if (channel.target === peer) channel.markStale()
            })
    }

    async open(namespace: string, target: string | undefined, projection?: readonly (readonly string[])[]): Promise<ComponentChannel> {
        // NUL as the separator: it cannot occur in a peer or namespace id. Escaped, never the byte.
        const key = `${target ?? ''}\u0000${namespace}`
        let channel = this.channels.get(key)
        // One subscription per peer per component, which the server enforces by keying on the pair -
        // so two observers here asking for different projections would be one subscription whose
        // paths depended on who opened first, and the second would silently receive the first's.
        // Refused instead, naming both, because a projection nobody asked for is worse on a slow
        // link than no projection at all: it looks like the feature working.
        if (channel && !sameProjection(channel.projection, projection))
            throw new Error(
                `component: ${namespace}${target ? ` on ${target}` : ''} is already observed here with a different projection ` +
                    `(${describeProjection(channel.projection)} against ${describeProjection(projection)}) - one peer holds one subscription per component`
            )
        if (!channel) {
            channel = new ComponentChannel(this.handler, namespace, target, () => void this.channels.delete(key), projection)
            this.channels.set(key, channel)
            try {
                await channel.open()
            } catch (e) {
                this.channels.delete(key)
                throw e
            }
        } else await channel.first
        channel.users++
        return channel
    }

    /** Local teardown only: the link is going away, and the server reaps a departed client. */
    closeAll() {
        for (const channel of this.channels.values()) channel.markClosed()
        this.channels.clear()
    }
}

/**
 * Wrap a channel's inner proxy: methods and events pass through untouched, `props`, `state` and the
 * store read from the channel, and `$with` returns another facade over the optioned proxy so the
 * component surface survives attaching an idempotency key or a per-call timeout.
 */
export const componentFacade = (channel: ComponentChannel, inner: object): object =>
    new Proxy(inner, {
        get: (target, prop) => {
            if (prop === 'props') return channel.view.props
            if (prop === 'state') return channel.view.state
            if (prop === rpcComponent) return channel.store
            if (prop === '$with') return (options: RpcCallOptions) => componentFacade(channel, (inner as WithOptions<object>).$with(options))
            return (target as Record<string | symbol, unknown>)[prop]
        },
        set: (target, prop, value) => {
            // The whole point, enforced at runtime as well as in the types: a component is read
            // through the cache and changed through methods, never assigned to.
            if (prop === 'props' || prop === 'state') throw new TypeError(`${String(prop)} is read-only on a component proxy - call a method to change the world`)
            ;(target as Record<string | symbol, unknown>)[prop] = value
            return true
        }
    })
