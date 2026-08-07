import { sessionNonce } from './pairing.js'

/**
 * The enrolment authority's bookkeeping: which bare nodes are waiting to be claimed.
 *
 * **This holds no secrets and can verify nothing.** The commissioning secret is on the device's
 * label and in the operator's console, and never here - which is the whole reason enrolment proves
 * end-to-end. So the authority cannot decide whether a claim is genuine; it relays the claim to the
 * node, and the node's verdict is what it records. A rendezvous that could authenticate a claim
 * would be a rendezvous that could provision a device on its own.
 *
 * That constraint decides the shape of everything below, including the concurrency rule: "reject an
 * invalid claim without disturbing the session" cannot be enforced here, because invalid is not
 * something this can see.
 */

/** How long a registration waits to be claimed. The window's job is hygiene, not authentication. */
export const DEFAULT_COMMISSIONING_TTL = 300

/** Bounded, because a ttl of a week is a device left open with a number on it. */
const MAX_COMMISSIONING_TTL = 3600

/** What a node publishes about itself while it waits. Nothing here is secret. */
export interface PendingSession {
    /** As the label names it, which is what the operator matches against what they scanned. */
    deviceId: string
    sessionId: string
    /** The node's contribution to the transcript, chosen before it knew who would claim it. */
    nodeNonce: string
    expiresAt: number
    /** Free-form, for a console listing several waiting devices. Never trusted for anything. */
    product?: string
}

/** What the node said about a relayed claim. The authority records this and never decides it. */
export interface ClaimVerdict {
    /** Whether the node accepted the proof. */
    accepted: boolean
    /** The node's own proof back, so the claimant knows it reached the device and not a stand-in. */
    acceptProof?: string
    reason?: string
}

export type ClaimOutcome =
    | { outcome: 'claimed'; acceptProof?: string }
    /** No such session, or it lapsed. Deliberately one answer: which of the two is not the caller's business. */
    | { outcome: 'unknown' }
    /** The node refused the proof. The session survives - a wrong secret is somebody mistyping. */
    | { outcome: 'refused'; reason?: string }
    /** Already completed. A session completes at most once. */
    | { outcome: 'already' }
    /**
     * A second independently valid claim arrived. Both are dropped and the session is destroyed:
     * two parties proved possession of a secret that should have been in one pair of hands, and
     * carrying on would mean picking one of them arbitrarily.
     */
    | { outcome: 'contested' }

interface Held extends PendingSession {
    /** Set the moment a claim is accepted, so a second accepted claim is detectable rather than a race. */
    claimed?: boolean
}

export class PendingRegistry {
    private readonly sessions = new Map<string, Held>()

    constructor(private readonly now: () => number = Date.now) {}

    /**
     * A bare node announces itself and waits.
     *
     * The session id is generated here rather than taken from the node, so a node cannot choose one
     * that collides with another device's - which would let it be handed a claim meant for that one.
     */
    register(request: { deviceId: string; nodeNonce: string; ttl?: number; product?: string }): PendingSession {
        const ttl = Math.min(Math.max(request.ttl ?? DEFAULT_COMMISSIONING_TTL, 1), MAX_COMMISSIONING_TTL)
        const session: Held = {
            deviceId: request.deviceId,
            sessionId: sessionNonce(),
            nodeNonce: request.nodeNonce,
            expiresAt: this.now() + ttl * 1000,
            ...(request.product ? { product: request.product } : {})
        }
        this.sessions.set(session.sessionId, session)
        return { ...session }
    }

    /** What a console lists. Lapsed sessions are swept here rather than by a timer nobody owns. */
    pending(): PendingSession[] {
        this.sweep()
        return [...this.sessions.values()].filter((session) => !session.claimed).map(({ claimed: _claimed, ...session }) => session)
    }

    private sweep() {
        const now = this.now()
        for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id)
    }

    /**
     * Relay a claim to the node and record what it said.
     *
     * `askNode` is how the verdict is reached somewhere this code cannot see, and injecting it is
     * what keeps this class honest: there is no path here that could accept a claim on the node's
     * behalf, because there is nothing here to accept it with.
     */
    async claim(sessionId: string, askNode: (session: PendingSession) => Promise<ClaimVerdict>): Promise<ClaimOutcome> {
        this.sweep()
        const session = this.sessions.get(sessionId)
        if (!session) return { outcome: 'unknown' }
        if (session.claimed) return { outcome: 'already' }

        const { claimed: _claimed, ...offered } = session
        const verdict = await askNode(offered)
        if (!verdict.accepted) return { outcome: 'refused', ...(verdict.reason ? { reason: verdict.reason } : {}) }

        // Re-read after the await: a second claim may have been accepted while this one was with the
        // node. Two parties holding a secret meant for one is not something to resolve by ordering,
        // so the session goes and the operator has to open commissioning again deliberately.
        const current = this.sessions.get(sessionId)
        if (!current) return { outcome: 'unknown' }
        if (current.claimed) {
            this.sessions.delete(sessionId)
            return { outcome: 'contested' }
        }
        current.claimed = true
        return { outcome: 'claimed', ...(verdict.acceptProof ? { acceptProof: verdict.acceptProof } : {}) }
    }

    /** Once the node has persisted its identity there is nothing left to claim. */
    release(sessionId: string) {
        this.sessions.delete(sessionId)
    }

    get size() {
        this.sweep()
        return this.sessions.size
    }
}
