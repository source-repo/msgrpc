import type { RpcIdentity } from './Auth.js'
import type { RpcEffect } from './Expose.js'

/**
 * What an AI principal is permitted to do on this node.
 *
 * The model is enablement, and the shape follows from that: the point is to allow AI exactly where
 * it is useful, bounded in scope and in time, with the bounds visible. Everything here is
 * **declarative data rather than authorizer code**, for two reasons that are worth stating. A
 * console can render data and cannot render a callback, and a reviewer can diff data and cannot
 * diff a decision made at three in the morning inside somebody's `authorize`. The same argument as
 * the committed contract files, applied to permission.
 *
 * The library enforces this **before `authorize` runs**, so a node whose author wrote no authorizer
 * at all still refuses an AI principal by default. `authorize` remains the fine-grained veto on
 * top: this decides whether the *class* of power is open, and never that a particular call is wise.
 *
 * The ladder, in full, and it reads like a visit to a plant:
 *
 * - **No badge, nothing.** A principal with no credential does not reach a secured bus at all.
 * - **Badged, observation.** A credentialed AI principal may call `observe`-effect methods and
 *   subscribe to events wherever ordinary authorization allows. Diagnosis is where AI earns its
 *   place, and something that can see everything and touch nothing is useful and safe at once.
 * - **Granted, the rungs above.** Writes and programming, each opened by name, on the node that
 *   bears the consequence.
 */

/**
 * The four capability grants, plus the issuance-side one.
 *
 * Two axes: who originates (a tool a person is driving, or a program that tool wrote) times what
 * power (operating the plant, or programming the network). `ai.sponsor` is the fifth and sits on
 * the other side entirely - it governs `security-admin` effect calls, the ones that change who may
 * do any of the above, and is deliberately never one of the four.
 */
export type RpcAiGrant = 'ai.tool.write' | 'ai.tool.program' | 'ai.program.write' | 'ai.program.program' | 'ai.sponsor'

export const AI_GRANTS: readonly RpcAiGrant[] = ['ai.tool.write', 'ai.tool.program', 'ai.program.write', 'ai.program.program', 'ai.sponsor']

/** Provenance as a credential asserts it. Never inferred, never detected - see the AI boundary spec. */
export type RpcAiProvenance = 'ai-tool' | 'ai-program'

/** One open grant: to whom, until when, and how far down a chain of programs. */
export interface RpcAiGrantEntry {
    /**
     * Peer names this is open to. Absent *and* `roles` absent means every AI principal of the
     * matching provenance - which is a real choice somebody made by writing the grant at all, not
     * an accident, since a closed grant is simply not listed.
     */
    to?: string[]
    /** Roles this is open to, for a deployment that grants by role rather than by name. */
    roles?: string[]
    /**
     * When it lapses, as epoch milliseconds. Absent is a standing grant - possible, visible, and
     * deliberately not the ergonomic default: a commissioning afternoon should be a lease somebody
     * renews on purpose rather than configuration archaeology nobody remembers granting.
     */
    expiresAt?: number
    /**
     * How far from a human this may reach. A credential's `generation` is 1 for something a
     * person's tool started, 2 for something that started, and so on; a grant that sets this
     * refuses anything deeper. Unbounded chains are how a program that writes programs stops
     * being reviewable, so bounding it is available without being compulsory.
     */
    maxGeneration?: number
    /** Why this is open, for the audit trail and for whoever reads the file in six months. */
    reason?: string
}

/**
 * The document itself. Schema-versioned and carrying a monotonic revision, because this is a
 * security artifact rather than a settings file: an unsupported version is refused rather than
 * guessed at, and a rollback is visible rather than silent.
 */
export interface RpcAiGrants {
    /** The document's own schema version. Only 1 exists; anything else is refused. */
    grants: 1
    /** Increases with every change. A lower revision arriving later is worth noticing. */
    revision: number
    /** Which capabilities are open. A grant that is absent is closed - that is the whole default. */
    open?: { [grant in RpcAiGrant]?: RpcAiGrantEntry }
}

/**
 * Check a value is a usable grants document, throwing with a reason if it is not.
 *
 * Throwing is the point. A node that starts with an unreadable security policy is exactly the
 * failure this design exists to prevent, and "carry on with nothing granted" would be a quiet
 * answer to a loud problem - the operator meant to grant something, and the thing that reads the
 * file must say so rather than silently disagreeing.
 */
export const validateAiGrants = (value: unknown): RpcAiGrants => {
    const document = value as RpcAiGrants | null
    if (!document || typeof document !== 'object') throw new Error('aiGrants: expected a grants document object')
    if (document.grants !== 1) throw new Error(`aiGrants: unsupported document version ${JSON.stringify(document.grants)} - this library understands version 1`)
    if (typeof document.revision !== 'number' || !Number.isFinite(document.revision)) throw new Error('aiGrants: revision must be a number, so a rollback is visible')
    for (const [grant, entry] of Object.entries(document.open ?? {})) {
        if (!AI_GRANTS.includes(grant as RpcAiGrant)) throw new Error(`aiGrants: '${grant}' is not a grant this library defines - one of ${AI_GRANTS.join(', ')}`)
        if (!entry || typeof entry !== 'object') throw new Error(`aiGrants: '${grant}' must map to an object, even an empty one`)
        if (entry.to && !Array.isArray(entry.to)) throw new Error(`aiGrants: '${grant}'.to must be a list of peer names`)
        if (entry.roles && !Array.isArray(entry.roles)) throw new Error(`aiGrants: '${grant}'.roles must be a list of roles`)
        if (entry.expiresAt !== undefined && typeof entry.expiresAt !== 'number') throw new Error(`aiGrants: '${grant}'.expiresAt must be epoch milliseconds`)
        if (entry.maxGeneration !== undefined && !(typeof entry.maxGeneration === 'number' && entry.maxGeneration >= 1))
            throw new Error(`aiGrants: '${grant}'.maxGeneration must be 1 or more`)
    }
    return document
}

/** What kind of AI principal this is, or undefined for anything that is not one. */
export const aiProvenanceOf = (identity: RpcIdentity | undefined): RpcAiProvenance | undefined => {
    if (identity?.roles?.includes('ai-program')) return 'ai-program'
    if (identity?.roles?.includes('ai-tool')) return 'ai-tool'
    return undefined
}

/**
 * Which grant a call needs, from provenance times effect. Undefined means none is needed, which is
 * only ever true of observation.
 *
 * Note what carries the weight here: `effect` is a declaration on the method, and an undeclared
 * command reads as `operate` rather than as harmless. So "unclassified is denied to AI" is not a
 * separate rule that could be forgotten - it falls out of the defaulting, which is the only way a
 * rule like that survives a growing surface.
 */
export const grantRequiredFor = (provenance: RpcAiProvenance, effect: RpcEffect): RpcAiGrant | undefined => {
    if (effect === 'observe') return undefined
    if (effect === 'security-admin') return 'ai.sponsor'
    if (effect === 'program') return provenance === 'ai-program' ? 'ai.program.program' : 'ai.tool.program'
    return provenance === 'ai-program' ? 'ai.program.write' : 'ai.tool.write'
}

/** Why a call was allowed or refused, in a sentence fit for an audit line and for the caller. */
export interface RpcAiDecision {
    allowed: boolean
    /** The grant that was consulted, when one was needed. */
    grant?: RpcAiGrant
    reason: string
}

export interface RpcAiAccessQuery {
    grants?: RpcAiGrants
    identity?: RpcIdentity
    effect: RpcEffect
    now?: number
}

/**
 * The whole decision, in one pure function so it can be tested without a network and rendered by a
 * console without being re-implemented.
 */
export const decideAiAccess = ({ grants, identity, effect, now = Date.now() }: RpcAiAccessQuery): RpcAiDecision => {
    const provenance = aiProvenanceOf(identity)
    // Not an AI principal: this layer has no opinion, and ordinary authorization decides as always.
    if (!provenance) return { allowed: true, reason: 'not an AI principal' }

    const grant = grantRequiredFor(provenance, effect)
    if (!grant) return { allowed: true, reason: `${provenance} may observe` }

    const entry = grants?.open?.[grant]
    if (!entry) return { allowed: false, grant, reason: `${grant} is not open on this node` }

    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        const ago = Math.round((now - entry.expiresAt) / 1000)
        return { allowed: false, grant, reason: `${grant} lapsed ${ago}s ago` }
    }

    const named = entry.to?.includes(identity?.name ?? '')
    const byRole = entry.roles?.some((role) => identity?.roles?.includes(role))
    // Neither list present means the grant is open to any AI principal of this provenance, which is
    // a deliberate act - a grant nobody wrote is simply absent, and absent is closed.
    const scoped = entry.to !== undefined || entry.roles !== undefined
    if (scoped && !named && !byRole) return { allowed: false, grant, reason: `${grant} is open, but not to ${identity?.name ?? 'this principal'}` }

    if (entry.maxGeneration !== undefined) {
        const generation = typeof identity?.claims?.generation === 'number' ? identity.claims.generation : 1
        if (generation > entry.maxGeneration)
            return { allowed: false, grant, reason: `${grant} permits generation ${entry.maxGeneration} and this principal is generation ${generation}` }
    }

    return { allowed: true, grant, reason: `${grant} is open to ${identity?.name ?? 'this principal'}` }
}

/**
 * Every grant currently open, with what it permits and when it lapses. What the console renders,
 * and what answers "what would this open" before a badge is issued.
 */
export const openAiGrants = (grants: RpcAiGrants | undefined, now = Date.now()) =>
    AI_GRANTS.filter((grant) => {
        const entry = grants?.open?.[grant]
        return !!entry && (entry.expiresAt === undefined || entry.expiresAt > now)
    }).map((grant) => ({ grant, ...(grants!.open![grant] as RpcAiGrantEntry) }))
