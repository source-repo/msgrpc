import { readFileSync, statSync } from 'node:fs'
import { createHmacSigner, createHmacVerifier, type MessageSigner, type MessageVerifier } from '@source-repo/rpc'

export interface SigningKeys {
    name?: string
    secret: string
    peers?: { [peer: string]: string }
}

export interface LoadedSigningKeys {
    keys: SigningKeys
    sign: MessageSigner
    verify?: MessageVerifier
    readableByOthers: boolean
}

/** Read and validate one peer's HMAC identity without deciding how a command reports failures. */
export const loadSigningKeys = (path: string): LoadedSigningKeys => {
    let keys: SigningKeys
    try {
        keys = JSON.parse(readFileSync(path, 'utf8')) as SigningKeys
    } catch (e) {
        throw new Error(`cannot read keys from ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    if (typeof keys.secret !== 'string' || !keys.secret) throw new Error(`${path} has no "secret"`)
    if (keys.name !== undefined && (typeof keys.name !== 'string' || !keys.name)) throw new Error(`${path} has an invalid "name"`)
    if (keys.peers !== undefined && (!keys.peers || typeof keys.peers !== 'object' || Array.isArray(keys.peers)))
        throw new Error(`${path} has invalid "peers"`)

    let readableByOthers = false
    try {
        readableByOthers = !!(statSync(path).mode & 0o077)
    } catch {
        // File modes are not available on every platform. The keys are still valid there.
    }

    const sign = createHmacSigner(keys.secret)
    const verify = keys.peers ? createHmacVerifier((peer) => keys.peers?.[peer]) : undefined
    return { keys, sign, ...(verify ? { verify } : {}), readableByOthers }
}
