import { base64ToUint8Array, stringToUint8Array, uint8ArrayToBase64 } from 'uint8array-extras'
import { MessageSigner, MessageVerifier, RpcIdentity, SignedFrame } from './Auth.js'

/**
 * Frame signing, for transports that cannot authenticate a connection.
 *
 * MQTT peers connect to a broker, not to each other, so a receiver has no connection to attribute
 * a message to and the source field is only a claim. Signing each frame makes the claim checkable
 * without trusting the broker: a broker operator, or any peer whose ACLs let it publish to another
 * peer's topic, still cannot forge a message from someone else.
 *
 * Built on WebCrypto, which is present in Node and in browsers, so the same code signs on both.
 */

const subtle = () => {
    const available = globalThis.crypto?.subtle
    if (!available) throw new Error('source-rpc signing needs WebCrypto (globalThis.crypto.subtle)')
    return available
}

const toBytes = (value: Uint8Array | string) => (typeof value === 'string' ? stringToUint8Array(value) : value)

/**
 * WebCrypto takes a BufferSource, which recent typings narrow to views over a plain ArrayBuffer.
 * A Uint8Array may sit on a SharedArrayBuffer, so copying is what makes the type honest rather
 * than asserted away. The cost is trivial next to the hashing that follows.
 */
const bufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

/**
 * The exact bytes a signature covers: a JSON array of the header fields, followed by the payload.
 *
 * A JSON array fixes the field order and escapes the values, so no combination of names can be
 * made to look like a different frame. The verifier rebuilds the preamble from the fields it
 * parsed, so it knows where the payload begins without needing a length prefix.
 */
export const canonicalSignedBytes = (frame: SignedFrame): Uint8Array => {
    const preamble = stringToUint8Array(JSON.stringify([frame.source, frame.target, frame.time, frame.seq, frame.nonce]))
    const result = new Uint8Array(preamble.length + frame.payload.length)
    result.set(preamble, 0)
    result.set(frame.payload, preamble.length)
    return result
}

/** Fields the MQTT 5 layout covers. Signed positionally by value, so property naming never enters
 *  the canonical form and renaming one later cannot silently change what verifies. */
export interface SignedFrameV5 {
    version: string
    topic: string
    /**
     * Where the sender asks for its reply, empty when it asks for none. Signed because it is
     * honoured: a receiver publishes the answer where this says, so anything able to rewrite it
     * could have a server deliver a reply to a topic of its choosing.
     */
    responseTopic: string
    source: string
    kind: string
    path: string
    methodOrEvent: string
    correlation: string
    /**
     * How the payload is to be read. Signed, for the reason set out below - it was left out of
     * frame version 1 on reasoning that turned out to be wrong.
     */
    contentType: string
    /** The RPC error code on a failure frame, which is what the caller acts on. */
    code: string
    /** The contract version the sender declares, which decides compatibility at the far end. */
    contractVersion: string
    /**
     * Milliseconds the caller said it would still wait, as a string, empty when it said nothing.
     *
     * A duration rather than a moment, deliberately: an absolute deadline is only as good as the
     * agreement between two clocks, and one of the peers here is a browser, whose clock the user
     * owns. The receiver turns it into a local deadline on arrival, so nobody's clock has to match
     * anybody else's. See RpcServerHandler for what is done with it.
     */
    ttl: string
    timestamp: number
    nonce: string
    payload: Uint8Array
}

/**
 * The MQTT 5 canonical form. The topic is signed rather than a target field, because under this
 * layout the topic is what carries the addressing.
 *
 * Frame version 1 deliberately left contentType out, on the reasoning that it only says how to read
 * bytes that are themselves covered - so altering it could make the payload fail to parse but never
 * change what was authorised. **That reasoning is wrong**, and the counterexample is one byte long:
 * `0x31` decodes as the JSON text `"1"`, which is the number 1, and as a MsgPack positive fixint,
 * which is the number 49. Both parse. Both verify. Flipping one unsigned property therefore changed
 * a signed setpoint from 1 to 49 with the signature still good.
 *
 * The same argument applies to anything else the receiver acts on rather than merely transports: the
 * error code decides what a caller does about a failure, the declared contract version decides
 * whether the call is accepted at all, the response topic decides where the answer is published, and
 * the ttl decides whether the method runs at all. All four are covered.
 *
 * The MQTT message expiry is deliberately **not** covered, because the broker is meant to decrement
 * it in flight and a signature over it would break on the first queued message. Nothing is lost:
 * expiry may only narrow the signed ttl, never extend it, so rewriting it can delay or drop a frame
 * - which anyone able to rewrite it could do anyway - but cannot buy a stale command more time.
 */
export const canonicalSignedBytesV5 = (frame: SignedFrameV5): Uint8Array => {
    const preamble = stringToUint8Array(
        JSON.stringify([
            frame.version,
            frame.topic,
            frame.responseTopic,
            frame.source,
            frame.kind,
            frame.path,
            frame.methodOrEvent,
            frame.correlation,
            frame.contentType,
            frame.code,
            frame.contractVersion,
            frame.ttl,
            frame.timestamp,
            frame.nonce
        ])
    )
    const result = new Uint8Array(preamble.length + frame.payload.length)
    result.set(preamble, 0)
    result.set(frame.payload, preamble.length)
    return result
}

/** A nonce with enough entropy that collisions are not a practical concern. */
export const createNonce = () => uint8ArrayToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)))

/**
 * Rejects frames that are too old and frames whose nonce has been seen before.
 *
 * A signature alone does not stop a captured frame being sent again, which for RPC would mean
 * replaying a command. The freshness window bounds how long a captured frame stays useful and
 * bounds how many nonces have to be remembered to cover it.
 */
export class ReplayGuard {
    private seen = new Map<string, number>()

    constructor(
        /** How far a frame's timestamp may differ from now. Peers need clocks within this of each other. */
        public maxClockSkew = 60000,
        /** Hard cap on remembered nonces, so a flood cannot grow this without bound. */
        public maxTrackedNonces = 5000
    ) {}

    /** True if the frame is fresh and previously unseen. Records the nonce as a side effect. */
    accept(nonce: string, time: number, now = Date.now()) {
        if (!nonce || !Number.isFinite(time)) return false
        if (Math.abs(now - time) > this.maxClockSkew) return false
        if (this.seen.has(nonce)) return false
        this.seen.set(nonce, now)
        this.prune(now)
        return true
    }

    private prune(now: number) {
        // Insertion order tracks arrival order, so the first entry that is still fresh means the
        // rest are too.
        for (const [nonce, at] of this.seen) {
            if (now - at > this.maxClockSkew || this.seen.size > this.maxTrackedNonces) {
                this.seen.delete(nonce)
                continue
            }
            break
        }
    }

    get size() {
        return this.seen.size
    }
}

/** Look up the key material for a peer. Return undefined for peers with no key on file. */
export type KeyResolver<T> = (source: string) => T | undefined | Promise<T | undefined>

const identityOf = (source: string, identityFor?: (source: string) => RpcIdentity | undefined) => identityFor?.(source) ?? { name: source }

/**
 * HMAC-SHA256 with a secret per peer. Universally available, but symmetric: whoever can verify a
 * peer's messages can also forge them, so the secret must only be shared with parties allowed to
 * act as that peer. Use Ed25519 when a compromised verifier must not be able to impersonate.
 */
export const createHmacSigner = (secret: Uint8Array | string): MessageSigner => {
    let imported: Promise<CryptoKey> | undefined
    const key = () => (imported ??= subtle().importKey('raw', bufferSource(toBytes(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))
    return async (canonicalBytes) => uint8ArrayToBase64(new Uint8Array(await subtle().sign('HMAC', await key(), bufferSource(canonicalBytes))))
}

export const createHmacVerifier = (
    resolveSecret: KeyResolver<Uint8Array | string>,
    identityFor?: (source: string) => RpcIdentity | undefined
): MessageVerifier => {
    return async (canonicalBytes, signature, { source }) => {
        const secret = await resolveSecret(source)
        if (!secret) return undefined
        const key = await subtle().importKey('raw', bufferSource(toBytes(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
        // subtle.verify compares in constant time, so this does not leak the expected signature.
        const valid = await subtle().verify('HMAC', key, bufferSource(base64ToUint8Array(signature)), bufferSource(canonicalBytes))
        return valid ? identityOf(source, identityFor) : undefined
    }
}

/**
 * Ed25519, taking WebCrypto keys directly so key storage and format stay the caller's concern.
 * Asymmetric: the verifier holds only public keys, so compromising a server does not let anyone
 * forge messages from its peers.
 */
export const createEd25519Signer = (privateKey: CryptoKey): MessageSigner => {
    return async (canonicalBytes) => uint8ArrayToBase64(new Uint8Array(await subtle().sign('Ed25519', privateKey, bufferSource(canonicalBytes))))
}

export const createEd25519Verifier = (
    resolvePublicKey: KeyResolver<CryptoKey>,
    identityFor?: (source: string) => RpcIdentity | undefined
): MessageVerifier => {
    return async (canonicalBytes, signature, { source }) => {
        const publicKey = await resolvePublicKey(source)
        if (!publicKey) return undefined
        const valid = await subtle().verify('Ed25519', publicKey, bufferSource(base64ToUint8Array(signature)), bufferSource(canonicalBytes))
        return valid ? identityOf(source, identityFor) : undefined
    }
}
