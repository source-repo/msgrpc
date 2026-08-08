import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { TransportEvent } from './Core.js'
import { subscriptionKey, type RpcClientHandler } from './RpcClientHandler.js'
import {
    captureRpcContext,
    contextEvent,
    contextNamespace,
    type ContextWireEntry,
    type ContextWireSnapshot,
    type HostContext,
    type RpcCapturedContext,
    type RpcContextAxis,
    type RpcContextToken
} from './Context.js'
import { sameRef, type RpcRef } from './Topology.js'

/**
 * The per-host resolver: local providers overlaid on whatever the chains inherit from other
 * hosts, cached as immutable snapshots a store serves synchronously. Each axis of each local
 * node is one chain of hops - this host first, then one hop per host the chain continues on -
 * and every hop is a register-then-snapshot subscription delivering full frames, so a duplicate
 * or a replay is harmless and a lost one is repaired by the next.
 *
 * The public lifecycle vocabulary is the adopted one: `initializing | live | stale | missing |
 * invalid | closed`, with `resolving` existing only as this file's internal notion of a hop that
 * has not answered yet. `stale` keeps its narrow meaning - same mount, freshness unknown - and a
 * remount is a new mount epoch with the old value kept only as diagnostics.
 */

export type RpcContextStatus = 'initializing' | 'live' | 'stale' | 'missing' | 'invalid' | 'closed'
export type RpcContextTransitionReason = 'initial-load' | 'owner-remount' | 'parent-remount' | 'reconnect'
export type RpcContextInvalidReason = 'cycle' | 'depth-exceeded' | 'invalid-reference'

export interface RpcResolvedContextEntry {
    value: unknown
    provider: RpcRef
    providerVersion: { epoch: string; revision: number }
}

export interface RpcContextSnapshot {
    tokenId: string
    axis: RpcContextAxis
    status: RpcContextStatus
    /** Identifies one complete effective chain. A remount replaces it; frames from old mounts die. */
    mountEpoch: string
    resolvedAt: number
    staleSince?: number
    transitionReason?: RpcContextTransitionReason
    invalidReason?: RpcContextInvalidReason
    invalidPath?: RpcRef[]
    /** Nearest resolution: the winning entry. */
    entry?: RpcResolvedContextEntry
    /** Collect resolution: every provider, nearest to farthest. */
    entries?: RpcResolvedContextEntry[]
    /** The last complete mount, for display and diagnostics only. Never returned by require(). */
    previous?: RpcResolvedContextEntry | RpcResolvedContextEntry[]
}

export interface RpcContextStore {
    getSnapshot(): RpcContextSnapshot
    subscribe(listener: () => void): () => void
    close(): void
}

interface RemoteHop {
    peer: string
    node: string
    axis: RpcContextAxis
    subscriptionId: string
    snapshot?: ContextWireSnapshot
    stale: boolean
    retired: boolean
    /** The token ids this hop's subscription currently covers. Widening the set re-subscribes. */
    tokenKey?: string
    detach?: () => void
}

interface TokenState {
    token: RpcContextToken
    view: RpcContextSnapshot
    listeners: Set<() => void>
    users: number
}

/** What the subscribe/read methods look like from this side of the wire. */
interface ContextProtocol {
    read(node: string, tokenIds: string[]): Promise<ContextWireSnapshot>
    subscribe(subscriptionId: string, node: string, tokenIds: string[]): Promise<ContextWireSnapshot>
    unsubscribe(subscriptionId: string): Promise<unknown>
}

const MAX_TOTAL_CHAIN = 128

export class ContextResolver {
    private readonly chains = new Map<string, NodeChain>()

    constructor(
        readonly local: HostContext,
        readonly peer: string,
        readonly caller: RpcClientHandler,
        lifecycle: EventEmitter
    ) {
        local.on('contextChanged', () => {
            for (const chain of this.chains.values()) chain.localChanged()
        })
        // Staleness and repair ride the same lifecycle the component channels proved: a lost link
        // stales every chain, a lost peer only its hops, and a reconnect replays subscriptions -
        // register-then-snapshot means the replay's answer is the repair.
        lifecycle.on(TransportEvent.disconnected, () => {
            for (const chain of this.chains.values()) chain.markStale()
        })
        for (const event of [TransportEvent.peerGone, TransportEvent.peerDisplaced])
            lifecycle.on(event, (gone: unknown) => {
                for (const chain of this.chains.values()) chain.peerLost(String(gone))
            })
        lifecycle.on(TransportEvent.connected, () => {
            for (const chain of this.chains.values()) chain.reconnect()
        })
    }

    /** One chain per local node, shared by every token asked of it - the dedup that matters. */
    store(node: string, token: RpcContextToken): RpcContextStore {
        let chain = this.chains.get(node)
        if (!chain) this.chains.set(node, (chain = new NodeChain(this, node, () => this.chains.delete(node))))
        return chain.storeFor(token)
    }

    /**
     * What some *other* peer's node resolves, watched the same way a local one is.
     *
     * store() answers for a node this peer holds, which is what code that acts on context needs.
     * An operator's console is the other case: it asks about a node it does not own, and it has no
     * business grafting itself into the topology to do so - a page is not working on the oven's
     * behalf, and saying otherwise in the records to read a value is a lie every other peer can
     * see. Physical edges cross hosts only root to root, so there is no honest graft available
     * anyway.
     *
     * The chain machinery does not care where a chain starts: a hop is a hop, the origin's own
     * host answers the first one, and continuations are followed from there exactly as they are
     * for a local node - including the cycle and depth checks, which only the origin can make.
     * So this is the same resolution, the same lifecycle vocabulary and the same store, begun one
     * step further out. It is not a second implementation of any of that, deliberately: a console
     * that quietly disagreed with the library about what a node sees would be worse than one that
     * could not show it at all.
     */
    storeAt(ref: RpcRef, token: RpcContextToken): RpcContextStore {
        if (ref.peer === this.peer) return this.store(ref.instance, token)
        /** Key `${peer}\u0000${instance}` - NUL because neither part can contain it. Escaped, never the byte. */
        const key = `${ref.peer}\u0000${ref.instance}`
        let chain = this.chains.get(key)
        if (!chain) this.chains.set(key, (chain = new NodeChain(this, ref.instance, () => this.chains.delete(key), ref)))
        return chain.storeFor(token)
    }

    /** The policy gate: what code that *depends* on context calls, and what fails closed. */
    require(node: string, token: RpcContextToken): unknown {
        const view = this.store(node, token).getSnapshot()
        if (view.status === 'invalid') throw new Error(`context: ${token.id} at ${node} is invalid (${view.invalidReason}) - topology-dependent decisions fail closed`)
        if (view.status === 'missing') throw new Error(`context: nothing provides ${token.id} on ${node}'s ${token.axis} chain`)
        if (view.status === 'stale' && (token.stalePolicy ?? 'allow') === 'reject') throw new Error(`context: ${token.id} at ${node} is stale, and this token rejects stale answers`)
        if (view.status !== 'live' && view.status !== 'stale') throw new Error(`context: ${token.id} at ${node} is still ${view.status}`)
        const entry = view.entry ?? view.entries?.[0]
        if (!entry) throw new Error(`context: nothing provides ${token.id} on ${node}'s ${token.axis} chain`)
        return entry.value
    }

    /** Deliberate capture of what this node currently sees, bounded and policy-checked. */
    capture(node: string, tokens: RpcContextToken[]): RpcCapturedContext {
        return captureRpcContext(
            { peer: this.peer, instance: node },
            tokens.map((token) => {
                const view = this.store(node, token).getSnapshot()
                const entry = view.entry ?? view.entries?.[0]
                return {
                    token,
                    ...(entry && (view.status === 'live' || view.status === 'stale')
                        ? {
                              entry: {
                                  tokenId: token.id,
                                  schemaVersion: token.schemaVersion,
                                  axis: token.axis,
                                  provider: entry.provider,
                                  providerVersion: entry.providerVersion,
                                  mountEpoch: view.mountEpoch,
                                  value: entry.value
                              }
                          }
                        : {})
                }
            })
        )
    }
}

/**
 * One local node's chains, both axes, all tokens. Tokens of one axis share that axis's hops, so
 * twenty tokens inherited from one upstream host cost one subscription - the dedup the spec asks
 * for, keyed by (remote peer, node, axis) with the token set widened as stores arrive.
 */
class NodeChain {
    private readonly tokens = new Map<string, TokenState>()
    private hops: { physical: RemoteHop[]; logical: RemoteHop[] } = { physical: [], logical: [] }
    private localSnapshot?: ContextWireSnapshot
    /** Retired subscription ids: a frame from an old mount matches nothing and dies here. */
    private readonly retired = new Set<string>()
    /** A ring found while following continuations: the path from its first ref around to its close. */
    private cycles: { [axis in RpcContextAxis]?: RpcRef[] } = {}
    private mountKeys: { [axis in RpcContextAxis]?: string } = {}
    private mountEpochs: { [axis in RpcContextAxis]?: string } = {}
    private reasons: { [axis in RpcContextAxis]?: RpcContextTransitionReason } = {}

    constructor(
        private readonly resolver: ContextResolver,
        private readonly node: string,
        private readonly release: () => void,
        /**
         * Where the chain starts, when that is not a node on this host. Absent is the ordinary
         * case: the local tables answer first and the chain continues outwards from there.
         */
        private readonly origin?: RpcRef
    ) {}

    storeFor(token: RpcContextToken): RpcContextStore {
        let state = this.tokens.get(token.id)
        if (!state) {
            state = {
                token,
                view: { tokenId: token.id, axis: token.axis, status: 'initializing', mountEpoch: '', resolvedAt: 0, transitionReason: 'initial-load' },
                listeners: new Set(),
                users: 0
            }
            this.tokens.set(token.id, state)
            this.localChanged()
        }
        state.users++
        const held = state
        return {
            getSnapshot: () => held.view,
            subscribe: (listener) => {
                held.listeners.add(listener)
                return () => held.listeners.delete(listener)
            },
            close: () => {
                held.users--
                if (held.users > 0) return
                held.view = { ...held.view, status: 'closed' }
                this.notify(held)
                this.tokens.delete(held.token.id)
                if (this.tokens.size === 0) {
                    for (const axis of ['physical', 'logical'] as const) this.retireFrom(axis, 0)
                    this.release()
                }
            }
        }
    }

    /** The local host's part changed - providers, topology, or the token set - so everything re-derives. */
    localChanged() {
        // A chain that begins elsewhere has no local part to recompute. Its hops still re-open
        // below when the token set widens, which is the other thing this method is for.
        if (!this.origin) this.localSnapshot = this.resolver.local.snapshotFor(this.node, [...this.tokens.keys()], 0, false)
        this.rebuild('physical')
        this.rebuild('logical')
        for (const axis of ['physical', 'logical'] as const)
            for (const hop of this.hops[axis]) {
                if (hop.retired) continue
                // A chain that re-enters this host answers from the local tables, freshly; a
                // remote hop whose token set widened re-subscribes, because its standing
                // subscription only ever covers what it was asked for at the time.
                if (hop.peer === this.resolver.peer || hop.tokenKey !== this.tokensFor(axis).join(',')) void this.open(hop)
            }
        this.recompute()
    }

    markStale() {
        for (const axis of ['physical', 'logical'] as const) for (const hop of this.hops[axis]) hop.stale = true
        this.recompute()
    }

    peerLost(peer: string) {
        for (const axis of ['physical', 'logical'] as const) for (const hop of this.hops[axis]) if (hop.peer === peer) hop.stale = true
        this.recompute()
    }

    reconnect() {
        for (const axis of ['physical', 'logical'] as const)
            for (const hop of this.hops[axis])
                if (hop.stale && !hop.retired) {
                    this.reasons[axis] = 'reconnect'
                    void this.open(hop)
                }
    }

    /**
     * Follow one axis's continuations, reusing hops that still match and retiring the rest. The
     * ring check happens *here*, before a closing hop would be created: a continuation pointing
     * at a ref the chain has already walked is the cycle made visible - and only the origin can
     * see it, because only the origin holds the whole chain. Extending anyway would follow the
     * ring around forever, one polite subscription at a time.
     */
    private rebuild(axis: RpcContextAxis) {
        const chain = this.hops[axis]
        this.cycles[axis] = undefined
        // The refs walked *before* the continuation under test - a hop's own refs join only after
        // the continuation that led to it has been cleared, or every normal chain would read as a
        // ring closing on its own next hop.
        let prefix = [...(this.localSnapshot?.walked[axis] ?? [])]
        // A remote origin is simply the first continuation: nothing has been walked before it, so
        // the ring check starts clean and the first hop is the origin's own host.
        let expected = this.origin ?? this.localSnapshot?.continues[axis]
        let index = 0
        while (expected) {
            const target = expected
            const seenAt = prefix.findIndex((ref) => sameRef(ref, target))
            if (seenAt !== -1) {
                this.cycles[axis] = prefix.slice(seenAt)
                this.retireFrom(axis, index)
                return
            }
            const current: RemoteHop | undefined = chain[index]
            if (current && current.peer === expected.peer && current.node === expected.instance) {
                if (current.snapshot) prefix = [...prefix, ...current.snapshot.walked[axis]]
                expected = current.snapshot?.continues[axis]
                index++
                continue
            }
            this.retireFrom(axis, index)
            const hop: RemoteHop = { peer: expected.peer, node: expected.instance, axis, subscriptionId: uuidv4(), stale: false, retired: false }
            chain[index] = hop
            void this.open(hop)
            // Nothing to follow yet: the hop's first snapshot will say where the chain goes next,
            // and its arrival re-enters this rebuild.
            expected = undefined
            index++
        }
        this.retireFrom(axis, index)
    }

    private retireFrom(axis: RpcContextAxis, index: number) {
        const chain = this.hops[axis]
        for (const hop of chain.splice(index)) {
            hop.retired = true
            this.retired.add(hop.subscriptionId)
            hop.detach?.()
            const protocol = this.resolver.caller.proxy<ContextProtocol>(contextNamespace, hop.peer)
            void Promise.resolve(protocol.unsubscribe(hop.subscriptionId)).catch(() => undefined)
        }
    }

    private tokensFor(axis: RpcContextAxis) {
        return [...this.tokens.values()].filter((state) => state.token.axis === axis).map((state) => state.token.id)
    }

    private async open(hop: RemoteHop) {
        hop.tokenKey = this.tokensFor(hop.axis).join(',')
        // A continuation that re-enters the origin host is not a network hop: the local tables
        // answer it directly, which is also what lets a cross-host ring close into a visible
        // cycle instead of a host politely dialling itself forever.
        if (hop.peer === this.resolver.peer) {
            this.accept(hop, this.resolver.local.snapshotFor(hop.node, this.tokensFor(hop.axis), 0, false))
            return
        }
        const emitter = this.resolver.caller.eventEmitter as unknown as EventEmitter
        if (!hop.detach) {
            const key = subscriptionKey(hop.peer, contextNamespace, contextEvent)
            const handler = (frame: unknown) => {
                const push = frame as { subscriptionId: string; snapshot: ContextWireSnapshot }
                if (push.subscriptionId !== hop.subscriptionId || hop.retired) return
                // Ordering: a stray older frame never replaces a newer one. The explicit
                // resubscribe below bypasses this by replacing the snapshot directly.
                if (hop.snapshot && push.snapshot.seq <= hop.snapshot.seq) return
                this.accept(hop, push.snapshot)
            }
            emitter.on(key, handler)
            hop.detach = () => void emitter.removeListener(key, handler)
        }
        try {
            const protocol = this.resolver.caller.proxy<ContextProtocol>(contextNamespace, hop.peer)
            const snapshot = await protocol.subscribe(hop.subscriptionId, hop.node, this.tokensFor(hop.axis))
            if (hop.retired) return
            // Accepted unconditionally: a direct answer to our own subscribe is the current truth,
            // and a restarted server legitimately starts its sequence numbers over.
            hop.stale = false
            this.accept(hop, snapshot)
        } catch {
            if (!hop.retired) {
                hop.stale = true
                this.recompute()
                // Retried until it lands or the hop retires: a reconnect races the presence of
                // whoever just came back, and a replay that gave up on its first throw would
                // leave the chain stale forever over a race nobody can see. Unref'd, so a
                // closing process is not held open by a chain still hoping.
                const retry = setTimeout(() => {
                    if (!hop.retired && hop.stale) void this.open(hop)
                }, 2000)
                retry.unref?.()
            }
        }
    }

    private accept(hop: RemoteHop, snapshot: ContextWireSnapshot) {
        const continuationChanged = !hop.snapshot || !sameRef(hop.snapshot.continues[hop.axis] ?? null, snapshot.continues[hop.axis] ?? null)
        hop.snapshot = snapshot
        hop.stale = false
        if (continuationChanged) this.rebuild(hop.axis)
        this.recompute()
    }

    /** Fold local + hops into every token's public snapshot. Full replacement, reference-stable. */
    private recompute() {
        for (const state of this.tokens.values()) {
            const axis = state.token.axis
            const hops = this.hops[axis]
            const parts: ContextWireSnapshot[] = [...(this.localSnapshot ? [this.localSnapshot] : []), ...hops.flatMap((hop) => (hop.snapshot ? [hop.snapshot] : []))]

            // The mount: the chain's identity, composed of every part's axis key. A change is a
            // remount - reasoned by which axis's key moved - and the old world becomes `previous`.
            const mountKey = parts.map((part) => part.chainKey[axis]).join(' ') + ' ' + hops.map((hop) => hop.subscriptionId).join(' ')
            let remounted = false
            if (this.mountKeys[axis] !== mountKey) {
                if (this.mountKeys[axis] !== undefined && this.reasons[axis] !== 'reconnect') this.reasons[axis] = axis === 'logical' ? 'owner-remount' : 'parent-remount'
                this.mountKeys[axis] = mountKey
                this.mountEpochs[axis] = uuidv4()
                remounted = true
            }
            const mountEpoch = this.mountEpochs[axis] ?? ''
            const reason = this.reasons[axis] ?? 'initial-load'

            // Trouble anywhere on the axis is invalid topology for everything that inherits over
            // it - require() fails closed on this regardless of any stale policy.
            const troubled = parts.flatMap((part) => part.trouble.filter((trouble) => trouble.axis === axis))
            const waiting = hops.some((hop) => !hop.snapshot && !hop.retired)
            const anyStale = hops.some((hop) => hop.stale && !hop.retired)

            // Cross-host cycles and depth: only the origin sees the whole chain, so only the
            // origin can see it close. rebuild() found any ring before extending into it.
            const walkedAll = parts.flatMap((part) => part.walked[axis])
            const cyclePath = this.cycles[axis]

            const entries: RpcResolvedContextEntry[] = parts.flatMap((part) =>
                (part.tokens.find((held) => held.tokenId === state.token.id)?.entries ?? [])
                    .filter((entry: ContextWireEntry) => entry.axis === axis)
                    .map((entry: ContextWireEntry) => ({ value: entry.value, provider: entry.node, providerVersion: entry.provider }))
            )

            const complete = !waiting && !anyStale
            const keepPrevious = remounted && (state.view.entry || state.view.entries) ? { previous: state.view.entry ?? state.view.entries } : state.view.previous ? { previous: state.view.previous } : {}

            let next: RpcContextSnapshot
            const base = { tokenId: state.token.id, axis, mountEpoch, resolvedAt: Date.now(), transitionReason: reason, ...keepPrevious }
            if (troubled.length || cyclePath || walkedAll.length > MAX_TOTAL_CHAIN) {
                const worst = troubled[0]
                next = {
                    ...base,
                    status: 'invalid',
                    invalidReason: cyclePath ? 'cycle' : walkedAll.length > MAX_TOTAL_CHAIN ? 'depth-exceeded' : worst.status === 'cycle' ? 'cycle' : worst.status,
                    ...(cyclePath ? { invalidPath: cyclePath } : worst?.path ? { invalidPath: worst.path } : {})
                }
            } else if (waiting) {
                next = { ...base, status: 'initializing' }
            } else if (entries.length === 0) {
                // Values from before a provider vanished are not served as current: missing is the
                // complete chain's honest answer, with the last world only in `previous`.
                next = { ...base, status: anyStale ? 'stale' : 'missing', ...(anyStale ? { staleSince: state.view.staleSince ?? Date.now() } : {}) }
            } else {
                const resolution = state.token.resolution ?? 'nearest'
                next = {
                    ...base,
                    status: anyStale ? 'stale' : 'live',
                    ...(anyStale ? { staleSince: state.view.staleSince ?? Date.now() } : {}),
                    ...(resolution === 'nearest' ? { entry: entries[0] } : { entries })
                }
            }
            // Stale keeps the last known values readable: while any hop is stale and no fresh
            // complete picture exists, the previous entries stay in place with their age on them.
            if (next.status === 'stale' && !next.entry && !next.entries && (state.view.entry || state.view.entries)) {
                next = { ...next, ...(state.view.entry ? { entry: state.view.entry } : {}), ...(state.view.entries ? { entries: state.view.entries } : {}) }
            }
            if (complete && next.status === 'live') this.reasons[axis] = undefined

            const changed = JSON.stringify({ ...state.view, resolvedAt: 0 }) !== JSON.stringify({ ...next, resolvedAt: 0 })
            if (changed) {
                state.view = next
                this.notify(state)
            }
        }
    }

    private notify(state: TokenState) {
        for (const listener of [...state.listeners]) {
            try {
                listener()
            } catch {
                // A consumer's render bug is not this chain's failure to report.
            }
        }
    }
}
