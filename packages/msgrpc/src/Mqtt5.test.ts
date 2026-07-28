import anyTest, { TestFn } from 'ava'
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

const props = (packet: { properties?: Record<string, unknown> }) => packet.properties ?? {}
const userProp = (packet: { properties?: { userProperties?: Record<string, string | string[]> } }, key: string) => {
    const value = packet.properties?.userProperties?.[key]
    return Array.isArray(value) ? value[0] : value
}

test('a plain MQTT 5 client with no msgrpc code can serve an msgrpc call', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/interop-serve'

    // ---- the whole third-party responder, in vanilla mqtt.js ----
    const device: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await device.subscribeAsync(`${prefix}/req/legacyDevice`, { qos: 1 })
    device.on('message', (topic, payload, packet) => {
        const p = props(packet) as { responseTopic?: string; correlationData?: Buffer; contentType?: string }
        const args = msgPackDecode(payload) as number[]
        const result = userProp(packet, 'mr-method') === 'read' ? args[0] * 2 : null
        void device.publishAsync(p.responseTopic!, Buffer.from(msgPackEncode(result)), {
            qos: 1,
            properties: {
                correlationData: p.correlationData,
                contentType: p.contentType,
                userProperties: { 'mr-v': '1', 'mr-src': 'legacyDevice', 'mr-kind': 'result' }
            }
        })
    })
    // ---- end of third-party code ----

    const client = new RpcClient(undefined, {
        name: 'hmi-interop-1',
        defaultTarget: 'legacyDevice',
        transport: new MqttTransport('hmi-interop-1', BROKER_URL, { prefix })
    })
    await client.ready()
    const sensor = await client.proxy<{ read: (n: number) => Promise<number> }>('sensor')

    t.is(await sensor.remote!.read(21), 42)

    await client.close()
    await device.endAsync()
})

test('a plain MQTT 5 client can call an msgrpc server', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/interop-call'
    class Plant {
        async writeSetpoint(value: number) {
            return value + 1
        }
    }
    const server = new RpcServer({ name: 'plantServer', transports: [{ brokerurl: BROKER_URL, prefix }] })
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
    await tool.publishAsync(`${prefix}/req/plantServer`, Buffer.from(msgPackEncode([1199])), {
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
    const prefix = 'msgrpc/interop-error'
    class Thing {
        async boom(): Promise<never> {
            throw new Error('deliberate failure')
        }
    }
    const server = new RpcServer({ name: 'errServer', transports: [{ brokerurl: BROKER_URL, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Thing(), 'thing')

    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(`${prefix}/rsp/errtool`, { qos: 1 })
    const reply = new Promise<{ kind?: string; code?: string; body: unknown }>((resolve) => {
        tool.on('message', (topic, payload, packet) =>
            resolve({ kind: userProp(packet, 'mr-kind'), code: userProp(packet, 'mr-code'), body: msgPackDecode(payload) })
        )
    })
    await tool.publishAsync(`${prefix}/req/errServer`, Buffer.from(msgPackEncode([])), {
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

test('a frame repeating a control property is rejected', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/interop-dup'
    let calls = 0
    class Counter {
        async bump() {
            calls++
            return calls
        }
    }
    const server = new RpcServer({ name: 'dupServer', transports: [{ brokerurl: BROKER_URL, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')
    const rejected: unknown[] = []
    server.transports[0].on('rejected', (info: unknown) => rejected.push(info))

    // MQTT permits a user property to repeat. Taking the first or the last would let an attacker
    // show one value to a check and another to the dispatcher.
    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.publishAsync(`${prefix}/req/dupServer`, Buffer.from(msgPackEncode([])), {
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
    const prefix = 'msgrpc/interop-json'
    class Plant {
        async double(v: number) {
            return v * 2
        }
    }
    // The server's own codec is msgpack; the caller's contentType has to win for the reply.
    const server = new RpcServer({ name: 'jsonServer', transports: [{ brokerurl: BROKER_URL, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const tool: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    await tool.subscribeAsync(`${prefix}/rsp/jsontool`, { qos: 1 })
    const reply = new Promise<{ contentType?: string; raw: string }>((resolve) => {
        tool.on('message', (topic, payload, packet) =>
            resolve({ contentType: (props(packet) as { contentType?: string }).contentType, raw: payload.toString('utf8') })
        )
    })
    await tool.publishAsync(`${prefix}/req/jsonServer`, Buffer.from(JSON.stringify([21]), 'utf8'), {
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

// ------------------------------------------------------------------ signing over the v5 layout

const SIGN_SECRETS: { [peer: string]: string } = { 'hmi-v5': 'hmi-v5-secret', 'srv-v5': 'srv-v5-secret', 'rogue-v5': 'rogue-v5-secret' }
const v5Verifier = createHmacVerifier(
    (peer) => SIGN_SECRETS[peer],
    (peer) => ({ name: peer, roles: ['operator'] })
)

/** Builds the exact MQTT 5 packet a signing peer would publish, so a test can forge or replay one. */
const publishSignedV5 = async (
    client: MqttClient,
    opts: { topic: string; source: string; signAs: string; kind: string; path?: string; method?: string; correlation: string; body: unknown; nonce?: string; timestamp?: number }
) => {
    const body = new Uint8Array(msgPackEncode(opts.body))
    const nonce = opts.nonce ?? createNonce()
    const timestamp = opts.timestamp ?? Date.now()
    const canonical = canonicalSignedBytesV5({
        version: FRAME_VERSION,
        topic: opts.topic,
        source: opts.source,
        kind: opts.kind,
        path: opts.path ?? '',
        methodOrEvent: opts.method ?? '',
        correlation: opts.correlation,
        timestamp,
        nonce,
        payload: body
    })
    const signature = await createHmacSigner(SIGN_SECRETS[opts.signAs])(canonical, { source: opts.source })
    await client.publishAsync(opts.topic, Buffer.from(body), {
        qos: 1,
        properties: {
            responseTopic: `msgrpc/v5sign/rsp/${opts.source}`,
            correlationData: Buffer.from(opts.correlation),
            contentType: 'application/msgpack',
            userProperties: {
                [MR.version]: FRAME_VERSION,
                [MR.source]: opts.source,
                [MR.kind]: opts.kind,
                ...(opts.path ? { [MR.path]: opts.path } : {}),
                ...(opts.method ? { [MR.method]: opts.method } : {}),
                [MR.nonce]: nonce,
                [MR.timestamp]: String(timestamp),
                [MR.signature]: signature
            }
        }
    })
}

test('a signed MQTT 5 call is accepted and gives the peer an identity', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/v5sign-ok'
    class Plant {
        async write(v: number) {
            return v
        }
    }
    const seen: (string | undefined)[] = []
    const server = new RpcServer({
        name: 'srv-v5',
        transports: [{ brokerurl: BROKER_URL, prefix, sign: createHmacSigner(SIGN_SECRETS['srv-v5']), verify: v5Verifier }],
        requireAuthenticatedPeers: true,
        authorize: ({ identity }) => {
            seen.push(identity?.name)
            return true
        }
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const client = new RpcClient(undefined, {
        name: 'hmi-v5',
        defaultTarget: 'srv-v5',
        transport: new MqttTransport('hmi-v5', BROKER_URL, { prefix, sign: createHmacSigner(SIGN_SECRETS['hmi-v5']), verify: v5Verifier })
    })
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote!.write(5), 5)
    t.deepEqual(seen, ['hmi-v5'])

    await client.close()
    await server.close()
})

test('an MQTT 5 frame signed by the wrong key cannot claim another peer', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/v5sign-forge'
    let calls = 0
    class Counter {
        async bump() {
            calls++
        }
    }
    const server = new RpcServer({
        name: 'srv-forge',
        transports: [{ brokerurl: BROKER_URL, prefix, sign: createHmacSigner('srv-forge-secret'), verify: v5Verifier }]
    })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')
    const rejected: unknown[] = []
    server.transports[0].on('rejected', (info: unknown) => rejected.push(info))

    const rogue: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    // Signed with rogue-v5's key, but claiming to be hmi-v5.
    await publishSignedV5(rogue, {
        topic: `${prefix}/req/srv-forge`,
        source: 'hmi-v5',
        signAs: 'rogue-v5',
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
    const prefix = 'msgrpc/v5sign-replay'
    let calls = 0
    class Counter {
        async bump() {
            calls++
        }
    }
    const server = new RpcServer({
        name: 'srv-replay',
        transports: [{ brokerurl: BROKER_URL, prefix, sign: createHmacSigner('srv-replay-secret'), verify: v5Verifier }]
    })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')

    const attacker: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    // One genuine, correctly signed frame - then the identical packet a second time.
    const frame = {
        topic: `${prefix}/req/srv-replay`,
        source: 'hmi-v5',
        signAs: 'hmi-v5',
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
    const prefix = 'msgrpc/v5-shared'
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
            name: 'replicaSrv',
            transports: [{ brokerurl: BROKER_URL, prefix, sharedGroup: 'workers', replicaId: id }]
        })
        server.exposeClassInstance(new Work(id), 'work')
        return server
    })
    for (const replica of replicas) await replica.ready()

    const client = new RpcClient(undefined, {
        name: 'shared-client',
        defaultTarget: 'replicaSrv',
        transport: new MqttTransport('shared-client', BROKER_URL, { prefix })
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
    const prefix = 'msgrpc/v5-shared-presence'
    // One replica stopping must not publish 'offline' for a name its siblings still serve.
    const observer: MqttClient = await connectAsync(BROKER_URL, { protocolVersion: 5 })
    const presence: string[] = []
    observer.on('message', (topic, payload) => presence.push(`${topic}=${payload.toString()}`))
    await observer.subscribeAsync(`${prefix}/presence/#`)

    const replica = new RpcServer({
        name: 'quietSrv',
        transports: [{ brokerurl: BROKER_URL, prefix, sharedGroup: 'workers', replicaId: 'solo' }]
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
    const prefix = 'msgrpc/v5-session'
    const handled: unknown[] = []
    class Recorder {
        async record(value: unknown) {
            handled.push(value)
            return true
        }
    }
    const start = async () => {
        const server = new RpcServer({ name: 'sessionSrv', transports: [{ brokerurl: BROKER_URL, prefix }] })
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
    await caller.publishAsync(`${prefix}/req/sessionSrv`, Buffer.from(msgPackEncode(['while-down'])), {
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
})
