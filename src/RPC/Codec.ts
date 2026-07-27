import { encode as msgPackEncode, decode as msgPackDecode } from '@msgpack/msgpack'
import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'

/**
 * Turns a message into the bytes a transport puts on the wire, and back again.
 *
 * Encoding belongs to the transport rather than to a module in the chain. A transport whose wire
 * format is structured - MQTT 5 carries the method, the correlation and the reply address as
 * packet properties - needs to see the message, and a converter sitting above it would already
 * have flattened it to an opaque blob.
 */
export interface FrameCodec {
    /** MIME type for wire formats that can announce one, such as MQTT 5's contentType. */
    readonly contentType: string
    encode(message: unknown): Uint8Array
    decode(bytes: Uint8Array): unknown
}

/**
 * The default. Sits between JSON and protobuf on size and parse cost without a schema toolchain,
 * encodes Uint8Array natively, and has small allocation-light implementations for constrained
 * targets.
 */
export const msgPackCodec: FrameCodec = {
    contentType: 'application/msgpack',
    // ignoreUndefined keeps JSON's behaviour of dropping undefined object properties.
    encode: (message) => msgPackEncode(message, { ignoreUndefined: true }),
    decode: (bytes) => msgPackDecode(bytes)
}

/** Larger and lossy for binary, but readable in any tool and implementable anywhere. */
export const jsonCodec: FrameCodec = {
    contentType: 'application/json',
    encode: (message) => stringToUint8Array(JSON.stringify(message)),
    decode: (bytes) => JSON.parse(uint8ArrayToString(bytes))
}

export const codecFor = (useMsgPack: boolean) => (useMsgPack ? msgPackCodec : jsonCodec)
