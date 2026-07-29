import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync, MqttClient } from 'mqtt'
import { decode as msgPackDecode, encode as msgPackEncode } from '@msgpack/msgpack'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import type { MqttTransport as MqttTransportType } from './Transports/MqttTransport.js'
import { canonicalSignedBytesV5, createHmacSigner, createHmacVerifier, createNonce } from './RPC/Signing.js'
import { FRAME_VERSION, MR } from './Transports/Mqtt5Frame.js'

/**
 * The point of the MQTT 5 frame layout is that a peer needs no msgrpc code to take part: response
 * topic and correlation data come from the protocol, and the rest is readable user properties.
 * These tests use vanilla mqtt.js on one side to prove that, rather than asserting msgrpc can talk
 * to itself.
 */
const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

/**
 * Test peers get a short session expiry. Names are unique per run, so the broker's hour-long default
 * would leave a fresh session behind on every run until it refused new connections.
 */
const TEST_SESSION_EXPIRY = 10

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
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

/**
 * A peer name is the MQTT client id, and a server keeps a persistent session, so two runs sharing a
 * name make the broker resume the first one's session and deliver its queued frames into the
 * second. Prefixes are per-run for the same reason: presence under them is retained.
 */
const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const prefixFor = (name: string) => `msgrpc/${name}-${run}`

const props = (packet: { properties?: Record<string, unknown> }) => packet.properties ?? {}
const userProp = (packet: { properties?: { userProperties?: Record<string, string | string[]> } }, key: string) => {
    const value = packet.properties?.userProperties?.[key]
    return Array.isArray(value) ? value[0] : value
}

test('a plain MQTT 5 client with no msgrpc code can serve an msgrpc call', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-serve')

    // ---- the whole third-party responder, in vanilla mqtt.js ----
    const device: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await device.subscribeAsync(`${prefix}/req/${peer('legacyDevice')}`, { qos: 1 })
    device.on('message', (topic, payload, packet) => {
        const p = props(packet) as { responseTopic?: string; correlationData?: Buffer; contentType?: string }
        const args = msgPackDecode(payload) as number[]
        const result = userProp(packet, 'mr-method') === 'read' ? args[0] * 2 : null
        void device.publishAsync(p.responseTopic!, Buffer.from(msgPackEncode(result)), {
            qos: 1,
            properties: {
                correlationData: p.correlationData,
                contentType: p.contentType,
                userProperties: { 'mr-v': '1', 'mr-src': peer('legacyDevice'), 'mr-kind': 'result' }
            }
        })
    })
    // ---- end of third-party code ----

    const client = new RpcClient(undefined, {
        name: peer('hmi-interop-1'),
        defaultTarget: peer('legacyDevice'),
        transport: new MqttTransport(peer('hmi-interop-1'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY })
    })
    await client.ready()
    const sensor = await client.proxy<{ read: (n: number) => Promise<number> }>('sensor')

    t.is(await sensor.remote!.read(21), 42)

    await client.close()
    await device.endAsync()
})

test('a plain MQTT 5 client can call an msgrpc server', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-call')
    class Plant {
        async writeSetpoint(value: number) {
            return value + 1
        }
    }
    const server = new RpcServer({ name: peer('plantServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    // ---- the whole third-party caller, in vanilla mqtt.js ----
    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(`${prefix}/rsp/toolbox`, { qos: 1 })
    const reply = new Promise<{ value: unknown; kind?: string; corr?: string }>((resolve) => {
        tool.on('message', (topic, payload, packet) => {
            const p = props(packet) as { correlationData?: Buffer }
            resolve({ value: msgPackDecode(payload), kind: userProp(packet, 'mr-kind'), corr: p.correlationData?.toString() })
        })
    })
    await tool.publishAsync(`${prefix}/req/${peer('plantServer')}`, Buffer.from(msgPackEncode([1199])), {
        qos: 1,
        properties: {
            responseTopic: `${prefix}/rsp/toolbox`,
            correlationData: Buffer.from('tool-correlation-1'),
            contentType: 'application/msgpack',
            userProperties: {
                'mr-v': '1',
                'mr-src': 'toolbox',
                'mr-kind': 'call',
                'mr-path': 'plant',
                'mr-method': 'writeSetpoint'
            }
        }
    })
    // ---- end of third-party code ----

    const answer = await reply
    t.is(answer.value, 1200)
    t.is(answer.kind, 'result')
    t.is(answer.corr, 'tool-correlation-1', 'correlation data was not echoed verbatim')

    await tool.endAsync()
    await server.close()
})

test('an error reaches a plain MQTT 5 caller with its code in a user property', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-error')
    class Thing {
        async boom(): Promise<never> {
            throw new Error('deliberate failure')
        }
    }
    const server = new RpcServer({ name: peer('errServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Thing(), 'thing')

    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(`${prefix}/rsp/errtool`, { qos: 1 })
    const reply = new Promise<{ kind?: string; code?: string; body: unknown }>((resolve) => {
        tool.on('message', (topic, payload, packet) =>
            resolve({ kind: userProp(packet, 'mr-kind'), code: userProp(packet, 'mr-code'), body: msgPackDecode(payload) })
        )
    })
    await tool.publishAsync(`${prefix}/req/${peer('errServer')}`, Buffer.from(msgPackEncode([])), {
        qos: 1,
        properties: {
            responseTopic: `${prefix}/rsp/errtool`,
            correlationData: Buffer.from('e1'),
            contentType: 'application/msgpack',
            userProperties: { 'mr-v': '1', 'mr-src': 'errtool', 'mr-kind': 'call', 'mr-path': 'thing', 'mr-method': 'boom' }
        }
    })

    const answer = await reply
    t.is(answer.kind, 'error')
    // Visible without decoding the payload, which is the point of putting it in a property.
    t.is(answer.code, 'Exception')
    t.like(answer.body as object, { message: 'deliberate failure' })

    await tool.endAsync()
    await server.close()
})

test('a caller is answered on the response topic it asked for, not one derived from its name', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-rsp')
    class Plant {
        async read() {
            return 42
        }
    }
    const server = new RpcServer({ name: peer('rspServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    // MQTT 5 says the Response Topic is where the answer goes. This one is deliberately nothing
    // like `<prefix>/rsp/<mr-src>`, which is what the server used to derive and reply to instead -
    // so the earlier code answered into a topic this caller was not listening on.
    const inbox = `${prefix}/rsp/inbox-7c2f`
    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(inbox, { qos: 1 })
    const reply = new Promise<{ topic: string; value: unknown }>((resolve) => {
        tool.on('message', (topic, payload) => resolve({ topic, value: msgPackDecode(payload) }))
    })
    await tool.publishAsync(`${prefix}/req/${peer('rspServer')}`, Buffer.from(msgPackEncode([])), {
        qos: 1,
        properties: {
            responseTopic: inbox,
            correlationData: Buffer.from('rsp-1'),
            contentType: 'application/msgpack',
            userProperties: { 'mr-v': '1', 'mr-src': 'rsptool', 'mr-kind': 'call', 'mr-path': 'plant', 'mr-method': 'read' }
        }
    })

    const answer = await reply
    t.is(answer.topic, inbox, 'the reply did not go to the response topic the request named')
    t.is(answer.value, 42)

    await tool.endAsync()
    await server.close()
})

test('a response topic outside the transport prefix is refused', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-rsp-deny')
    let calls = 0
    class Counter {
        async bump() {
            calls++
            return calls
        }
    }
    const server = new RpcServer({ name: peer('denyServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')
    const rejected: { reason?: string }[] = []
    server.transports[0].on('rejected', (info: { reason?: string }) => rejected.push(info))

    // Honouring the response topic means a caller picks a topic this server then publishes to, so
    // there has to be a boundary. Anything outside the transport's own prefix is refused rather
    // than answered somewhere else, because a caller waiting on a topic it named is not helped by
    // a reply sent elsewhere.
    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.publishAsync(`${prefix}/req/${peer('denyServer')}`, Buffer.from(msgPackEncode([])), {
        qos: 1,
        properties: {
            responseTopic: '$SYS/broker/somewhere',
            correlationData: Buffer.from('deny-1'),
            contentType: 'application/msgpack',
            userProperties: { 'mr-v': '1', 'mr-src': 'denytool', 'mr-kind': 'call', 'mr-path': 'counter', 'mr-method': 'bump' }
        }
    })
    await new Promise((resolve) => setTimeout(resolve, 600))

    t.is(calls, 0, 'a request naming an out-of-bounds response topic was executed')
    t.true(
        rejected.some((info) => /response topic/.test(info.reason ?? '')),
        `the refusal was not reported: ${JSON.stringify(rejected)}`
    )

    await tool.endAsync()
    await server.close()
})

test("a request carries its caller's remaining time, and the broker is given the same deadline", async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5-ttl')
    class Plant {
        async read() {
            return 1
        }
    }
    const server = new RpcServer({ name: peer('ttlServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    // Watching the request go past, the way an operator with MQTT Explorer would.
    const watcher: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    const seen = new Promise<{ ttl?: string; expiry?: number }>((resolve) => {
        watcher.on('message', (topic, payload, packet) =>
            resolve({ ttl: userProp(packet, MR.ttl), expiry: (props(packet) as { messageExpiryInterval?: number }).messageExpiryInterval })
        )
    })
    await watcher.subscribeAsync(`${prefix}/req/${peer('ttlServer')}`, { qos: 1 })

    const client = new RpcClient(undefined, {
        name: peer('ttl-client'),
        defaultTarget: peer('ttlServer'),
        callTimeout: 4000,
        transport: new MqttTransport(peer('ttl-client'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY })
    })
    await client.ready()
    t.is(await (await client.proxy<Plant>('plant')).remote!.read(), 1)

    const request = await seen
    t.is(request.ttl, '4000', 'the request did not state what its caller would wait')
    // The two used to be independent: a caller giving up after ten seconds published a request the
    // broker held for thirty, so it could be delivered and executed twenty seconds after the
    // operator had already been told the call failed.
    t.is(request.expiry, 4, "the broker was not given the caller's deadline")

    await watcher.endAsync()
    await client.close()
    await server.close()
})

test('a frame repeating a control property is rejected', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-dup')
    let calls = 0
    class Counter {
        async bump() {
            calls++
            return calls
        }
    }
    const server = new RpcServer({ name: peer('dupServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')
    const rejected: unknown[] = []
    server.transports[0].on('rejected', (info: unknown) => rejected.push(info))

    // MQTT permits a user property to repeat. Taking the first or the last would let an attacker
    // show one value to a check and another to the dispatcher.
    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.publishAsync(`${prefix}/req/${peer('dupServer')}`, Buffer.from(msgPackEncode([])), {
        qos: 1,
        properties: {
            responseTopic: `${prefix}/rsp/dup`,
            correlationData: Buffer.from('d1'),
            userProperties: {
                'mr-v': '1',
                'mr-src': 'dup',
                'mr-kind': 'call',
                'mr-path': 'counter',
                'mr-method': ['bump', 'bump']
            }
        }
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    t.is(calls, 0, 'a frame with a duplicated control property was dispatched')
    t.true(rejected.length >= 1)

    await tool.endAsync()
    await server.close()
})

test('a JSON-speaking caller is answered in JSON', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('interop-json')
    class Plant {
        async double(v: number) {
            return v * 2
        }
    }
    // The server's own codec is msgpack; the caller's contentType has to win for the reply.
    const server = new RpcServer({ name: peer('jsonServer'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(`${prefix}/rsp/jsontool`, { qos: 1 })
    const reply = new Promise<{ contentType?: string; raw: string }>((resolve) => {
        tool.on('message', (topic, payload, packet) =>
            resolve({ contentType: (props(packet) as { contentType?: string }).contentType, raw: payload.toString('utf8') })
        )
    })
    await tool.publishAsync(`${prefix}/req/${peer('jsonServer')}`, Buffer.from(JSON.stringify([21]), 'utf8'), {
        qos: 1,
        properties: {
            responseTopic: `${prefix}/rsp/jsontool`,
            correlationData: Buffer.from('json-1'),
            contentType: 'application/json',
            userProperties: { 'mr-v': '1', 'mr-src': 'jsontool', 'mr-kind': 'call', 'mr-path': 'plant', 'mr-method': 'double' }
        }
    })

    const answer = await reply
    t.is(answer.contentType, 'application/json', 'the reply did not mirror the request encoding')
    t.is(JSON.parse(answer.raw), 42)

    await tool.endAsync()
    await server.close()
})

/** Polls until a condition holds, so a test waits for delivery rather than for a fixed guess. */
const until = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('until timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

// ------------------------------------------------------------------ signing over the v5 layout

// A peer name is the MQTT client id, so two tests sharing one evict each other when ava runs them
// concurrently - the very collision this transport warns about. Each signing test gets its own pair.
const SIGN_SECRETS: { [peer: string]: string } = Object.fromEntries(
    ['hmi-v5', 'srv-v5', 'rogue-v5', 'hmi-ct', 'srv-ct', 'hmi-ct2', 'srv-ct2', 'hmi-code', 'srv-code', 'hmi-rt', 'srv-rt', 'hmi-ttl', 'srv-ttl'].map((name) => [
        peer(name),
        `${name}-secret`
    ])
)
const v5Verifier = createHmacVerifier(
    (peer) => SIGN_SECRETS[peer],
    (peer) => ({ name: peer, roles: ['operator'] })
)

/** Builds the exact MQTT 5 packet a signing peer would publish, so a test can forge or replay one. */
const publishSignedV5 = async (
    client: MqttClient,
    opts: {
        topic: string
        source: string
        signAs: string
        kind: string
        path?: string
        method?: string
        correlation: string
        body: unknown
        nonce?: string
        timestamp?: number
        /** Raw bytes to publish instead of encoding `body`, for the content-type forgery below. */
        rawBody?: Uint8Array
        /** What the signature covers. */
        contentType?: string
        /** What the packet actually declares - differing from `contentType` is the forgery. */
        sentContentType?: string
        code?: string
        sentCode?: string
        /** What the signature covers. Defaults to this peer's own reply topic under the prefix. */
        responseTopic?: string
        /** What the packet actually asks for, when that is meant to differ from what was signed. */
        sentResponseTopic?: string
        ttl?: number
        sentTtl?: number
        idempotencyKey?: string
        sentIdempotencyKey?: string
    }
) => {
    const body = opts.rawBody ?? new Uint8Array(msgPackEncode(opts.body))
    const nonce = opts.nonce ?? createNonce()
    const timestamp = opts.timestamp ?? Date.now()
    const contentType = opts.contentType ?? 'application/msgpack'
    // Derived from the request topic, which carries the prefix: a response topic outside it is
    // refused, and the reply would go somewhere nothing is listening anyway.
    const responseTopic = opts.responseTopic ?? `${opts.topic.split('/').slice(0, -2).join('/')}/rsp/${opts.source}`
    const ttl = opts.ttl !== undefined ? String(opts.ttl) : ''
    const canonical = canonicalSignedBytesV5({
        version: FRAME_VERSION,
        topic: opts.topic,
        responseTopic,
        source: opts.source,
        kind: opts.kind,
        path: opts.path ?? '',
        methodOrEvent: opts.method ?? '',
        correlation: opts.correlation,
        contentType,
        code: opts.code ?? '',
        contractVersion: '',
        ttl,
        idempotencyKey: opts.idempotencyKey ?? '',
        timestamp,
        nonce,
        payload: body
    })
    const signature = await createHmacSigner(SIGN_SECRETS[opts.signAs])(canonical, { source: opts.source })
    const sentTtl = opts.sentTtl ?? opts.ttl
    await client.publishAsync(opts.topic, Buffer.from(body), {
        qos: 1,
        properties: {
            responseTopic: opts.sentResponseTopic ?? responseTopic,
            correlationData: Buffer.from(opts.correlation),
            contentType: opts.sentContentType ?? contentType,
            userProperties: {
                [MR.version]: FRAME_VERSION,
                [MR.source]: opts.source,
                [MR.kind]: opts.kind,
                ...(opts.path ? { [MR.path]: opts.path } : {}),
                ...(opts.method ? { [MR.method]: opts.method } : {}),
                ...(opts.sentCode ?? opts.code ? { [MR.code]: (opts.sentCode ?? opts.code)! } : {}),
                ...(sentTtl !== undefined ? { [MR.ttl]: String(sentTtl) } : {}),
                ...((opts.sentIdempotencyKey ?? opts.idempotencyKey) ? { [MR.idempotencyKey]: (opts.sentIdempotencyKey ?? opts.idempotencyKey)! } : {}),
                [MR.nonce]: nonce,
                [MR.timestamp]: String(timestamp),
                [MR.signature]: signature
            }
        }
    })
}

test('a signed MQTT 5 call is accepted and gives the peer an identity', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-ok')
    class Plant {
        async write(v: number) {
            return v
        }
    }
    const seen: (string | undefined)[] = []
    const server = new RpcServer({
        name: peer('srv-v5'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-v5')]), verify: v5Verifier }],
        requireAuthenticatedPeers: true,
        authorize: ({ identity }) => {
            seen.push(identity?.name)
            return true
        }
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const client = new RpcClient(undefined, {
        name: peer('hmi-v5'),
        defaultTarget: peer('srv-v5'),
        transport: new MqttTransport(peer('hmi-v5'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY, sign: createHmacSigner(SIGN_SECRETS[peer('hmi-v5')]), verify: v5Verifier })
    })
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote!.write(5), 5)
    t.deepEqual(seen, [peer('hmi-v5')])

    await client.close()
    await server.close()
})

test('an MQTT 5 frame signed by the wrong key cannot claim another peer', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-forge')
    let calls = 0
    class Counter {
        async bump() {
            calls++
        }
    }
    const server = new RpcServer({
        name: peer('srv-forge'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner('srv-forge-secret'), verify: v5Verifier }]
    })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')
    const rejected: unknown[] = []
    server.transports[0].on('rejected', (info: unknown) => rejected.push(info))

    const rogue: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    // Signed with rogue-v5's key, but claiming to be hmi-v5.
    await publishSignedV5(rogue, {
        topic: `${prefix}/req/${peer('srv-forge')}`,
        source: peer('hmi-v5'),
        signAs: peer('rogue-v5'),
        kind: 'call',
        path: 'counter',
        method: 'bump',
        correlation: 'forge-1',
        body: []
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    t.is(calls, 0, 'a forged MQTT 5 frame was executed')
    t.true(rejected.length >= 1, 'the forged frame was not reported as rejected')

    await rogue.endAsync()
    await server.close()
})

test('a captured MQTT 5 frame cannot be replayed', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-replay')
    let calls = 0
    class Counter {
        async bump() {
            calls++
        }
    }
    const server = new RpcServer({
        name: peer('srv-replay'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner('srv-replay-secret'), verify: v5Verifier }]
    })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')

    const attacker: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    // One genuine, correctly signed frame - then the identical packet a second time.
    const frame = {
        topic: `${prefix}/req/${peer('srv-replay')}`,
        source: peer('hmi-v5'),
        signAs: peer('hmi-v5'),
        kind: 'call',
        path: 'counter',
        method: 'bump',
        correlation: 'replay-1',
        body: [],
        nonce: createNonce(),
        timestamp: Date.now()
    }
    await publishSignedV5(attacker, frame)
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.is(calls, 1, 'the genuine frame was not accepted')

    await publishSignedV5(attacker, frame)
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.is(calls, 1, 'a replayed MQTT 5 frame ran the method again')

    await attacker.endAsync()
    await server.close()
})

// ------------------------------------------------------------------ replicas and sessions

test('a shared subscription distributes requests across replicas', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5-shared')
    const handled: string[] = []
    class Work {
        constructor(public replica: string) {}
        async run() {
            handled.push(this.replica)
            return this.replica
        }
    }
    // Two processes serving one peer name. Each needs its own broker connection, which is what
    // replicaId is for: a broker permits one connection per client id.
    const replicas = ['a', 'b'].map((id) => {
        const server = new RpcServer({
            name: peer('replicaSrv'),
            transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sharedGroup: 'workers', replicaId: id }]
        })
        server.exposeClassInstance(new Work(id), 'work')
        return server
    })
    for (const replica of replicas) await replica.ready()

    const client = new RpcClient(undefined, {
        name: peer('shared-client'),
        defaultTarget: peer('replicaSrv'),
        transport: new MqttTransport(peer('shared-client'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY })
    })
    await client.ready()
    const work = await client.proxy<Work>('work')
    for (let i = 0; i < 12; i++) await work.remote!.run()

    t.is(handled.length, 12, 'not every request was answered')
    t.is(new Set(handled).size, 2, `both replicas should have taken work, got ${JSON.stringify(handled)}`)

    await client.close()
    for (const replica of replicas) await replica.close()
})

test('a replica does not announce presence for the whole group', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5-shared-presence')
    // One replica stopping must not publish 'offline' for a name its siblings still serve.
    const observer: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    const presence: string[] = []
    observer.on('message', (topic, payload) => presence.push(`${topic}=${payload.toString()}`))
    await observer.subscribeAsync(`${prefix}/presence/#`)

    const replica = new RpcServer({
        name: peer('quietSrv'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sharedGroup: 'workers', replicaId: 'solo' }]
    })
    await replica.ready()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await replica.close()
    await new Promise((resolve) => setTimeout(resolve, 300))

    t.deepEqual(presence, [], `a replica announced presence: ${JSON.stringify(presence)}`)

    await observer.endAsync()
})

test('a persistent session delivers a request published while the server was down', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5-session')
    const handled: unknown[] = []
    class Recorder {
        async record(value: unknown) {
            handled.push(value)
            return true
        }
    }
    const start = async () => {
        const server = new RpcServer({ name: peer('sessionSrv'), transports: [{ brokerurl: BROKER_URL, prefix }] })
        // Exposed before awaiting ready(): a resumed session is handed its queued requests the
        // moment it connects, so anything registered afterwards is registered too late and those
        // requests come back ClassNotFound.
        server.exposeClassInstance(new Recorder(), 'recorder')
        await server.ready()
        return server
    }

    // First run establishes the session; the broker remembers the subscription against the client id.
    const first = await start()
    t.is((first.transports[0] as MqttTransportType).sessionExpirySeconds, 3600, 'a server should keep its session across a restart')
    await first.close()

    // Published to a server that is not running. QoS 1 into a retained session means it queues.
    const caller: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await caller.publishAsync(`${prefix}/req/${peer('sessionSrv')}`, Buffer.from(msgPackEncode(['while-down'])), {
        qos: 1,
        properties: {
            responseTopic: `${prefix}/rsp/caller`,
            correlationData: Buffer.from('sess-1'),
            contentType: 'application/msgpack',
            userProperties: { 'mr-v': '1', 'mr-src': 'caller', 'mr-kind': 'call', 'mr-path': 'recorder', 'mr-method': 'record' }
        }
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const second = await start()
    await new Promise((resolve) => setTimeout(resolve, 600))

    t.deepEqual(handled, ['while-down'], 'the queued request was lost across the restart')

    await caller.endAsync()
    await second.close()

    // The one place a test keeps the hour-long default, so the one place that has to clean up after
    // itself: connecting with the same client id and a clean start discards the stored session.
    const sweep = await connectAsync(BROKER_URL, { clientId: `msgrpc-${peer('sessionSrv')}`, clean: true, protocolVersion: 5, reconnectPeriod: 0 })
    await sweep.endAsync()
})

test('a second peer under one name takes the broker session, and the displaced one says so', async (t) => {
    if (skipWithoutBroker(t)) return
    // The MQTT half of the socket.io displacement warning. Nothing here detects the collision
    // itself: the clientId is derived from the peer name, so the broker hands the session over and
    // tells the incumbent why with reason code 0x8E. Reported from the other end than socket.io -
    // there is no server in the middle, so it is the displaced peer that finds out.
    const name = peer('twin5')
    const prefix = prefixFor('twin5')
    const options = { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }

    const incumbent = new RpcServer({ name, transports: [new MqttTransport(name, BROKER_URL, options)] })
    await incumbent.ready()
    const displaced: string[] = []
    incumbent.transports[0].on('peerDisplaced', (peer: string) => displaced.push(peer))

    const newcomer = new RpcServer({ name, transports: [new MqttTransport(name, BROKER_URL, options)] })
    await newcomer.ready()

    const deadline = Date.now() + 8000
    while (!displaced.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    t.deepEqual(displaced, [name], 'the displaced peer should be told its session was claimed')

    await newcomer.close()
    await incumbent.close()
    // Both used one clientId, so the loser's session is the one still on the broker. Sweep it.
    const sweep = await connectAsync(BROKER_URL, { clientId: `msgrpc-${name}`, clean: true, protocolVersion: 5 })
    await sweep.endAsync()
})

test('changing the content type of a signed frame no longer changes what it says', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-ct')
    const asked: number[] = []
    class Plant {
        async write(v: number) {
            asked.push(v)
            return v
        }
    }
    const server = new RpcServer({
        name: peer('srv-ct'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-ct')]), verify: v5Verifier }],
        requireAuthenticatedPeers: true
    })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    const client = await connectAsync(BROKER_URL, { protocolVersion: 5 })

    // One byte, two meanings. 0x31 is the JSON text "1", which is the number 1; the same byte is a
    // MsgPack positive fixint, which is 49. Frame version 1 left contentType out of the signature
    // on the reasoning that it could only make a payload fail to parse - but both of these parse,
    // so flipping one unsigned property turned a signed `write(1)` into a signed `write(49)`.
    const oneByte = Uint8Array.from([0x31])
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-ct')}`,
        source: peer('hmi-ct'),
        signAs: peer('hmi-ct'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'ct-1',
        body: undefined,
        rawBody: oneByte,
        // Signed as JSON, sent as msgpack: the signature still covers the bytes, and under version 1
        // it still verified.
        contentType: 'application/json',
        sentContentType: 'application/msgpack'
    })

    await new Promise((resolve) => setTimeout(resolve, 700))
    t.deepEqual(asked, [], 'a frame whose content type was altered after signing must not run the method')

    // The same call, untampered, does run - so the rejection above is about the tampering and not
    // about the frame being unusable.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-ct')}`,
        source: peer('hmi-ct'),
        signAs: peer('hmi-ct'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'ct-2',
        body: undefined,
        rawBody: oneByte,
        contentType: 'application/json',
        sentContentType: 'application/json'
    })
    await until(() => asked.length > 0)
    t.deepEqual(asked, [1], 'signed as JSON and sent as JSON is the number 1')

    await client.endAsync()
    await server.close()
})

test('an unknown content type is refused rather than guessed at', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-ct2')
    const asked: number[] = []
    class Plant {
        async write(v: number) {
            asked.push(v)
            return v
        }
    }
    const server = new RpcServer({
        name: peer('srv-ct2'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-ct2')]), verify: v5Verifier }],
        requireAuthenticatedPeers: true
    })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    const client = await connectAsync(BROKER_URL, { protocolVersion: 5 })

    // It used to fall back to msgpack, which is a guess about how to read somebody else's bytes -
    // and the guess decides what the values mean.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-ct2')}`,
        source: peer('hmi-ct2'),
        signAs: peer('hmi-ct2'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'ct-3',
        body: 7,
        contentType: 'application/x-invented'
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    t.deepEqual(asked, [])

    await client.endAsync()
    await server.close()
})

test('the error code and the declared contract version are covered by the signature', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-code')
    const asked: number[] = []
    class Plant {
        async write(v: number) {
            asked.push(v)
            return v
        }
    }
    const server = new RpcServer({
        name: peer('srv-code'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-code')]), verify: v5Verifier }],
        requireAuthenticatedPeers: true
    })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    const client = await connectAsync(BROKER_URL, { protocolVersion: 5 })

    // Signed with no code, sent carrying one. The code is what a caller acts on when a call fails,
    // so a broker able to add or change it could turn "refused" into "unauthorised" and back.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-code')}`,
        source: peer('hmi-code'),
        signAs: peer('hmi-code'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'code-1',
        body: 3,
        sentCode: 'Unauthorized'
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    t.deepEqual(asked, [], 'a frame whose code was added after signing must not be acted on')

    await client.endAsync()
    await server.close()
})

test('the response topic cannot be redirected after signing', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-rt')
    const asked: number[] = []
    class Plant {
        async write(v: number) {
            asked.push(v)
            return v
        }
    }
    const server = new RpcServer({
        name: peer('srv-rt'),
        transports: [
            { brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-rt')]), verify: v5Verifier }
        ],
        requireAuthenticatedPeers: true
    })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    const client = await connectAsync(BROKER_URL, { protocolVersion: 5 })

    // Now that the response topic is honoured, it decides where the answer is published - so
    // anything able to rewrite it in flight could have this server deliver a reply to a topic of
    // its own choosing. Both topics here pass the prefix rule, which is what makes this about the
    // signature rather than about the policy.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-rt')}`,
        source: peer('hmi-rt'),
        signAs: peer('hmi-rt'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'rt-1',
        body: 11,
        responseTopic: `${prefix}/rsp/${peer('hmi-rt')}`,
        sentResponseTopic: `${prefix}/rsp/eavesdropper`
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    t.deepEqual(asked, [], 'a frame whose response topic was changed after signing must not run the method')

    // The same call with the topic it was signed with does run, so the refusal above is about the
    // redirection and not about the frame.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-rt')}`,
        source: peer('hmi-rt'),
        signAs: peer('hmi-rt'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'rt-2',
        body: 11,
        responseTopic: `${prefix}/rsp/${peer('hmi-rt')}`
    })
    await until(() => asked.length > 0)
    t.deepEqual(asked, [11])

    await client.endAsync()
    await server.close()
})

test('the stated deadline cannot be extended after signing', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('v5sign-ttl')
    const asked: number[] = []
    class Plant {
        async write(v: number) {
            asked.push(v)
            return v
        }
    }
    const server = new RpcServer({
        name: peer('srv-ttl'),
        transports: [
            { brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix, sign: createHmacSigner(SIGN_SECRETS[peer('srv-ttl')]), verify: v5Verifier }
        ],
        requireAuthenticatedPeers: true
    })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    const client = await connectAsync(BROKER_URL, { protocolVersion: 5 })

    // The ttl is what stops a command running after its caller gave up, so anything able to raise
    // it could buy a stale 'start pump' another hour. Signed as a second, sent as an hour.
    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-ttl')}`,
        source: peer('hmi-ttl'),
        signAs: peer('hmi-ttl'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'ttl-1',
        body: 9,
        ttl: 1000,
        sentTtl: 3600000
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    t.deepEqual(asked, [], 'a frame whose deadline was extended after signing must not run the method')

    await publishSignedV5(client, {
        topic: `${prefix}/req/${peer('srv-ttl')}`,
        source: peer('hmi-ttl'),
        signAs: peer('hmi-ttl'),
        kind: 'call',
        path: 'plant',
        method: 'write',
        correlation: 'ttl-2',
        body: 9,
        ttl: 30000
    })
    await until(() => asked.length > 0)
    t.deepEqual(asked, [9])

    await client.endAsync()
    await server.close()
})
