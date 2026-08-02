import test from 'ava'
import { randomUUID } from 'crypto'
import {
    createDerivedAuthenticator,
    createTokenAuthenticator,
    firstAuthenticator,
    mintDerivedCredential,
    readDerivedClaims,
    rpc,
    rpcNamespace,
    RpcClient,
    RpcServer,
    verifyDerivedCredential,
    type RpcDerivedClaims
} from './index.js'

/**
 * Derived credentials: what a node mints for something it starts.
 *
 * The bug they exist to fix is that a node handed each script its own bearer token, which on an
 * authenticating bus is both useless to the script - a token is pinned to one peer name - and a
 * leak of the node's identity into an arbitrary program.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const SECRET = `issuer-secret-${run}`

const claims = (overrides: Partial<RpcDerivedClaims> = {}): RpcDerivedClaims => ({
    credentialId: randomUUID().slice(0, 8),
    subject: peer('child'),
    roles: ['ai-program'],
    issuer: peer('node'),
    sponsorSubject: 'anders',
    sponsorSessionId: 'session-1',
    generation: 2,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides
})

test('a minted credential verifies, names only its subject, and carries the chain in claims', async (t) => {
    const token = await mintDerivedCredential(claims(), SECRET)
    const identity = await verifyDerivedCredential(token, { issuers: { [peer('node')]: SECRET } })

    t.truthy(identity)
    t.is(identity?.name, peer('child'), 'the identity is the child, never the issuer')
    t.deepEqual(identity?.roles, ['ai-program'])
    t.is(identity?.claims?.issuer, peer('node'))
    t.is(identity?.claims?.sponsorSubject, 'anders')
    t.is(identity?.claims?.generation, 2)
    t.is(identity?.claims?.derived, true)
})

test('what a forger cannot do', async (t) => {
    const issuers = { [peer('node')]: SECRET }

    // A different secret: the issuer name is right and the signature is not.
    const wrongKey = await mintDerivedCredential(claims(), 'some-other-secret')
    t.is(await verifyDerivedCredential(wrongKey, { issuers }), undefined)

    // An issuer this bus was never told about, however well-formed the token.
    const strangeIssuer = await mintDerivedCredential(claims({ issuer: peer('stranger') }), SECRET)
    t.is(await verifyDerivedCredential(strangeIssuer, { issuers }), undefined)

    // Editing the claims after signing - the whole point of signing them.
    const token = await mintDerivedCredential(claims(), SECRET)
    const [format, payload, signature] = token.split('.')
    const tampered = JSON.parse(Buffer.from(payload, 'base64').toString()) as RpcDerivedClaims
    tampered.subject = peer('somebody-important')
    const forged = `${format}.${Buffer.from(JSON.stringify(tampered)).toString('base64')}.${signature}`
    t.is(await verifyDerivedCredential(forged, { issuers }), undefined, 'a rewritten subject must not survive the signature')

    // Not a derived credential at all.
    t.is(await verifyDerivedCredential('an-ordinary-bearer-token', { issuers }), undefined)
    t.is(await verifyDerivedCredential(undefined, { issuers }), undefined)
})

test('expiry is enforced, and an unexpired credential is still refused by an accept rule', async (t) => {
    const issuers = { [peer('node')]: SECRET }

    const expired = await mintDerivedCredential(claims({ issuedAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 }), SECRET)
    t.is(await verifyDerivedCredential(expired, { issuers }), undefined, 'lifetime is the point: an expired credential is not a valid one')

    // Issued in the future by more than the tolerated skew.
    const premature = await mintDerivedCredential(claims({ issuedAt: Date.now() + 600_000, expiresAt: Date.now() + 900_000 }), SECRET)
    t.is(await verifyDerivedCredential(premature, { issuers }), undefined)

    // A deployment bounding how far from a human it will accept.
    const deep = await mintDerivedCredential(claims({ generation: 5 }), SECRET)
    const shallow = { issuers, accept: (candidate: RpcDerivedClaims) => candidate.generation <= 2 }
    t.is(await verifyDerivedCredential(deep, shallow), undefined, 'generation depth is a deployment decision the verifier can enforce')
    t.truthy(await verifyDerivedCredential(await mintDerivedCredential(claims({ generation: 2 }), SECRET), shallow))
})

test('minting refuses the states that would produce a useless credential', async (t) => {
    await t.throwsAsync(mintDerivedCredential(claims({ subject: '' }), SECRET), { message: /must name its subject/ })
    await t.throwsAsync(mintDerivedCredential(claims({ issuer: '' }), SECRET), { message: /must name its issuer/ })
    await t.throwsAsync(mintDerivedCredential(claims({ expiresAt: Date.now() - 1 }), SECRET), { message: /expiresAt must be after issuedAt/ })
    t.throws(() => createDerivedAuthenticator({ issuers: { '': SECRET } }), { message: /every issuer needs a name/ })
    t.throws(() => createDerivedAuthenticator({ issuers: { node: '' } }), { message: /non-empty secret/ })
})

test('readDerivedClaims is for audit and verifies nothing', (t) => {
    const forged = `srpc-d1.${Buffer.from(JSON.stringify(claims({ subject: 'anybody' }))).toString('base64')}.bm90LWEtc2lnbmF0dXJl`
    t.is(readDerivedClaims(forged)?.subject, 'anybody', 'it reads what the token says')
    t.is(readDerivedClaims('nonsense'), undefined)
})

@rpcNamespace('desk')
class Desk {
    @rpc({ semantics: 'query' })
    async whoAmI() {
        return 'answered'
    }
}

test('a child connects to a real bus under its own name, beside operators holding ordinary tokens', async (t) => {
    const operatorToken = `operator-${run}`
    const server = new RpcServer({
        name: peer('bus3863'),
        transports: [{ port: 3863, host: '127.0.0.1' }],
        // The arrangement this is built for: people hold tokens, nodes vouch for what they start.
        authenticate: firstAuthenticator(
            createTokenAuthenticator({ [operatorToken]: { name: peer('operator'), roles: ['engineer'] } }),
            createDerivedAuthenticator({ issuers: { [peer('node')]: SECRET } })
        )
    })
    server.exposeClassInstance(new Desk())
    await server.ready()

    const token = await mintDerivedCredential(claims({ subject: peer('script3863') }), SECRET)
    const child = new RpcClient('http://localhost:3863', { name: peer('script3863'), defaultTarget: peer('bus3863'), credentials: { token } })
    await child.ready()
    t.is(await (await child.proxy<Desk>('desk')).whoAmI(), 'answered')

    // The ordinary token still works alongside it.
    const operator = new RpcClient('http://localhost:3863', { name: peer('operator'), defaultTarget: peer('bus3863'), credentials: { token: operatorToken } })
    await operator.ready()
    t.is(await (await operator.proxy<Desk>('desk')).whoAmI(), 'answered')

    // A credential is pinned to its subject: presenting it under another name gets nowhere, which
    // is the property that makes it safe to hand a program a credential at all.
    const impostor = new RpcClient('http://localhost:3863', {
        name: peer('somebody-else'),
        defaultTarget: peer('bus3863'),
        credentials: { token },
        readyTimeout: 800,
        callTimeout: 700
    })
    await t.throwsAsync(async () => (await impostor.proxy<Desk>('desk')).whoAmI())
    await impostor.close()

    await operator.close()
    await child.close()
    await server.close()
})
