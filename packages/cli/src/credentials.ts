import { readFileSync, statSync } from 'node:fs'
import type { ServerOptions as TlsServerOptions } from 'node:https'
import {
    createHmacSigner,
    createHmacVerifier,
    mintDerivedCredential,
    type MessageSigner,
    type MessageVerifier,
    type TokenGrant
} from '@source-repo/rpc'

export interface SigningKeys {
    name?: string
    secret: string
    peers?: { [peer: string]: string }
}

export interface Signing {
    keys: SigningKeys
    sign: MessageSigner
    verify?: MessageVerifier
}

export interface LoadedSigningKeys extends Signing {
    readableByOthers: boolean
}

/**
 * Whether anyone but the owner can read a file holding secrets.
 *
 * Reported rather than refused: a mode nobody can read is not always achievable - a mounted config
 * map, a Windows filesystem - and a command that stopped there would be a command nobody could run
 * in those places. Saying it once is what makes the ordinary case, where the mode is simply wrong,
 * visible to whoever started it.
 */
export const readableByOthers = (path: string) => {
    try {
        return !!(statSync(path).mode & 0o077)
    } catch {
        // File modes are not available on every platform. The secrets are still valid there.
        return false
    }
}

/**
 * The signer and verifier for one identity, wherever its secrets were written down.
 *
 * `where` names that place in the errors - a key file's path, or the task the keys are written
 * inside - because the reader has to go and edit it, and "has no secret" without an address is a
 * message that sends someone looking through every file they have.
 */
export const signingFrom = (value: unknown, where: string): Signing => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object with a "secret"`)
    const keys = value as SigningKeys
    if (typeof keys.secret !== 'string' || !keys.secret) throw new Error(`${where} has no "secret"`)
    if (keys.name !== undefined && (typeof keys.name !== 'string' || !keys.name)) throw new Error(`${where} has an invalid "name"`)
    if (keys.peers !== undefined && (!keys.peers || typeof keys.peers !== 'object' || Array.isArray(keys.peers)))
        throw new Error(`${where} has invalid "peers"`)
    if (keys.peers && Object.entries(keys.peers).some(([peer, secret]) => !peer || typeof secret !== 'string' || !secret))
        throw new Error(`${where} has a peer in "peers" with no secret`)

    const sign = createHmacSigner(keys.secret)
    const verify = keys.peers ? createHmacVerifier((peer) => keys.peers?.[peer]) : undefined
    return { keys, sign, ...(verify ? { verify } : {}) }
}

/** Read and validate one peer's HMAC identity without deciding how a command reports failures. */
export const loadSigningKeys = (path: string): LoadedSigningKeys => {
    let keys: unknown
    try {
        keys = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (e) {
        throw new Error(`cannot read keys from ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    return { ...signingFrom(keys, path), readableByOthers: readableByOthers(path) }
}

/**
 * The certificate and key a server serves TLS with.
 *
 * Paths rather than contents wherever this is configured, and both halves together: a PEM on a
 * command line would be in `ps` and in the shell history, and a certificate without its key opens a
 * port that listens and then fails every handshake.
 */
export const loadTls = (certPath: string, keyPath: string): TlsServerOptions => {
    try {
        return { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    } catch (e) {
        throw new Error(`cannot read the certificate or key: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
}

export interface AuthFile {
    token?: string
    tokens?: { [token: string]: TokenGrant }
    /**
     * This node's own signing secret, for minting credentials for the scripts it starts. Present on
     * a node; the bus that should accept those credentials lists the same secret under `issuers`.
     */
    derive?: string
    /**
     * Issuer peer name -> the secret it mints with. Present on a bus: it says which nodes this bus
     * lets speak for the programs they start, which is a decision about nodes rather than programs.
     */
    issuers?: { [issuer: string]: string }
}

export interface LoadedAuth {
    auth: AuthFile
    readableByOthers: boolean
}

/** Read the credentials a command presents, or the grants a bus accepts, from a file. */
export const loadAuthFile = (path: string): LoadedAuth => {
    let auth: AuthFile
    try {
        auth = JSON.parse(readFileSync(path, 'utf8')) as AuthFile
    } catch (e) {
        throw new Error(`cannot read tokens from ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    // An empty file is the failure that looks like success: the command starts, and the bus it
    // meant to gate is open. Better to refuse than to run unauthenticated on request.
    if (!auth.token && !auth.tokens) throw new Error(`${path} has neither "token" nor "tokens"`)
    return { auth, readableByOthers: readableByOthers(path) }
}

/**
 * How long a script's credential lasts. Deliberately short of a working day: a credential that
 * outlives the run it was minted for is the failure this design exists to avoid, and a script that
 * needs longer should be a peer with a credential an operator issued.
 */
const SCRIPT_CREDENTIAL_MS = 4 * 60 * 60 * 1000

/**
 * Mints each script its own short-lived credential, or nothing when this peer holds no `derive`
 * secret - in which case scripts start unauthenticated rather than borrowing the node's identity.
 */
export const scriptCredentials = (auth: Pick<AuthFile, 'token' | 'tokens' | 'derive' | 'issuers'>, issuer: string, warning?: (message: string) => void) => {
    if (!auth.derive) return undefined
    if (!auth.token && !auth.tokens && !auth.issuers)
        warning?.("'derive' is set but no credential of this peer's own is - scripts will present credentials to a bus that may not be checking any.")
    return async (script: string) => {
        const name = `${script}@${issuer}`
        const issuedAt = Date.now()
        return {
            name,
            token: await mintDerivedCredential(
                {
                    credentialId: `${script}-${issuedAt.toString(36)}`,
                    subject: name,
                    // The provenance the AI boundary reads. A script is a program this node started,
                    // whoever wrote it - the honest claim, and never a claim about what wrote it.
                    roles: ['ai-program'],
                    issuer,
                    generation: 2,
                    issuedAt,
                    expiresAt: issuedAt + SCRIPT_CREDENTIAL_MS
                },
                auth.derive!
            )
        }
    }
}
