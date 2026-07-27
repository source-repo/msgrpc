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
}

export type RpcErrorCode = 'ClassNotFound' | 'MethodNotFound' | 'Exception' | 'Timeout' | 'TransportError' | 'Unauthorized' | 'Forbidden'

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
