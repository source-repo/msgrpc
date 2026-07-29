import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'
import { Message, MessageType } from '../RPC/Core.js'
import {
    RpcCallInstanceMethodPayload,
    RpcErrorCode,
    RpcErrorPayload,
    RpcEventPayload,
    RpcMessage,
    RpcMessageType,
    RpcRemoteError,
    RpcSuccessPayload
} from '../RPC/Messages.js'

/**
 * Mapping between msgrpc messages and the MQTT 5 packet layout described in
 * docs/mqtt5-frame-spec.md.
 *
 * The point is that a peer needs no msgrpc code to take part: where to reply and how to correlate
 * come from the protocol's own Response Topic and Correlation Data, and everything else is a
 * readable user property. Kept separate from the transport so the mapping can be read, and tested,
 * without a broker.
 */

/** Control properties are prefixed so a broker or gateway injecting its own cannot be mistaken for one. */
export const MR = {
    version: 'mr-v',
    source: 'mr-src',
    kind: 'mr-kind',
    path: 'mr-path',
    method: 'mr-method',
    event: 'mr-event',
    code: 'mr-code',
    nonce: 'mr-nonce',
    timestamp: 'mr-ts',
    signature: 'mr-sig',
    contractVersion: 'mr-ver'
} as const

/**
 * Version 2 covers contentType, the error code and the declared contract version in the signature;
 * version 1 did not, and a frame signed under one cannot verify under the other. Bumped rather than
 * negotiated: a receiver that quietly accepted either would let an attacker choose the weaker.
 */
export const FRAME_VERSION = '2'

/** Frame versions this build will accept. A frame announcing anything else is refused, not guessed at. */
export const SUPPORTED_FRAME_VERSIONS = new Set([FRAME_VERSION])

export type FrameKind = 'call' | 'subscribe' | 'unsubscribe' | 'result' | 'error' | 'event'

/** Which per-peer topic a frame belongs on. */
export type Channel = 'req' | 'rsp' | 'evt'

export interface OutboundFrame {
    kind: FrameKind
    channel: Channel
    /** The request id, carried as MQTT correlation data. Absent on events. */
    correlation?: string
    path?: string
    method?: string
    event?: string
    code?: string
    /** Contract version the caller declares, when it has one. */
    version?: string
    /** Encoded as the packet payload: arguments for a request, the value for a result. */
    body: unknown
}

const requestKind = (method: string): FrameKind =>
    method === 'on' ? 'subscribe' : method === 'off' || method === 'removeListener' ? 'unsubscribe' : 'call'

/** Undefined for anything this layout has no representation for, which the transport drops. */
export const toOutboundFrame = (message: Message): OutboundFrame | undefined => {
    const payload = message.payload as RpcMessage | undefined
    if (!payload) return undefined
    switch (payload.type) {
        case RpcMessageType.CallInstanceMethod: {
            const call = payload as RpcCallInstanceMethodPayload
            return {
                kind: requestKind(call.method),
                channel: 'req',
                correlation: call.id,
                path: call.path,
                method: call.method,
                version: call.version,
                body: call.params
            }
        }
        case RpcMessageType.success: {
            const success = payload as RpcSuccessPayload
            return { kind: 'result', channel: 'rsp', correlation: success.id, body: success.result }
        }
        case RpcMessageType.error: {
            const error = payload as RpcErrorPayload
            return { kind: 'error', channel: 'rsp', correlation: error.id, code: error.code, body: error.error }
        }
        case RpcMessageType.event: {
            const event = payload as RpcEventPayload
            return { kind: 'event', channel: 'evt', event: event.event, path: event.path, body: event.params }
        }
        default:
            return undefined
    }
}

export interface InboundFrame {
    kind: string
    correlation?: string
    path?: string
    method?: string
    event?: string
    code?: string
    version?: string
    body: unknown
}

/** Undefined when the frame does not describe anything this RPC layer can dispatch. */
export const fromInboundFrame = (frame: InboundFrame): Message | undefined => {
    switch (frame.kind) {
        case 'call':
        case 'subscribe':
        case 'unsubscribe': {
            if (!frame.correlation || !frame.path || !frame.method) return undefined
            const payload: RpcCallInstanceMethodPayload = {
                type: RpcMessageType.CallInstanceMethod,
                id: frame.correlation,
                path: frame.path,
                method: frame.method,
                version: frame.version,
                // A caller that sends no payload means no arguments.
                params: Array.isArray(frame.body) ? frame.body : frame.body === undefined || frame.body === null ? [] : [frame.body]
            }
            return { type: MessageType.RequestMessage, payload }
        }
        case 'result': {
            if (!frame.correlation) return undefined
            const payload: RpcSuccessPayload = { type: RpcMessageType.success, id: frame.correlation, result: frame.body }
            return { type: MessageType.ResponseMessage, payload }
        }
        case 'error': {
            if (!frame.correlation) return undefined
            const payload: RpcErrorPayload = {
                type: RpcMessageType.error,
                id: frame.correlation,
                code: (frame.code ?? 'Exception') as RpcErrorCode,
                error: frame.body as RpcRemoteError | undefined
            }
            return { type: MessageType.ErrorMessage, payload }
        }
        case 'event': {
            if (!frame.event) return undefined
            const payload: RpcEventPayload = {
                type: RpcMessageType.event,
                event: frame.event,
                path: frame.path,
                params: Array.isArray(frame.body) ? frame.body : [frame.body]
            }
            return { type: MessageType.EventMessage, payload }
        }
        default:
            return undefined
    }
}

export type RawUserProperties = { [key: string]: string | string[] } | undefined

/**
 * Read the control properties, refusing any that appear more than once.
 *
 * MQTT permits a repeated user property, and mqtt.js surfaces repeats as an array. Taking the
 * first or the last would let a sender show one value to a check and a different one to the
 * dispatcher, so a repeat is an ambiguity to refuse rather than resolve.
 */
export const readControlProperties = (properties: RawUserProperties): { values: { [key: string]: string } } | { duplicate: string } => {
    const values: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(properties ?? {})) {
        if (!key.startsWith('mr-')) continue
        if (Array.isArray(value)) return { duplicate: key }
        values[key] = value
    }
    return { values }
}

export const correlationToString = (correlation: Uint8Array | undefined) => (correlation ? uint8ArrayToString(correlation) : undefined)
export const correlationToBytes = (correlation: string | undefined) => (correlation ? stringToUint8Array(correlation) : undefined)
