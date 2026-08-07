import test from 'ava'
import { PendingRegistry, type ClaimVerdict, type PendingSession } from './enrolment.js'
import { commissioningSecret, deviceId, pairingProof, pairingProofValid, sessionNonce } from './pairing.js'

const accepts = async (): Promise<ClaimVerdict> => ({ accepted: true, acceptProof: 'proof-from-the-node' })
const refuses = async (): Promise<ClaimVerdict> => ({ accepted: false, reason: 'the proof did not verify' })

const registered = (registry: PendingRegistry) => registry.register({ deviceId: deviceId(), nodeNonce: sessionNonce() })

test('a node waits to be claimed, and what it publishes carries nothing secret', (t) => {
    const registry = new PendingRegistry()
    const session = registry.register({ deviceId: 'dev-a', nodeNonce: 'n', product: 'panel-pc' })
    t.deepEqual(Object.keys(session).sort(), ['deviceId', 'expiresAt', 'nodeNonce', 'product', 'sessionId'])
    t.deepEqual(registry.pending(), [session])
})

/**
 * The session id is the authority's to choose. A node that picked its own could pick one already
 * held by another device and be handed a claim meant for that one.
 */
test('the session id comes from the authority, not from the node', (t) => {
    const registry = new PendingRegistry()
    const first = registry.register({ deviceId: 'dev-a', nodeNonce: 'n' })
    const second = registry.register({ deviceId: 'dev-a', nodeNonce: 'n' })
    t.not(first.sessionId, second.sessionId)
})

test('a claim is decided by the node, and the authority only records what it said', async (t) => {
    const registry = new PendingRegistry()
    const session = registered(registry)

    // The authority holds no secret, so a refusal is the node's word and the session survives it -
    // a wrong secret is somebody mistyping, not an attack that should cost them the window.
    t.deepEqual(await registry.claim(session.sessionId, refuses), { outcome: 'refused', reason: 'the proof did not verify' })
    t.is(registry.pending().length, 1, 'a refused claim must not consume the session')

    t.deepEqual(await registry.claim(session.sessionId, accepts), { outcome: 'claimed', acceptProof: 'proof-from-the-node' })
    t.is(registry.pending().length, 0, 'a claimed session is no longer offered')
    t.deepEqual(await registry.claim(session.sessionId, accepts), { outcome: 'already' }, 'a session completes at most once')
})

test('an unknown or lapsed session is one answer, since which of the two is not the caller’s business', async (t) => {
    let now = 1_000_000
    const registry = new PendingRegistry(() => now)
    const session = registry.register({ deviceId: 'dev-a', nodeNonce: 'n', ttl: 60 })

    t.deepEqual(await registry.claim('never-existed', accepts), { outcome: 'unknown' })
    now += 61_000
    t.deepEqual(await registry.claim(session.sessionId, accepts), { outcome: 'unknown' })
    t.is(registry.pending().length, 0, 'a lapsed session is swept rather than listed')
})

/**
 * The rule the earlier draft got wrong. Refusing both on *any* two attempts would let an
 * unauthenticated client kill every enrolment by racing it; the authority cannot see which attempts
 * are genuine, so what it can detect is two the node *accepted* - which means the secret is in two
 * pairs of hands, and picking one of them by arrival order would be arbitrary.
 */
test('two claims the node accepted destroy the session rather than one winning', async (t) => {
    const registry = new PendingRegistry()
    const session = registered(registry)

    // Both are with the node at once: the second is admitted before the first has recorded itself,
    // which is the interleaving a check made only on the way in would miss.
    let releaseFirst: () => void = () => {}
    const held = new Promise<void>((resolve) => (releaseFirst = resolve))
    const first = registry.claim(session.sessionId, async () => {
        await held
        return { accepted: true, acceptProof: 'first' }
    })
    const second = registry.claim(session.sessionId, accepts)
    t.deepEqual(await second, { outcome: 'claimed', acceptProof: 'proof-from-the-node' })
    releaseFirst()
    t.deepEqual(await first, { outcome: 'contested' })

    t.is(registry.size, 0, 'a contested session is destroyed, not left for whoever asks next')
    t.deepEqual(await registry.claim(session.sessionId, accepts), { outcome: 'unknown' })
})

test('a released session stops being claimable, which is what persisting an identity means', async (t) => {
    const registry = new PendingRegistry()
    const session = registered(registry)
    registry.release(session.sessionId)
    t.deepEqual(await registry.claim(session.sessionId, accepts), { outcome: 'unknown' })
})

test('the window is bounded, so a ttl of a week is not a device left open with a number on it', (t) => {
    const registry = new PendingRegistry(() => 0)
    t.is(registry.register({ deviceId: 'a', nodeNonce: 'n', ttl: 99999 }).expiresAt, 3600 * 1000)
    t.is(registry.register({ deviceId: 'a', nodeNonce: 'n', ttl: 0 }).expiresAt, 1000)
    t.is(registry.register({ deviceId: 'a', nodeNonce: 'n' }).expiresAt, 300 * 1000)
})

/**
 * The registry and the proof, together, as the two ends actually use them: the authority relays a
 * transcript it cannot check, and the node is the only party that can say yes.
 */
test('end to end, the authority never holds what would let it answer for the node', async (t) => {
    const secret = commissioningSecret()
    const registry = new PendingRegistry()
    const session = registry.register({ deviceId: deviceId(), nodeNonce: sessionNonce() })
    const claimNonce = sessionNonce()

    const transcriptFor = (offered: PendingSession) => ({
        deviceId: offered.deviceId,
        sessionId: offered.sessionId,
        nodeNonce: offered.nodeNonce,
        claimNonce
    })
    // What the node does when a claim is relayed to it: verify with the secret on its own label.
    const node = (claimProof: string) => async (offered: PendingSession): Promise<ClaimVerdict> =>
        pairingProofValid(secret, 'claim', transcriptFor(offered), claimProof)
            ? { accepted: true, acceptProof: pairingProof(secret, 'accept', transcriptFor(offered)) }
            : { accepted: false, reason: 'proof did not verify' }

    const wrong = await registry.claim(session.sessionId, node(pairingProof(commissioningSecret(), 'claim', transcriptFor(session))))
    t.is(wrong.outcome, 'refused', 'a claimant without the secret gets nowhere')

    const right = await registry.claim(session.sessionId, node(pairingProof(secret, 'claim', transcriptFor(session))))
    t.is(right.outcome, 'claimed')
    // And the claimant can tell it reached the device rather than something standing in for it.
    t.true(right.outcome === 'claimed' && pairingProofValid(secret, 'accept', transcriptFor(session), right.acceptProof!))
})
