import { base64ToUint8Array, stringToUint8Array, uint8ArrayToBase64 } from 'uint8array-extras'
import type { RpcAuthenticator, RpcConnectionInfo, RpcIdentity } from './Auth.js'

/**
 * Credentials a peer mints for something it starts, rather than credentials an operator issued.
 *
 * The problem this solves is small to state and was real: a node that runs scripts handed each one
 * its own bearer token. On an authenticating bus a token is bound to exactly one peer name, so the
 * script either could not connect under its own name at all or dissolved into the node's identity -
 * and either way the node's credential now lived in an arbitrary program's environment. A child
 * process should carry a credential of its own, saying what it is and who vouched for it, and
 * nothing more.
 *
 * The shape is deliberately plain: a signed, self-describing token. The issuer holds a secret the
 * bus also knows, mints a short-lived credential naming the child, and the bus verifies it without
 * having been configured with anything about that child in advance - which is the whole point,
 * since a node may start a script the operator has never heard of. What the bus *is* configured
 * with is which issuers it trusts, which is a decision about nodes rather than about programs.
 *
 * The trust this buys is bounded and worth naming. A derived credential is evidence that the named
 * issuer vouched for the named child at a moment in time. It is not evidence about what the child
 * is, what wrote it, or what it will do - see the AI boundary specification on provenance being
 * issuer-vouched rather than detected. HMAC means whoever can verify can also mint, so the secret
 * is shared only between a bus and the nodes it is willing to let speak for their children.
 */

/** The version marker leading every token, so the format can change without guessing. */
const FORMAT = 'srpc-d1'

/**
 * What a derived credential asserts. Everything here is signed, and everything here is a claim by
 * the *issuer* - a peer that already authenticated - about a child it started.
 */
export interface RpcDerivedClaims {
    /** Unique per minting, so an audit trail can name one credential among many. */
    credentialId: string
    /** The peer name the child may use, and the only one its frames may claim. */
    subject: string
    /**
     * What kind of principal this is. `ai-tool` and `ai-program` are the provenance roles the AI
     * boundary reads; anything else is an ordinary role an authorizer may consult.
     */
    roles?: string[]
    /** The peer that minted this, which is the peer the bus checks its signature against. */
    issuer: string
    /** The principal on whose authority the issuer acted, when there is one to name. */
    sponsorSubject?: string
    /** The session that sponsorship belongs to. Ending it is what stops renewal. */
    sponsorSessionId?: string
    /** The credential this one descends from, so a chain can be reconstructed after the fact. */
    parentCredentialId?: string
    /**
     * How far from a human this is: 1 for something a person's tool started, 2 for something that
     * started, and so on. A grant may bound the depth it permits; unbounded chains are how a
     * program that writes programs stops being reviewable.
     */
    generation: number
    issuedAt: number
    /** Absolute expiry. Short by default: renewal is the issuer's job, and it stops when it stops. */
    expiresAt: number
    /** What the child was started from, when it is an artifact worth pinning. */
    artifactDigest?: string
    /** Where the model claim came from, when one is made. Never treat `sponsor-declared` as verified. */
    model?: { provider?: string; id?: string; version?: string; assurance: 'sponsor-declared' | 'runtime-attested' | 'vendor-attested' }
}

const subtle = () => {
    const available = globalThis.crypto?.subtle
    if (!available) throw new Error('source-rpc derived credentials need WebCrypto (globalThis.crypto.subtle)')
    return available
}

const bufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)
const toBytes = (value: Uint8Array | string) => (typeof value === 'string' ? stringToUint8Array(value) : value)

const hmacKey = async (secret: Uint8Array | string, usage: 'sign' | 'verify') =>
    await subtle().importKey('raw', bufferSource(toBytes(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

/**
 * The bytes that get signed: the format marker and the claims, canonically encoded.
 *
 * Keys are sorted, so two encoders that disagree about property order still produce one signature -
 * the same discipline the frame signing uses, and for the same reason.
 */
const canonicalBytes = (claims: RpcDerivedClaims) => {
    const ordered = Object.fromEntries(Object.entries(claims as unknown as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    return stringToUint8Array(`${FORMAT}.${JSON.stringify(ordered)}`)
}

/**
 * Mint a credential for a child. The secret is the issuer's, shared with the bus that will verify.
 *
 * `expiresAt` is a required claim rather than an option with a comfortable default, because the
 * lifetime is the interesting decision: a credential that outlives the thing it was minted for is
 * the failure this design exists to avoid, and the issuer is the only party that knows how long the
 * child should live.
 */
export const mintDerivedCredential = async (claims: RpcDerivedClaims, secret: Uint8Array | string): Promise<string> => {
    if (!claims.subject) throw new Error('mintDerivedCredential: a derived credential must name its subject')
    if (!claims.issuer) throw new Error('mintDerivedCredential: a derived credential must name its issuer')
    if (!(claims.expiresAt > claims.issuedAt)) throw new Error('mintDerivedCredential: expiresAt must be after issuedAt')
    const payload = canonicalBytes(claims)
    const signature = new Uint8Array(await subtle().sign('HMAC', await hmacKey(secret, 'sign'), bufferSource(payload)))
    return `${FORMAT}.${uint8ArrayToBase64(stringToUint8Array(JSON.stringify(claims)))}.${uint8ArrayToBase64(signature)}`
}

/** Reads the claims out of a token without verifying anything. For diagnostics and audit only. */
export const readDerivedClaims = (token: string): RpcDerivedClaims | undefined => {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== FORMAT) return undefined
    try {
        return JSON.parse(new TextDecoder().decode(base64ToUint8Array(parts[1]))) as RpcDerivedClaims
    } catch {
        return undefined
    }
}

export interface DerivedVerifierOptions {
    /** Issuer peer name -> the secret it signs with. A bus trusts nodes, not the programs they start. */
    issuers: { [issuer: string]: Uint8Array | string }
    /**
     * Refuse a credential this returns false for, after the signature and expiry have passed. Where
     * a deployment bounds generation depth, caps lifetime, or admits only certain subjects.
     */
    accept?: (claims: RpcDerivedClaims, info: RpcConnectionInfo) => boolean | Promise<boolean>
    /** Clock skew tolerated on expiry, in milliseconds. Small on purpose. */
    clockSkewMs?: number
}

/**
 * Verify a derived credential and turn it into an identity, or return undefined.
 *
 * The identity's `name` is the subject and nothing else, so the transport pins the child to its own
 * peer name and drops frames claiming any other - which is the property the whole exercise is for.
 * The derivation travels in `claims`, where `authorize` and the invocation handle already carry it
 * to every dispatch: a target can see which issuer vouched, on whose sponsorship, at what
 * generation, without any new plumbing.
 */
export const verifyDerivedCredential = async (
    token: unknown,
    options: DerivedVerifierOptions,
    info: RpcConnectionInfo = {},
    now = Date.now()
): Promise<RpcIdentity | undefined> => {
    if (typeof token !== 'string') return undefined
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== FORMAT) return undefined
    const claims = readDerivedClaims(token)
    if (!claims || !claims.subject || !claims.issuer) return undefined

    const secret = options.issuers[claims.issuer]
    // An unknown issuer is refused before any signature work: a bus trusts the nodes it was told
    // about, and a credential naming anybody else is not a near miss to be measured.
    if (!secret) return undefined

    let signature: Uint8Array
    try {
        signature = base64ToUint8Array(parts[2])
    } catch {
        return undefined
    }
    // subtle.verify compares in constant time, so a wrong signature leaks nothing about the right one.
    const valid = await subtle().verify('HMAC', await hmacKey(secret, 'verify'), bufferSource(signature), bufferSource(canonicalBytes(claims)))
    if (!valid) return undefined

    const skew = options.clockSkewMs ?? 5_000
    if (!(claims.expiresAt > now - skew)) return undefined
    if (claims.issuedAt > now + skew) return undefined
    if (options.accept && !(await options.accept(claims, info))) return undefined

    return {
        name: claims.subject,
        ...(claims.roles?.length ? { roles: [...claims.roles] } : {}),
        claims: {
            derived: true,
            credentialId: claims.credentialId,
            issuer: claims.issuer,
            generation: claims.generation,
            expiresAt: claims.expiresAt,
            ...(claims.sponsorSubject ? { sponsorSubject: claims.sponsorSubject } : {}),
            ...(claims.sponsorSessionId ? { sponsorSessionId: claims.sponsorSessionId } : {}),
            ...(claims.parentCredentialId ? { parentCredentialId: claims.parentCredentialId } : {}),
            ...(claims.artifactDigest ? { artifactDigest: claims.artifactDigest } : {}),
            ...(claims.model ? { model: claims.model } : {})
        }
    }
}

/**
 * An authenticator accepting derived credentials, for a bus that lets its nodes speak for the
 * programs they start.
 *
 * Composable with `createTokenAuthenticator` through `firstAuthenticator`, which is the usual
 * arrangement: operators hold tokens, nodes mint credentials for their children.
 */
export const createDerivedAuthenticator = (options: DerivedVerifierOptions): RpcAuthenticator => {
    for (const [issuer, secret] of Object.entries(options.issuers))
        if (!issuer.trim() || !toBytes(secret).length) throw new Error('createDerivedAuthenticator: every issuer needs a name and a non-empty secret')
    return async (credentials, info) => await verifyDerivedCredential((credentials as { token?: unknown } | null)?.token, options, info)
}

/**
 * Try each authenticator in turn and take the first identity any of them returns.
 *
 * Order is the deployment's to choose and does matter: put the narrower one first where a
 * credential could plausibly satisfy both. An authenticator that throws is treated as a refusal
 * rather than allowed to abort the handshake, so one misconfigured source cannot close a bus.
 */
export const firstAuthenticator = (...authenticators: RpcAuthenticator[]): RpcAuthenticator => {
    return async (credentials, info) => {
        for (const authenticate of authenticators) {
            let identity: RpcIdentity | undefined
            try {
                identity = await authenticate(credentials, info)
            } catch {
                identity = undefined
            }
            if (identity) return identity
        }
        return undefined
    }
}
