import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { HOST_ROOT, type HostTopology, type RpcRef, type RpcTopologyRecord } from './Topology.js'

/**
 * Structural context: inherited, cached, versioned ambient data, resolved through exactly one
 * declared topology axis. The model the adoption record fixed: context normally carries *refs to
 * authorities*, not live values - high-rate data stays in component state - and shared mutable
 * state stays in an authoritative component. What this layer moves is the least dynamic data in
 * the system, which is why it shipped last.
 *
 * **Authorization, written before implementation, per the rigidity clause.** The `$context`
 * service's `read` and `subscribe` pass through the server's ordinary authorize() with the node
 * and every requested token id visible in params - caller identity, target and token are all on
 * the table where a plant's policy can rule on them. There is no enumeration surface: a caller
 * must already know a token's id, because listing what ambient data exists is reconnaissance of a
 * sharper kind than listing methods. A token whose provider declares `exposure: 'local'` is
 * filtered from every remote answer *silently* - a refusal would confirm the secret exists.
 * Nothing here grants anything: a resolved ref to an authority is a fact about the plant, and
 * whether the caller may act on it stays authorize()'s question at that authority.
 */

export type RpcContextAxis = 'physical' | 'logical'
export type RpcContextResolution = 'nearest' | 'collect'

export interface RpcContextDefinition<TValue> {
    /** Globally stable, namespaced - `acme.plant`, never a bare word. An id: control chars refused. */
    id: string
    schemaVersion: string
    /** Exactly one axis. There is no logical-first-then-physical search, by design. */
    axis: RpcContextAxis
    /** `nearest` (the default) stops at the first provider; `collect` gathers the whole chain. */
    resolution?: RpcContextResolution
    /** What require() does with a stale value: `allow` (default) returns it, `reject` throws. */
    stalePolicy?: 'allow' | 'reject'
    /** Only `explicit` tokens may be captured into a payload. Default `never`: staying is safer. */
    capture?: 'never' | 'explicit'
    /** `local` values never appear in a remote snapshot. Default `remote`: context exists to travel. */
    exposure?: 'local' | 'remote'
    /** Serialized-size bound per value, checked before acceptance. */
    maxSerializedBytes?: number
    /** TypeScript-only phantom, so a token knows its value type. */
    __value?: TValue
}

export type RpcContextToken<TValue = unknown> = Readonly<RpcContextDefinition<TValue>>

// eslint-disable-next-line no-control-regex -- matching control characters is this regex's entire job
const CONTROL = /[\u0000-\u001f\u007f]/

export const defineRpcContext = <TValue>(definition: RpcContextDefinition<TValue>): RpcContextToken<TValue> => {
    if (!definition.id || CONTROL.test(definition.id)) throw new Error(`defineRpcContext: '${definition.id}' is not a usable token id`)
    if (!definition.id.includes('.')) throw new Error(`defineRpcContext: '${definition.id}' has no namespace - a token id is globally stable, like 'acme.plant'`)
    if (!definition.schemaVersion) throw new Error(`defineRpcContext: ${definition.id} declares no schemaVersion`)
    return Object.freeze({ ...definition })
}

/** Per-value default: a context value is ambient configuration, not a payload. */
const DEFAULT_VALUE_BYTES = 16 * 1024
/** Aggregate bound for one captured context, checked before it is accepted into anything. */
const CAPTURE_TOTAL_BYTES = 64 * 1024
/** A chain deeper than this is a resource question; a visited set answers the cycle question. */
const MAX_CHAIN = 128

const estimateBytes = (value: unknown) => {
    const text = JSON.stringify(value)
    return text === undefined ? 8 : text.length
}

// ---------------------------------------------------------------------------- wire shapes

export interface ContextWireEntry {
    node: RpcRef
    axis: RpcContextAxis
    value: unknown
    provider: { epoch: string; revision: number }
}

export interface ContextWireToken {
    tokenId: string
    /** Nearest-first along this host's part of the chain. The requester applies nearest/collect. */
    entries: ContextWireEntry[]
}

export interface ContextWireTrouble {
    axis: RpcContextAxis
    status: 'invalid-reference' | 'cycle' | 'depth-exceeded'
    at?: RpcRef
    path?: RpcRef[]
}

/**
 * One host's whole answer for one node: both chains walked as far as they stay local, the refs in
 * order, where each axis continues on another host, and every requested token's local providers.
 * Always the full picture - full snapshots are what make duplicate delivery and reconnect replay
 * harmless, and a patch chain is one lost frame away from a corrupt cache.
 */
export interface ContextWireSnapshot {
    node: RpcRef
    walked: { physical: RpcRef[]; logical: RpcRef[] }
    continues: { physical?: RpcRef; logical?: RpcRef }
    trouble: ContextWireTrouble[]
    /** The chain's identity per axis: the topology epochs joined. A remount is a changed key. */
    chainKey: { physical: string; logical: string }
    tokens: ContextWireToken[]
    seq: number
}

// ---------------------------------------------------------------------------- providers

interface ProviderEntry {
    token: RpcContextToken
    value: unknown
    epoch: string
    revision: number
}

export interface RpcContextProviderHandle<TValue> {
    set(value: TValue): void
    clear(): void
}

/**
 * The host side: provider tables keyed by topology node, local chain resolution, and the
 * subscription registry the `$context` service pushes through. One instance per server, beside
 * HostTopology, whose records are what the chains walk.
 */
export class HostContext extends EventEmitter {
    /** Key `${instance}\u0000${tokenId}` - NUL because neither part can contain it. Escaped, never the byte. */
    private readonly providers = new Map<string, ProviderEntry>()
    private readonly subscriptions = new Map<string, { source: string; subscriptionId: string; node: string; tokenIds: string[]; seq: number; queued: boolean }>()
    /** Installed by the server: how a recomputed snapshot reaches one subscriber, targeted. */
    push?: (source: string, frame: { subscriptionId: string; snapshot: ContextWireSnapshot }) => void

    constructor(private readonly topology: HostTopology) {
        super()
    }

    private key(instance: string, tokenId: string) {
        return `${instance}\u0000${tokenId}`
    }

    /**
     * Provide one value for one token at one node. At most one provider per pair - a second
     * provide() is refused rather than silently replacing a value somebody else owns. The handle
     * is ownership: set() and clear() are the owner's, and nothing remote can reach either.
     */
    provide<TValue>(instance: string, token: RpcContextToken<TValue>, initialValue: TValue): RpcContextProviderHandle<TValue> {
        const key = this.key(instance, token.id)
        if (this.providers.has(key)) throw new Error(`context: ${instance} already provides ${token.id} - one provider owns one value`)
        const bound = token.maxSerializedBytes ?? DEFAULT_VALUE_BYTES
        const checked = (value: TValue) => {
            const size = estimateBytes(value)
            if (size > bound) throw new Error(`context: a ${token.id} value of ${size} bytes exceeds its ${bound} byte bound - context is ambient data, not a payload`)
            return value
        }
        // A fresh epoch per registration: a restarted provider is a new world, and a consumer
        // comparing provider versions must never see the new world continue the old one's count.
        const entry: ProviderEntry = { token: token as RpcContextToken, value: checked(initialValue), epoch: uuidv4(), revision: 0 }
        this.providers.set(key, entry)
        this.changed()
        return {
            set: (value: TValue) => {
                entry.value = checked(value)
                entry.revision++
                this.changed()
            },
            clear: () => {
                if (this.providers.get(key) === entry) {
                    this.providers.delete(key)
                    this.changed()
                }
            }
        }
    }

    /** The topology moved or a provider changed: recompute every subscription, coalesced. */
    changed() {
        for (const [id, held] of this.subscriptions) {
            if (held.queued) continue
            held.queued = true
            // Microtask-coalesced, and the snapshot is computed at fire time: several changes in
            // one turn cost one push, and a slow subscriber holds at most one pending snapshot.
            queueMicrotask(() => {
                held.queued = false
                if (!this.subscriptions.has(id)) return
                held.seq++
                // The subscriber's own id, never this map's composite key: the far end matches
                // frames against the id it chose, and a frame carrying anything else is noise.
                this.push?.(held.source, { subscriptionId: held.subscriptionId, snapshot: this.snapshotFor(held.node, held.tokenIds, held.seq, true) })
            })
        }
        this.emit('contextChanged')
    }

    private walk(node: string, axis: RpcContextAxis): { refs: RpcRef[]; continues?: RpcRef; trouble?: ContextWireTrouble } {
        const refs: RpcRef[] = []
        const visited = new Set<string>()
        let at: string | undefined = node
        for (let depth = 0; depth <= MAX_CHAIN; depth++) {
            if (at === undefined) return { refs }
            if (visited.has(at)) return { refs, trouble: { axis, status: 'cycle', path: refs.slice(refs.findIndex((ref) => ref.instance === at)) } }
            visited.add(at)
            const record: RpcTopologyRecord | undefined = this.topology.get(at)
            if (!record) return { refs, trouble: { axis, status: 'invalid-reference', at: { peer: this.topology.peer, instance: at } } }
            refs.push(record.ref)
            const next = axis === 'physical' ? record.parent : record.owner
            if (next === null) return { refs }
            if (next.peer !== this.topology.peer) return { refs, continues: next }
            at = next.instance
        }
        return { refs, trouble: { axis, status: 'depth-exceeded' } }
    }

    private chainKeyOf(refs: RpcRef[], axis: RpcContextAxis) {
        // The epochs of the links actually walked: a reparent or a reassignment anywhere along the
        // chain changes the key, which is what tells a resolver its mount is no longer this one.
        return refs.map((ref) => {
            const record = this.topology.get(ref.instance)
            return record ? (axis === 'physical' ? record.parentEpoch : record.ownerEpoch) : 'missing'
        }).join('\u0000')
    }

    /**
     * The full local answer. Exposure is enforced here and silently: a remote caller's snapshot
     * simply does not contain what a local-only provider holds, because refusing by name would
     * confirm the secret exists.
     */
    snapshotFor(node: string, tokenIds: string[], seq: number, remote: boolean): ContextWireSnapshot {
        const physical = this.walk(node, 'physical')
        const logical = this.walk(node, 'logical')
        const trouble = [...(physical.trouble ? [physical.trouble] : []), ...(logical.trouble ? [logical.trouble] : [])]
        const tokens: ContextWireToken[] = tokenIds.map((tokenId) => {
            const entries: ContextWireEntry[] = []
            // A token's axis is declared where it is provided, so each chain accepts only the
            // providers that declared it - which is the whole of "never inspect the other axis".
            for (const [axis, walked] of [['physical', physical.refs] as const, ['logical', logical.refs] as const]) {
                for (const ref of walked) {
                    const held = this.providers.get(this.key(ref.instance, tokenId))
                    if (!held || held.token.axis !== axis) continue
                    if (remote && (held.token.exposure ?? 'remote') === 'local') continue
                    entries.push({ node: ref, axis, value: held.value, provider: { epoch: held.epoch, revision: held.revision } })
                }
            }
            return { tokenId, entries }
        })
        return {
            node: this.topology.ref(node),
            walked: { physical: physical.refs, logical: logical.refs },
            continues: { ...(physical.continues ? { physical: physical.continues } : {}), ...(logical.continues ? { logical: logical.continues } : {}) },
            trouble,
            chainKey: { physical: this.chainKeyOf(physical.refs, 'physical'), logical: this.chainKeyOf(logical.refs, 'logical') },
            tokens,
            seq
        }
    }

    /** Register-then-snapshot: the subscriber exists before its first answer is computed, so an update cannot fall between them. */
    subscribe(source: string, subscriptionId: string, node: string, tokenIds: string[]): ContextWireSnapshot {
        const id = `${source}\u0000${subscriptionId}`
        const existing = this.subscriptions.get(id)
        const seq = existing ? ++existing.seq : 0
        this.subscriptions.set(id, { source, subscriptionId, node, tokenIds, seq, queued: false })
        return this.snapshotFor(node, tokenIds, seq, true)
    }

    unsubscribe(source: string, subscriptionId: string) {
        this.subscriptions.delete(`${source}\u0000${subscriptionId}`)
    }

    /** A departed peer takes its subscriptions with it; nobody pushes to an empty chair. */
    dropSubscriber(source: string) {
        for (const [id, held] of this.subscriptions) if (held.source === source) this.subscriptions.delete(id)
    }

    get subscriptionCount() {
        return this.subscriptions.size
    }
}

/**
 * The reserved names the context protocol travels under. `$` marks them the library's, like
 * `$with` and `$snapshot`. The three methods - read, subscribe, unsubscribe - are dispatched at
 * the protocol level rather than through an exposed class, for the same reason `$acquire` is:
 * subscribe needs the caller's transport-vouched identity to deliver to, and methods never see
 * their caller. authorize() still rules on every call, with node and token ids in params.
 */
export const contextNamespace = '$context'
export const contextEvent = '$context'

// ---------------------------------------------------------------------------- capture

export interface RpcCapturedContextEntry {
    tokenId: string
    schemaVersion: string
    axis: RpcContextAxis
    provider: RpcRef
    providerVersion: { epoch: string; revision: number }
    mountEpoch: string
    value: unknown
}

export interface RpcCapturedContext {
    source: RpcRef
    entries: RpcCapturedContextEntry[]
}

/**
 * Deliberate capture only: a token must declare `capture: 'explicit'` to leave its chain inside a
 * payload, local-only tokens never leave at all, and the aggregate is size-bounded before
 * anything accepts it. Captured context is evidence - what the caller saw when it decided -
 * never authorization.
 */
export const captureRpcContext = (source: RpcRef, resolved: { token: RpcContextToken; entry?: RpcCapturedContextEntry }[]): RpcCapturedContext => {
    const entries: RpcCapturedContextEntry[] = []
    for (const { token, entry } of resolved) {
        if ((token.capture ?? 'never') !== 'explicit') throw new Error(`context: ${token.id} declares capture '${token.capture ?? 'never'}', so it stays on its chain`)
        if ((token.exposure ?? 'remote') === 'local') throw new Error(`context: ${token.id} is local-only, and a capture is precisely a value leaving the host`)
        if (entry) entries.push(entry)
    }
    const total = entries.reduce((sum, entry) => sum + estimateBytes(entry.value), 0)
    if (total > CAPTURE_TOTAL_BYTES) throw new Error(`context: a capture of ${total} bytes exceeds the ${CAPTURE_TOTAL_BYTES} byte bound`)
    return { source, entries }
}

export { HOST_ROOT }
