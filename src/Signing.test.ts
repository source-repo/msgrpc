import anyTest, { TestFn } from 'ava'
import { connectAsync } from 'mqtt'
import { encode as msgPackEncode } from '@msgpack/msgpack'
import { stringToUint8Array } from 'uint8array-extras'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import { RpcError } from './RPC/RpcClientHandler.js'
import { canonicalSignedBytes, createHmacSigner, createHmacVerifier, createEd25519Signer, createEd25519Verifier, createNonce, ReplayGuard } from './RPC/Signing.js'
import { RpcMessageType } from './RPC/RpcServerHandler.js'

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

const SECRETS: { [peer: string]: string } = {
    hmi: 'hmi-secret-key-material',
    plantServer: 'server-secret-key-material',
    rogue: 'rogue-secret-key-material'
}
const verifier = createHmacVerifier((peer) => SECRETS[peer], (peer) => ({ name: peer, roles: peer === 'hmi' ? ['operator'] : ['server'] }))

/**
 * Peers get per-test names. A stable clientId is derived from the peer name, and MQTT lets only
 * one connection hold a clientId - a second one disconnects the first, which is the loud failure
 * that unique-name addressing deserves but which would otherwise make concurrent tests collide.
 */
const makeKeyring = (roles: { [peer: string]: string[] }) => {
    const secrets: { [peer: string]: string } = {}
    for (const peer of Object.keys(roles)) secrets[peer] = `secret-material-for-${peer}`
    return {
        secrets,
        signerFor: (peer: string) => createHmacSigner(secrets[peer]),
        verifier: createHmacVerifier((peer) => secrets[peer], (peer) => ({ name: peer, roles: roles[peer] }))
    }
}

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    t.context = { skipped: !(await brokerAvailable()) }
})

const skipWithoutBroker = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
    return t.context.skipped
}

class Plant {
    setpoint = 0
    async writeSetpoint(value: number) {
        this.setpoint = value
        return value
    }
}

// ------------------------------------------------------------------ unit, no broker

test('the signed bytes commit to every field and to the payload', (t) => {
    const base = { source: 'a', target: 'b', time: 1, seq: 2, nonce: 'n', payload: stringToUint8Array('x') }
    const of = (frame: typeof base) => Buffer.from(canonicalSignedBytes(frame)).toString('base64')

    t.not(of(base), of({ ...base, source: 'c' }), 'source is not covered')
    t.not(of(base), of({ ...base, target: 'c' }), 'target is not covered')
    t.not(of(base), of({ ...base, time: 2 }), 'time is not covered')
    t.not(of(base), of({ ...base, seq: 3 }), 'seq is not covered')
    t.not(of(base), of({ ...base, nonce: 'm' }), 'nonce is not covered')
    t.not(of(base), of({ ...base, payload: stringToUint8Array('y') }), 'payload is not covered')

    // Field boundaries must not be smearable: 'ab' + '' must differ from 'a' + 'b'.
    t.not(of({ ...base, source: 'ab', target: '' }), of({ ...base, source: 'a', target: 'b' }))
})

test('a valid HMAC signature verifies and a tampered one does not', async (t) => {
    const sign = createHmacSigner(SECRETS.hmi)
    const frame = { source: 'hmi', target: 'plantServer', time: Date.now(), seq: 1, nonce: createNonce(), payload: stringToUint8Array('payload') }
    const signature = await sign(frame)

    t.deepEqual(await verifier(frame, signature), { name: 'hmi', roles: ['operator'] })
    t.is(await verifier({ ...frame, payload: stringToUint8Array('tampered') }, signature), undefined)
    t.is(await verifier({ ...frame, target: 'elsewhere' }, signature), undefined)
    t.is(await verifier({ ...frame, source: 'rogue' }, signature), undefined, 'a signature verified under the wrong key')
    t.is(await verifier({ ...frame, source: 'unknown-peer' }, signature), undefined, 'a peer with no key on file was accepted')
})

test('Ed25519 signing verifies and rejects a foreign key', async (t) => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const sign = createEd25519Signer(pair.privateKey)
    const frame = { source: 'hmi', target: 'srv', time: Date.now(), seq: 1, nonce: createNonce(), payload: stringToUint8Array('p') }
    const signature = await sign(frame)

    t.deepEqual(await createEd25519Verifier(() => pair.publicKey)(frame, signature), { name: 'hmi' })
    t.is(await createEd25519Verifier(() => other.publicKey)(frame, signature), undefined)
})

test('the replay guard rejects stale and repeated nonces', (t) => {
    const guard = new ReplayGuard(1000, 10)
    const now = Date.now()

    t.true(guard.accept('n1', now, now))
    t.false(guard.accept('n1', now, now), 'a repeated nonce was accepted')
    t.false(guard.accept('n2', now - 5000, now), 'a stale frame was accepted')
    t.false(guard.accept('n3', now + 5000, now), 'a frame from the future was accepted')
    t.true(guard.accept('n4', now, now))
})

test('the replay guard does not grow without bound', (t) => {
    const guard = new ReplayGuard(60000, 50)
    const now = Date.now()
    for (let i = 0; i < 500; i++) guard.accept(`nonce-${i}`, now, now)
    t.true(guard.size <= 51, `tracked ${guard.size} nonces`)
})

// ------------------------------------------------------------------ over a real broker

const signedServer = (name: string, prefix: string, keys: ReturnType<typeof makeKeyring>, extra = {}) =>
    new RpcServer({ name, transports: [{ brokerurl: BROKER_URL, prefix, sign: keys.signerFor(name), verify: keys.verifier }], ...extra })

const signedClient = (name: string, target: string, prefix: string, keys: ReturnType<typeof makeKeyring>, extra = {}) =>
    new RpcClient(undefined, {
        name,
        defaultTarget: target,
        transport: new MqttTransport(name, BROKER_URL, { prefix, sign: keys.signerFor(name), verify: keys.verifier }),
        ...extra
    })

/** Build the exact bytes a peer would publish, so a test can forge or replay one. */
const forgeFrame = async (sign: ReturnType<typeof makeKeyring>['signerFor'] extends (p: string) => infer S ? S : never, header: { source: string; target: string; time: number; seq: number; nonce: string }, call: object) => {
    const payload = msgPackEncode({ type: 'REQUEST', payload: call })
    const signature = await sign({ ...header, payload: new Uint8Array(payload) })
    return Buffer.concat([Buffer.from(JSON.stringify({ ...header, sig: signature }) + '$', 'utf8'), Buffer.from(payload)])
}

test('a signed call is accepted end to end', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/sign-ok'
    const keys = makeKeyring({ 'hmi-ok': ['operator'], 'srv-ok': ['server'] })
    const server = signedServer('srv-ok', prefix, keys)
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')
    const client = signedClient('hmi-ok', 'srv-ok', prefix, keys)
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote?.writeSetpoint(1200), 1200)
    t.is(plant.setpoint, 1200)

    await client.close()
    await server.close()
})

test('a verified MQTT peer gains an identity that authorize can act on', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/sign-identity'
    const keys = makeKeyring({ 'hmi-id': ['operator'], 'srv-id': ['server'] })
    const seen: (string | undefined)[] = []
    // MQTT peers had no identity at all before signing, so requireAuthenticatedPeers would have
    // rejected every MQTT call and authorize could only ever see undefined.
    const server = signedServer('srv-id', prefix, keys, {
        requireAuthenticatedPeers: true,
        authorize: ({ identity }: { identity?: { name: string; roles?: string[] } }) => {
            seen.push(identity?.name)
            return !!identity?.roles?.includes('operator')
        }
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')
    const client = signedClient('hmi-id', 'srv-id', prefix, keys)
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote?.writeSetpoint(7), 7)
    t.deepEqual(seen, ['hmi-id'])

    await client.close()
    await server.close()
})

test('an unsigned peer cannot reach a server that requires signatures', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/sign-unsigned'
    const keys = makeKeyring({ 'hmi-un': ['operator'], 'srv-un': ['server'] })
    const server = signedServer('srv-un', prefix, keys)
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    // Same broker, same topics, no signature at all.
    const client = new RpcClient(undefined, {
        name: 'hmi-un',
        defaultTarget: 'srv-un',
        callTimeout: 900,
        transport: new MqttTransport('hmi-un', BROKER_URL, { prefix })
    })
    await client.ready()

    const error = await t.throwsAsync(async () => (await client.proxy<Plant>('plant')).remote?.writeSetpoint(9999), { instanceOf: RpcError })
    t.is(error?.code, 'Timeout', 'the frame should be dropped before the RPC layer, leaving nothing to answer')
    t.is(plant.setpoint, 0, 'an unsigned command reached the exposed method')

    await client.close()
    await server.close()
})

test('a peer holding its own valid key cannot sign as another peer', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/sign-impersonate'
    const keys = makeKeyring({ 'hmi-im': ['operator'], 'srv-im': ['server'], 'rogue-im': ['operator'] })
    const server = signedServer('srv-im', prefix, keys)
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')
    const rejected: unknown[] = []
    server.transports[0].on('rejected', (info: unknown) => rejected.push(info))

    // 'rogue-im' holds a key the server trusts, and signs a frame claiming to be 'hmi-im'.
    const rogue = await connectAsync(BROKER_URL)
    const frame = await forgeFrame(
        keys.signerFor('rogue-im'),
        { source: 'hmi-im', target: 'srv-im', time: Date.now(), seq: 0, nonce: createNonce() },
        { id: 'forged-1', type: RpcMessageType.CallInstanceMethod, path: 'plant', method: 'writeSetpoint', params: [9999] }
    )
    await rogue.publishAsync(`${prefix}/rpc/srv-im`, frame, { qos: 1 })
    await new Promise((resolve) => setTimeout(resolve, 500))

    t.is(plant.setpoint, 0, 'a forged command was executed')
    t.true(rejected.length >= 1, 'the forged frame was not reported as rejected')

    await rogue.endAsync()
    await server.close()
})

test('a captured frame cannot be replayed', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/sign-replay'
    const keys = makeKeyring({ 'hmi-rp': ['operator'], 'srv-rp': ['server'] })
    const server = signedServer('srv-rp', prefix, keys)
    await server.ready()
    let calls = 0
    class Counter {
        async bump() {
            calls++
            return calls
        }
    }
    server.exposeClassInstance(new Counter(), 'counter')

    // A genuine, correctly signed frame from hmi-rp, as an attacker would capture it off the wire.
    const attacker = await connectAsync(BROKER_URL)
    const frame = await forgeFrame(
        keys.signerFor('hmi-rp'),
        { source: 'hmi-rp', target: 'srv-rp', time: Date.now(), seq: 0, nonce: createNonce() },
        { id: 'replay-1', type: RpcMessageType.CallInstanceMethod, path: 'counter', method: 'bump', params: [] }
    )

    await attacker.publishAsync(`${prefix}/rpc/srv-rp`, frame, { qos: 1 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.is(calls, 1, 'the genuine frame was not accepted')

    // Byte for byte the same frame again: the signature is still valid, the nonce is not.
    await attacker.publishAsync(`${prefix}/rpc/srv-rp`, frame, { qos: 1 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.is(calls, 1, 'a replayed frame ran the method again')

    await attacker.endAsync()
    await server.close()
})
