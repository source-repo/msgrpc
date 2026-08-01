import { RpcIdentity } from '../RPC/Auth.js'

/**
 * Presence over socket.io.
 *
 * MQTT gets discovery for free: every peer publishes retained presence, so a newcomer subscribing
 * to <prefix>/presence/+ is handed everyone already online. socket.io has no equivalent - a server
 * learned a peer's name only from the header of a frame it sent, so a peer that only listens was
 * never known to exist and could not be addressed at all.
 *
 * These are the two messages that close that gap, carried on their own socket.io event rather than
 * inside the RPC framing, so nothing about the frame format changes and a peer that ignores them
 * still works as before.
 */

/** Sent by a connecting peer to say who it is, and repeated whenever either field changes. */
export interface PresenceAnnouncement {
    name: string
    /**
     * Peers reachable *through* the announcer. This is what makes a network deeper than a star
     * work: a cell controller serving its own panels and joining a plant bus advertises the panels,
     * and the bus can then route to them without knowing they are one hop further away.
     *
     * Never includes anything learned from the link it is sent on - advertising a peer back the way
     * it came is how two hubs end up each believing the other is the way to it.
     */
    carrying?: string[]
}

/**
 * Sent by the server: the full list when a peer announces itself, and a single change afterwards.
 * The snapshot is what stands in for MQTT's retained state.
 */
export interface PresenceUpdate {
    peers?: string[]
    peer?: string
    state?: 'online' | 'offline'
}

export const PRESENCE_EVENT = 'presence'

/**
 * A peer name arrives from the network, so it is checked before anything is keyed by it. Length,
 * because it ends up in a map, in logs and in the console's peer list. Control characters because
 * NUL separates the parts of a subscription key - a name carrying one could forge a key belonging
 * to another peer. Spaces because a name that cannot be read back out of a log is not a name.
 */
export const MAX_PEER_NAME_LENGTH = 128

/**
 * How many times a frame may be forwarded before it is dropped. Split horizon keeps the tables
 * loop-free in a tree, but a mesh with a failed link can still form a cycle for as long as it takes
 * the tables to settle, and a frame going round it forever is the one failure that takes a bus down.
 */
export const MAX_RELAY_HOPS = 8

/** Peers one link says it can reach, bounded so a neighbour cannot flood this one's tables. */
export const MAX_CARRIED_PEERS = 1000

export const isUsablePeerName = (name: unknown): name is string =>
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_PEER_NAME_LENGTH &&
    ![...name].some((character) => character === ' ' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)

/** What a relay decision gets to look at. One frame, about to be forwarded to another peer. */
export interface RelayContext {
    /** The peer the frame came from, as its connection is known to this server. */
    source: string
    /** The peer it is addressed to. */
    target: string
    /** What the sending connection authenticated as, when the server authenticates. */
    identity?: RpcIdentity
}

/**
 * Whether to forward. `true` relays for every peer, `false` for none, and a predicate decides per
 * connection - which is usually what a hub wants, since "may this peer reach that one" is rarely
 * the same answer for everybody.
 */
export type RelayRule = boolean | ((context: RelayContext) => boolean)

/**
 * Wait for every transport's first presence sweep, bounded.
 *
 * Probed by capability rather than declared on the transport interface, because most transports
 * have no sweep to wait for: a listening socket.io server learns peers as they dial in, so there
 * is nothing to settle and it resolves at once. The bound resolves rather than throws - a sweep
 * that never lands leaves the caller with whatever arrived, which is more useful than an error
 * and honest so long as the caller knows settled is best-effort. It is unref'd, so a process
 * whose work finished during the wait is not held open by it.
 */
export const settledAfterSweeps = async (transports: unknown[], waitMs: number) => {
    const sweeps = transports.map((transport) => (transport as { presenceSettled?: () => Promise<void> }).presenceSettled?.() ?? Promise.resolve())
    let bound: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
        Promise.all(sweeps).then(() => undefined),
        new Promise<void>((resolve) => {
            bound = setTimeout(resolve, waitMs)
            ;(bound as unknown as { unref?: () => void }).unref?.()
        })
    ])
    if (bound !== undefined) clearTimeout(bound)
}
