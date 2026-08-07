import test from 'ava'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { commissioningSecret, deviceId, pairingProof, pairingProofValid, sessionNonce, type PairingTranscript } from './pairing.js'

const transcript = (): PairingTranscript => ({
    deviceId: deviceId(),
    sessionId: sessionNonce(),
    nodeNonce: sessionNonce(),
    claimNonce: sessionNonce()
})

test('a proof verifies against the secret that made it, and against nothing else', (t) => {
    const secret = commissioningSecret()
    const shape = transcript()
    t.true(pairingProofValid(secret, 'claim', shape, pairingProof(secret, 'claim', shape)))
    t.false(pairingProofValid(commissioningSecret(), 'claim', shape, pairingProof(secret, 'claim', shape)))
})

/**
 * The direction tags are what stop an authority in the middle echoing the console's own proof back
 * to it and passing for the device it never reached. Without them both ends sign the same bytes.
 */
test('a claim proof is not an accept proof, so neither direction can be replayed as the other', (t) => {
    const secret = commissioningSecret()
    const shape = transcript()
    const claim = pairingProof(secret, 'claim', shape)
    t.not(claim, pairingProof(secret, 'accept', shape))
    t.false(pairingProofValid(secret, 'accept', shape, claim), 'the console’s proof must not satisfy the node’s side')
})

test('every field of the transcript is bound, so a proof cannot be carried anywhere else', (t) => {
    const secret = commissioningSecret()
    const shape = transcript()
    const proof = pairingProof(secret, 'claim', shape)
    for (const field of ['deviceId', 'sessionId', 'nodeNonce', 'claimNonce'] as const) {
        t.false(pairingProofValid(secret, 'claim', { ...shape, [field]: sessionNonce() }, proof), `${field} is not bound into the proof`)
    }
})

/**
 * The separator has to be one that cannot appear inside a field, or a caller who picks a clever
 * value can move a boundary and make two different transcripts hash the same.
 */
test('fields cannot be shifted across the separator', (t) => {
    const secret = commissioningSecret()
    const base = { deviceId: 'dev-a', sessionId: 'b', nodeNonce: 'c', claimNonce: 'd' }
    const shifted = { deviceId: 'dev-a', sessionId: '', nodeNonce: 'bc', claimNonce: 'd' }
    t.not(pairingProof(secret, 'claim', base), pairingProof(secret, 'claim', shifted))
})

test('a mismatched proof length is refused rather than throwing', (t) => {
    const secret = commissioningSecret()
    const shape = transcript()
    // timingSafeEqual throws on differing lengths; a caller must get false, not an exception that
    // an attacker can time or that crashes the authority handling an arbitrary claim.
    t.false(pairingProofValid(secret, 'claim', shape, 'short'))
    t.false(pairingProofValid(secret, 'claim', shape, ''))
})

test('secrets and nonces are fresh every time, and carry their full width', (t) => {
    const secrets = new Set(Array.from({ length: 50 }, () => commissioningSecret()))
    t.is(secrets.size, 50)
    // 32 bytes as base64url, which is what makes an offline attack on a captured exchange pointless
    // and is the reason no PAKE is needed here.
    t.is(Buffer.from(commissioningSecret(), 'base64url').length, 32)
    t.is(new Set(Array.from({ length: 50 }, () => deviceId())).size, 50)
})

/**
 * CLAUDE.md's rule, checked rather than remembered - and checked across every source file, not only
 * this one. Two files in this repository have carried the byte before, and `pairing.ts` was written
 * with it twice while this module was being added, which is the whole argument for a test: grep
 * matches and prints nothing, `file` calls it data, and a search for a symbol comes back empty
 * looking authoritative. It is the failure that costs an afternoon before anyone suspects the file.
 */
test('no source file carries a control character the source should be escaping', (t) => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const offenders: string[] = []
    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
            const path = join(directory, entry.name)
            if (entry.isDirectory()) walk(path)
            else if (/\.(ts|tsx|js|json)$/.test(entry.name) && readFileSync(path, 'utf8').includes('\u0000')) offenders.push(path)
        }
    }
    walk(root)
    t.deepEqual(offenders, [], 'a literal NUL makes a file binary to every tool that decides by sniffing content')

    // And the separator this module needs is present, as the escape rather than the byte.
    t.true(readFileSync(join(root, 'cli', 'src', 'pairing.ts'), 'utf8').includes('\\u0000'))
})
