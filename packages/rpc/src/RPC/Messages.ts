import { Payload } from './Core.js'

/**
 * The RPC message vocabulary, in a module of its own because both the handlers and the transports
 * need it. A transport whose wire format is structured - MQTT 5 carries the method, correlation
 * and reply address as packet properties - has to know what a call, a result, an error and an
 * event are in order to map them.
 */

export enum RpcMessageType {
    CallInstanceMethod = 'POST',
    success = 'SUCCESS',
    error = 'ERROR',
    event = 'EVENT'
}

export interface RpcMessage extends Payload {
    type: RpcMessageType
}

export interface RpcCallInstanceMethodPayload extends RpcMessage {
    id: string
    path: string
    method: string
    params: unknown[]
    /**
     * Contract version the caller was built against, when it has a schema. The server compares it
     * with the version it serves and refuses only when the two are structurally incompatible.
     */
    version?: string
    /**
     * How many milliseconds the caller will still be waiting, measured when it sent this. A server
     * that finds the budget spent answers `Timeout` instead of running the method.
     *
     * A duration, not a moment. An absolute deadline would be exact if every peer agreed on the
     * time, and one of the peers here is a browser page whose clock belongs to whoever is sitting
     * at it - so a wrong clock would refuse every command it sent, which is a worse failure than
     * the one this prevents. The receiver stamps arrival by its own clock and counts from there,
     * and on MQTT 5 the broker's own expiry accounts for the part of the journey it queued.
     */
    ttl?: number
    /**
     * Names the command this call *is*, as opposed to `id`, which names this attempt at it.
     *
     * Two attempts at one command carry one key, which is what lets a server with a durable
     * idempotency store answer the second from the first's outcome instead of running it again.
     * Absent means the request id is the key, which still covers a redelivery of the same packet
     * but not an operator pressing the button a second time - those are different attempts.
     */
    idempotencyKey?: string
}

export type RpcErrorCode =
    | 'ClassNotFound'
    | 'MethodNotFound'
    | 'Exception'
    | 'Timeout'
    | 'TransportError'
    | 'Unauthorized'
    | 'Forbidden'
    | 'InvalidParams'
    | 'IncompatibleVersion'
    /**
     * The call was sent and its outcome is not known: it may have run, it may not, and nothing here
     * can tell which.
     *
     * Distinct from `TransportError`, which is the honest answer when a request never left - a
     * failed encode, a closed link, a broker that refused the publish. The difference is the whole
     * point. "It failed" invites a retry; "I do not know" says to go and look, and for a
     * non-repeatable command that distinction is the difference between one pump start and two.
     */
    | 'UnknownOutcome'
    /**
     * The instance's mailbox is full, so the call was refused before it could queue. It certainly
     * did not run, and retrying later is reasonable - unlike `Superseded`, where it is not.
     */
    | 'Busy'
    /**
     * A newer call to the same conflatable method replaced this one while it waited. It certainly
     * did not run, and it should not be retried: the newer value won, which is what the method
     * opted into by declaring `conflate`.
     */
    | 'Superseded'

/**
 * What a method does to the world, which decides what a caller may do about an uncertain answer.
 *
 * Most RPC systems make it easy to call a function and leave this to prose. On a plant it is the
 * distinction that matters: retrying a read costs a round trip, and retrying a start costs a second
 * start.
 *
 * - `query` changes nothing, so it can be repeated at will.
 * - `idempotent-command` changes something, but arriving twice leaves the same state as arriving
 *   once - `setSetpoint(1200)`, `close()`, anything that assigns rather than accumulates.
 * - `non-repeatable-command` must not be sent again on an uncertain answer, because a second
 *   arrival is a second effect - `dispense()`, `advanceBatch()`, `resetTotaliser()`.
 *
 * Undeclared means undeclared. The library will not guess a method is safe to repeat, and will not
 * pretend a read is dangerous either; what it does instead is refuse to *silently* do anything that
 * depends on knowing.
 */
export type RpcMethodSemantics = 'query' | 'idempotent-command' | 'non-repeatable-command'

/** Increasing order of what a repeat costs, so a contract change can be judged against it. */
export const SEMANTICS_RISK: { [semantics in RpcMethodSemantics]: number } = {
    query: 0,
    'idempotent-command': 1,
    'non-repeatable-command': 2
}

/**
 * A remote error flattened into something that survives MsgPack/JSON encoding.
 * An Error instance keeps `message` and `stack` on non-enumerable properties, so encoding one
 * directly yields an empty object - it has to be copied onto a plain object first.
 */
export interface RpcRemoteError {
    name: string
    message: string
    stack?: string
}

export const toRemoteError = (e: unknown): RpcRemoteError => {
    if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack }
    if (e && typeof e === 'object') {
        const candidate = e as { name?: unknown; message?: unknown }
        if (typeof candidate.message === 'string')
            return { name: typeof candidate.name === 'string' ? candidate.name : 'Error', message: candidate.message }
    }
    return { name: 'Error', message: String(e) }
}

export interface RpcErrorPayload extends RpcMessage {
    /** Id of the originating request, so the caller's pending promise can be settled. */
    id: string
    code: RpcErrorCode
    error?: RpcRemoteError
}
export interface RpcSuccessPayload extends RpcMessage {
    id: string
    result: unknown
}
export interface RpcEventPayload extends RpcMessage {
    event: string
    params: unknown[]
    /** Instance the event came from. Lets a wire format name the emitter, as MQTT 5 does. */
    path?: string
}
