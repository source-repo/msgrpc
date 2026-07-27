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
    if (!available) throw new Error('msgrpc signing needs WebCrypto (globalThis.crypto.subtle)')
    return available
}

const toBytes = (value: Uint8Array | string) => (typeof value === 'string' ? stringToUint8Array(value) : value)

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
    source: string
    kind: string
    path: string
    methodOrEvent: string
    correlation: string
    timestamp: number
    nonce: string
    payload: Uint8Array
}

/**
 * The MQTT 5 canonical form. The topic is signed rather than a target field, because under this
 * layout the topic is what carries the addressing. contentType is deliberately absent: it says how
 * to read bytes that are themselves covered, so altering it can only make the payload fail to
 * parse, never change what was authorised.
 */
export const canonicalSignedBytesV5 = (frame: SignedFrameV5): Uint8Array => {
    const preamble = stringToUint8Array(
        JSON.stringify([
            frame.version,
            frame.topic,
            frame.source,
            frame.kind,
            frame.path,
            frame.methodOrEvent,
            frame.correlation,
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
    const key = () => (imported ??= subtle().importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))
    return async (canonicalBytes) => uint8ArrayToBase64(new Uint8Array(await subtle().sign('HMAC', await key(), canonicalBytes)))
}

export const createHmacVerifier = (
    resolveSecret: KeyResolver<Uint8Array | string>,
    identityFor?: (source: string) => RpcIdentity | undefined
): MessageVerifier => {
    return async (canonicalBytes, signature, { source }) => {
        const secret = await resolveSecret(source)
        if (!secret) return undefined
        const key = await subtle().importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
        // subtle.verify compares in constant time, so this does not leak the expected signature.
        const valid = await subtle().verify('HMAC', key, base64ToUint8Array(signature), canonicalBytes)
        return valid ? identityOf(source, identityFor) : undefined
    }
}

/**
 * Ed25519, taking WebCrypto keys directly so key storage and format stay the caller's concern.
 * Asymmetric: the verifier holds only public keys, so compromising a server does not let anyone
 * forge messages from its peers.
 */
export const createEd25519Signer = (privateKey: CryptoKey): MessageSigner => {
    return async (canonicalBytes) => uint8ArrayToBase64(new Uint8Array(await subtle().sign('Ed25519', privateKey, canonicalBytes)))
}

export const createEd25519Verifier = (
    resolvePublicKey: KeyResolver<CryptoKey>,
    identityFor?: (source: string) => RpcIdentity | undefined
): MessageVerifier => {
    return async (canonicalBytes, signature, { source }) => {
        const publicKey = await resolvePublicKey(source)
        if (!publicKey) return undefined
        const valid = await subtle().verify('Ed25519', publicKey, base64ToUint8Array(signature), canonicalBytes)
        return valid ? identityOf(source, identityFor) : undefined
    }
}
