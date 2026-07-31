import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ILogger } from '../Logging/ILogger.js'

/**
 * Observable components: a long-lived RPC instance with two cached, read-only snapshots.
 *
 * `props` are the host's inputs - configuration, limits, location, a desired state where the domain
 * uses that convention. `state` is the instance's own public snapshot - mode, health, reported
 * values. Remote clients read both synchronously from a local cache and mutate neither: a client
 * that wants the world to change calls a typed method, whose semantics, authorization, deadline and
 * idempotency the library already carries. Anything less explicit than a method is how a property
 * assignment ends up commanding a pump with no place to put a TransportError.
 *
 * The snapshot travels whole. Full snapshots make reconnect recovery a resend rather than a patch
 * chain that one missed frame corrupts; most component state should be small and summarized, and
 * what is not small belongs in events, queues or a stream, not here.
 */

export type RpcComponentData = Record<string, unknown>

/**
 * Who is in control of this component, visible to every observer - the plant's arbitration state,
 * carried in the snapshot beside props and state rather than inside either: it is the library's
 * bookkeeping, not the class's contract, and it must not collide with a schema-checked state shape.
 */
export interface RpcComponentAuthority {
    /** Peer currently holding authority, as the transport vouched for it. Absent when free. */
    readonly holder?: string
    /** When the hold lapses on its own. A lease always expires - one that cannot is a mutex. */
    readonly expiresAt?: number
    /**
     * Increments on every grant, take, release and expiry - never on a holder's renewal, so a
     * holder's own in-flight commands survive extending the lease. The visible fence counter: the
     * within-epoch cousin of the topology spec's durable ownerEpoch, which arrives with M4.
     */
    readonly generation: number
}

export interface RpcComponentSnapshot<P extends RpcComponentData, S extends RpcComponentData> {
    /** Changes when the component instance is reconstructed - a restart is a new epoch. */
    readonly epoch: string
    /** Strictly increasing within one epoch. Published revisions may skip, never move backwards. */
    readonly revision: number
    readonly props: Readonly<P>
    readonly state: Readonly<S>
    /** Optional on the wire: a snapshot from a server older than the lease simply has no holder. */
    readonly authority?: RpcComponentAuthority
}

/**
 * The event name a component's snapshots travel under. Reserved the way `$with` is: the `$` prefix
 * marks it as the library's, so a class cannot accidentally expose an event that collides with it.
 * It is served to authorized subscribers only, never listed in introspection, and clients cannot
 * emit it - events only flow outward from a server.
 */
export const componentSnapshotEvent = '$snapshot'

interface ComponentInternals {
    epoch: string
    revision: number
    props: Readonly<RpcComponentData>
    state: Readonly<RpcComponentData>
    authority: RpcComponentAuthority
    /** Cleared and re-armed on every grant and renewal; unref'd so it cannot hold a process open. */
    expiryTimer?: NodeJS.Timeout
    /** Installed at exposure. Until then commits are local and nobody is listening. */
    notify?: () => void
    /** Installed at exposure when snapshot validation is on. A problem string refuses the commit. */
    validate?: (props: Readonly<RpcComponentData>, state: Readonly<RpcComponentData>) => string | undefined
}

/** Internals live beside the instance, not on it, so nothing here appears on the prototype walk. */
const internals = new WeakMap<object, ComponentInternals>()

const internalsOf = (component: object): ComponentInternals => {
    const found = internals.get(component)
    if (!found) throw new Error('not an RpcComponent - components are constructed through the RpcComponent base class')
    return found
}

/** Shallow copy, shallow freeze. Deep freezing is expensive and hostile to typed arrays. */
const frozen = <T extends RpcComponentData>(value: T): Readonly<T> => Object.freeze({ ...value })

const commit = (component: object, next: { props?: Readonly<RpcComponentData>; state?: Readonly<RpcComponentData> }) => {
    const held = internalsOf(component)
    const props = next.props ?? held.props
    const state = next.state ?? held.state
    // Validated before anything changes: an invalid snapshot must leave the previous one current,
    // not poison the cache first and complain afterwards. This is a self-check on server code, so
    // it throws at the setState call site - which is exactly where the bug is.
    const problem = held.validate?.(props, state)
    if (problem) throw new Error(`component snapshot rejected: ${problem}`)
    held.props = props
    held.state = state
    held.revision++
    held.notify?.()
}

export abstract class RpcComponent<P extends RpcComponentData, S extends RpcComponentData> extends EventEmitter {
    protected constructor(initialProps: P, initialState: S) {
        super()
        internals.set(this, { epoch: uuidv4(), revision: 0, props: frozen(initialProps), state: frozen(initialState), authority: Object.freeze({ generation: 0 }) })
    }

    public get props(): Readonly<P> {
        return internalsOf(this).props as Readonly<P>
    }

    public get state(): Readonly<S> {
        return internalsOf(this).state as Readonly<S>
    }

    /**
     * Own-property arrow functions rather than prototype methods, so the exposure scan cannot find
     * them - but that is consistency, not the guarantee. The guarantee is the `@rpc` allow-list a
     * component class is expected to use; a protected helper that mutated state on behalf of any
     * remote caller would be a command with no semantics, no authorization and no contract.
     */
    protected readonly setState = (update: Partial<S> | ((previous: Readonly<S>) => Partial<S>)): Readonly<S> => {
        const previous = this.state
        const patch = typeof update === 'function' ? update(previous) : update
        commit(this, { state: frozen({ ...previous, ...patch }) })
        return this.state
    }

    protected readonly replaceState = (update: S | ((previous: Readonly<S>) => S)): Readonly<S> => {
        const next = typeof update === 'function' ? update(this.state) : update
        commit(this, { state: frozen(next) })
        return this.state
    }
}

export interface RpcComponentHost<P extends RpcComponentData, S extends RpcComponentData> {
    getSnapshot(): RpcComponentSnapshot<P, S>
    /** Atomic at snapshot level: the whole props object is replaced, never patched in place. */
    replaceProps(update: P | ((previous: Readonly<P>) => P)): RpcComponentSnapshot<P, S>
}

/**
 * The local side's controller. Only code that holds the instance can obtain one, and it is never
 * reachable through a proxy - remote props are read-only by construction, not by convention.
 */
export const componentHost = <P extends RpcComponentData, S extends RpcComponentData>(component: RpcComponent<P, S>): RpcComponentHost<P, S> => ({
    getSnapshot: () => componentSnapshot(component) as RpcComponentSnapshot<P, S>,
    replaceProps: (update) => {
        const previous = component.props
        const next = typeof update === 'function' ? update(previous) : update
        commit(component, { props: frozen(next) })
        return componentSnapshot(component) as RpcComponentSnapshot<P, S>
    }
})

/** The current snapshot, for the exposure machinery and the host. */
export const componentSnapshot = (component: object): RpcComponentSnapshot<RpcComponentData, RpcComponentData> => {
    const held = internalsOf(component)
    return { epoch: held.epoch, revision: held.revision, props: held.props, state: held.state, authority: held.authority }
}

/** The current arbitration state, for the dispatch layer's authority checks. */
export const componentAuthority = (component: object): RpcComponentAuthority => internalsOf(component).authority

/** A lease always expires. The default is long enough to work under, short enough to walk away from. */
export const DEFAULT_AUTHORITY_TTL = 60_000

export type RpcAuthorityChangeReason = 'acquired' | 'renewed' | 'taken' | 'released' | 'expired'

/** Emitted on the component as the `authorityChanged` event, so expiry and takeover are observable. */
export interface RpcAuthorityChange {
    readonly reason: RpcAuthorityChangeReason
    readonly authority: RpcComponentAuthority
    readonly previousHolder?: string
}

/**
 * Replace the arbitration state and tell the world: revision bumps so the snapshot republishes with
 * the new holder in it, and `authorityChanged` carries the reason - a snapshot alone can say who is
 * in control now, but not whether the last holder released or was expired out.
 */
const commitAuthority = (component: object, next: RpcComponentAuthority, reason: RpcAuthorityChangeReason) => {
    const held = internalsOf(component)
    const previousHolder = held.authority.holder
    if (held.expiryTimer) clearTimeout(held.expiryTimer)
    held.expiryTimer = undefined
    held.authority = Object.freeze(next)
    held.revision++
    if (next.expiresAt !== undefined) {
        held.expiryTimer = setTimeout(() => {
            held.expiryTimer = undefined
            // Re-read rather than close over: a release or takeover that beat the timer already
            // committed, and this fire must not expire a lease that is no longer the one it timed.
            if (held.authority.holder !== next.holder || held.authority.generation !== next.generation) return
            commitAuthority(component, { generation: held.authority.generation + 1 }, 'expired')
        }, next.expiresAt - Date.now())
        held.expiryTimer.unref?.()
    }
    if (component instanceof EventEmitter) component.emit('authorityChanged', { reason, authority: held.authority, previousHolder } satisfies RpcAuthorityChange)
    held.notify?.()
}

export type RpcAuthorityOutcome = { granted: true; authority: RpcComponentAuthority } | { granted: false; holder: string; expiresAt: number }

/**
 * One caller asking for control. Free: granted. Held by the caller: renewed - same generation, so
 * the holder's own queued commands survive the extension. Held by another: refused with the holder
 * named, unless `take`, which is the break-in every real plant panel has - authorize() decides who
 * may use it, this only makes the takeover atomic and visible.
 */
export const acquireComponentAuthority = (component: object, caller: string, ttlMs: number, take: boolean): RpcAuthorityOutcome => {
    const held = internalsOf(component)
    const current = held.authority
    const now = Date.now()
    const holding = current.holder !== undefined && (current.expiresAt ?? 0) > now
    if (holding && current.holder !== caller && !take) return { granted: false, holder: current.holder!, expiresAt: current.expiresAt! }
    const renewal = holding && current.holder === caller
    commitAuthority(
        component,
        { holder: caller, expiresAt: now + ttlMs, generation: renewal ? current.generation : current.generation + 1 },
        renewal ? 'renewed' : holding ? 'taken' : 'acquired'
    )
    return { granted: true, authority: internalsOf(component).authority }
}

/** Idempotent, like dropping a subscription: releasing what you do not hold is not an offence. */
export const releaseComponentAuthority = (component: object, caller: string): 'ok' | 'ok - was not holding' => {
    const held = internalsOf(component)
    if (held.authority.holder !== caller) return 'ok - was not holding'
    commitAuthority(component, { generation: held.authority.generation + 1 }, 'released')
    return 'ok'
}

export interface RpcComponentExposeOptions {
    /**
     * Coalesce published snapshots to at most one per interval. Local state still changes
     * immediately - this bounds what the network hears, not what the instance knows. Same-turn
     * updates are microtask-coalesced regardless, so a method that sets three fields publishes one
     * snapshot.
     */
    minPublishIntervalMs?: number
    /**
     * Refuse to publish a snapshot larger than this. Measured as a JSON estimate, which is
     * deliberately approximate - the bound exists to catch a waveform buffer wired into state by
     * mistake, not to meter bytes. Local state still commits; the publish is skipped and logged.
     */
    maxSnapshotBytes?: number
}

/** Beyond this, a snapshot is almost certainly carrying something that belongs in a stream. */
const DEFAULT_MAX_SNAPSHOT_BYTES = 1_048_576

/** Wire commit-time validation. Called by the exposure machinery when the server asks for it. */
export const installComponentValidator = (component: object, validate: (props: Readonly<RpcComponentData>, state: Readonly<RpcComponentData>) => string | undefined) => {
    internalsOf(component).validate = validate
}

/**
 * Wire a component's commits to a publisher, coalesced. Called by the exposure machinery; the
 * publisher reads the snapshot at fire time, so several commits inside one window publish the
 * newest state once - conflation being the honest behaviour for state, where only the latest value
 * was ever the point.
 */
export const installComponentPublisher = (component: object, options: RpcComponentExposeOptions, publish: () => void, logger?: ILogger) => {
    const held = internalsOf(component)
    const interval = options.minPublishIntervalMs ?? 0
    const maxBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
    let queued = false
    let lastPublished = 0
    let timer: NodeJS.Timeout | undefined

    const publishBounded = () => {
        lastPublished = Date.now()
        const snapshot = componentSnapshot(component)
        // A rough byte count is enough: the bound is a tripwire, not an accountant.
        const estimated = JSON.stringify(snapshot).length
        if (estimated > maxBytes) {
            logger?.log('Error', 'component snapshot not published: {estimated} bytes exceeds the {maxBytes} byte bound', { estimated, maxBytes })
            return
        }
        publish()
    }

    held.notify = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
            queued = false
            const wait = lastPublished + interval - Date.now()
            if (wait <= 0) return publishBounded()
            if (timer) return
            timer = setTimeout(() => {
                timer = undefined
                publishBounded()
            }, wait)
            // Unref'd so a pending coalesce window cannot hold a closing process open. A publish
            // after the last subscriber detached is an emit nobody hears, which costs nothing.
            timer.unref?.()
        })
    }
}
