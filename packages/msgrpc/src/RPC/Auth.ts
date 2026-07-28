/**
 * Authentication and authorization types.
 *
 * Authentication happens at the transport, because that is the only layer that can tie a claim to
 * a connection. The source field of a message header is supplied by the sender and is not evidence
 * of anything on its own - a transport that authenticates must therefore pin each connection to
 * one peer name and reject frames that claim a different one. Otherwise any authenticated peer
 * could address messages as any other peer and inherit its rights.
 *
 * Authorization happens at the RPC layer, which is where a call is resolved to an instance and a
 * method.
 */

/** An authenticated peer. */
export interface RpcIdentity {
    /**
     * The peer name this identity may use as its message source. Frames claiming any other source
     * are dropped, so an RpcClient's `name` option must match this when authentication is on.
     */
    name: string
    roles?: string[]
    claims?: { [key: string]: unknown }
}

/** What a transport knows about a peer trying to connect. */
export interface RpcConnectionInfo {
    /** Remote address, when the transport can determine one. Useful for allow-lists and audit. */
    address?: string
}

/**
 * Verify credentials presented at connection time. Return the identity to accept the peer, or
 * undefined to reject it. Throwing also rejects.
 */
export type RpcAuthenticator = (credentials: unknown, info: RpcConnectionInfo) => RpcIdentity | undefined | Promise<RpcIdentity | undefined>

/** Everything known about a call at the point the decision is made. */
export interface RpcCallContext {
    /**
     * The authenticated caller, when the transport it arrived on authenticates. Undefined for
     * transports that cannot authenticate, such as MQTT, where trust comes from the broker.
     */
    identity?: RpcIdentity
    /** Peer name the message claims as its source, and the address replies are sent to. */
    source: string
    /** Name the target instance is exposed under. */
    instanceName: string
    method: string
    params: unknown[]
    /** True when the call is an event subscription rather than a method call. */
    subscription: boolean
}

/** Return false to reject a call with a Forbidden error. */
export type RpcAuthorizer = (context: RpcCallContext) => boolean | Promise<boolean>

/**
 * The parts of a frame a signature covers. Everything that decides where a message came from,
 * where it is going and what it says, plus a nonce so a captured frame cannot be replayed.
 *
 * Both sides build these bytes the same way from the same fields, so there is no parsing
 * ambiguity: see canonicalSignedBytes in Signing.ts for the exact encoding.
 */
export interface SignedFrame {
    source: string
    target: string
    time: number
    seq: number
    nonce: string
    payload: Uint8Array
}

/** What a signer knows about the frame beyond the bytes it is signing. */
export interface SigningContext {
    /** Peer that claims to have sent the frame. Selects which key to sign or verify with. */
    source: string
}

/**
 * Produce a base64 signature over already-canonicalised bytes.
 *
 * Signers take bytes rather than a frame so one signer works across wire formats: the v1 header
 * and the MQTT 5 property layout canonicalise different fields, and only the transport knows which
 * it is speaking.
 */
export type MessageSigner = (canonicalBytes: Uint8Array, context: SigningContext) => string | Promise<string>

/**
 * Check a signature over canonicalised bytes. Return the sender's identity to accept the frame,
 * undefined to reject it.
 *
 * The returned identity's `name` must equal the frame's source; a transport rejects the frame
 * otherwise, so a peer holding one key cannot sign messages claiming to come from another.
 */
export type MessageVerifier = (
    canonicalBytes: Uint8Array,
    signature: string,
    context: SigningContext
) => RpcIdentity | undefined | Promise<RpcIdentity | undefined>
