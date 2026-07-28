import anyTest, { TestFn } from 'ava'
import { connectAsync } from 'mqtt'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import { RpcCallInstanceMethodPayload, RpcMessageType } from './RPC/RpcServerHandler.js'

/**
 * These need a broker on localhost:1883 - docker-compose/ brings up EMQX for it. Tests that do
 * not touch the network run regardless; the rest skip when no broker is reachable.
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

/**
 * Everything a broker keys state on has to be unique per run. A peer name is the MQTT client id,
 * and a server keeps a persistent session, so a second run with the same name resumes the first
 * one's session and is handed its queued frames; a prefix is a topic tree, and presence under it is
 * retained. Sharing either let one run's leftovers arrive in the next, which surfaced as a failure
 * that never reproduced when the file was run on its own.
 */
const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const prefixFor = (name: string) => `msgrpc/${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

class Plant extends EventEmitter {
    constructor(public base = 0) {
        super()
    }
    async add(a: number, b: number) {
        return this.base + a + b
    }
    fire() {
        this.emit('alarm', 'high pressure')
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

// ---------------------------------------------------------------- no broker needed

test('a peer name that would widen its own subscription is rejected', (t) => {
    // '#' as a name previously produced a subscription to <prefix>/#, which is every peer's
    // traffic. These throw during construction, before any connection is opened.
    t.throws(() => new MqttTransport('#', BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('+', BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('plant/sub', BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('', BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY, topic: '#' }), { message: /unsafe topic/ })
    t.throws(() => new MqttTransport('ok', BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix: 'site/#' }), { message: /unsafe topic prefix/ })
})

test('a redelivered request does not run the method twice', async (t) => {
    // QoS 1 is at-least-once, so the same request can arrive again. Driven through the handler
    // directly, which is where the suppression lives.
    let calls = 0
    class Counter {
        async bump() {
            calls++
            return calls
        }
    }
    const server = new RpcServer({ transports: [{ port: 3401 }] })
    await server.ready()
    server.exposeClassInstance(new Counter(), 'counter')

    const request: RpcCallInstanceMethodPayload = { id: 'duplicate-1', type: RpcMessageType.CallInstanceMethod, path: 'counter', method: 'bump', params: [] }
    await server.rpc.receivePayload(request, 'somePeer', server.options.name)
    await server.rpc.receivePayload(request, 'somePeer', server.options.name)
    t.is(calls, 1, 'the redelivered request ran the method a second time')

    const fresh: RpcCallInstanceMethodPayload = { ...request, id: 'duplicate-2' }
    await server.rpc.receivePayload(fresh, 'somePeer', server.options.name)
    t.is(calls, 2, 'a genuinely new request was suppressed')

    await server.close()
})

test('a server whose broker is unreachable gives up instead of hanging', async (t) => {
    // Port 1 refuses. ready() used to wait forever with no diagnostic.
    const server = new RpcServer({ transports: [{ brokerurl: 'mqtt://127.0.0.1:1' }], readyTimeout: 600 })
    await t.throwsAsync(server.ready(), { message: /transports not ready within 600 ms/ })
    await server.close()
})

// ---------------------------------------------------------------- broker needed

test('a call is answered over MQTT', async (t) => {
    if (skipWithoutBroker(t)) return
    const server = new RpcServer({ name: peer('mqttServer1'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    server.exposeClassInstance(new Plant(10), 'plant')

    const client = new RpcClient(undefined, {
        name: peer('mqttClient1'),
        transport: new MqttTransport(peer('mqttClient1'), BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer('mqttServer1')
    })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')

    t.is(await plant.remote?.add(5, 6), 21)

    await client.close()
    await server.close()
})

test('rpc traffic is published per peer, not to a shared topic', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('test-isolation')
    const server = new RpcServer({ name: peer('mqttServer2'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(1), 'plant')

    const observer = await connectAsync(BROKER_URL)
    const topics: string[] = []
    observer.on('message', (topic) => topics.push(topic))
    await observer.subscribeAsync(`${prefix}/#`)

    const client = new RpcClient(undefined, {
        name: peer('mqttClient2'),
        transport: new MqttTransport(peer('mqttClient2'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer('mqttServer2')
    })
    await client.ready()
    await (await client.proxy<Plant>('plant')).remote?.add(1, 1)
    // Counting every message would let the two presence announcements satisfy the wait, and the
    // reply is the message this test is about - so wait for the rpc topics themselves.
    const rpcTopics = () => [...new Set(topics)].filter((topic) => !topic.includes('/presence/')).sort()
    await waitFor(() => rpcTopics().length >= 2)

    // One topic per addressee and per channel: the request to the server, the reply to the client.
    t.deepEqual(rpcTopics(), [`${prefix}/req/${peer('mqttServer2')}`, `${prefix}/rsp/${peer('mqttClient2')}`])

    await observer.endAsync()
    await client.close()
    await server.close()
})

test('a departing peer releases its subscriptions through presence', async (t) => {
    if (skipWithoutBroker(t)) return
    const server = new RpcServer({ name: peer('mqttServer3'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    const client = new RpcClient(undefined, {
        name: peer('mqttClient3'),
        transport: new MqttTransport(peer('mqttClient3'), BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer('mqttServer3')
    })
    await client.ready()
    const proxy = await client.proxy<Plant>('plant')
    await proxy.remote?.on('alarm', () => {})
    t.is(server.rpc.eventProxies.size, 1)

    // MQTT has no connection to the server, so the will and the retained presence topic are what
    // tell it the peer is gone. Without them the subscription would leak forever.
    await client.close()

    await waitFor(() => server.rpc.eventProxies.size === 0)
    t.is(plant.listenerCount('alarm'), 0, 'the exposed instance kept a listener for a peer that left')

    await server.close()
})

test('events reach a subscriber over MQTT', async (t) => {
    if (skipWithoutBroker(t)) return
    const server = new RpcServer({ name: peer('mqttServer4'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    const client = new RpcClient(undefined, {
        name: peer('mqttClient4'),
        transport: new MqttTransport(peer('mqttClient4'), BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer('mqttServer4')
    })
    await client.ready()
    const proxy = await client.proxy<Plant>('plant')
    const received: string[] = []
    await proxy.remote?.on('alarm', (value: string) => received.push(value))

    plant.fire()
    await waitFor(() => received.length === 1)
    t.deepEqual(received, ['high pressure'])

    await client.close()
    await server.close()
})

test('a client built from an mqtt url connects through the on-demand transport', async (t) => {
    if (skipWithoutBroker(t)) return
    // Exercises the dynamic import RpcClient uses so browser bundles need not carry the MQTT client.
    const server = new RpcServer({ name: peer('mqttServer5'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    server.exposeClassInstance(new Plant(3), 'plant')

    const client = new RpcClient(BROKER_URL, { name: peer('mqttClient5'), defaultTarget: peer('mqttServer5') })
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote?.add(1, 1), 5)

    await client.close()
    await server.close()
})

test('one client watching two peers keeps their events apart', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('event-routing')
    const first = new RpcServer({ name: peer('routeA'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    const second = new RpcServer({ name: peer('routeB'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    const plantA = new Plant()
    const plantB = new Plant()
    first.exposeClassInstance(plantA, 'plant')
    second.exposeClassInstance(plantB, 'plant')
    await first.ready()
    await second.ready()

    // One client and one transport across both peers, which is how the console watches a network.
    const client = new RpcClient(undefined, { name: peer('routeWatcher'), transport: new MqttTransport(peer('routeWatcher'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }) })
    await client.ready()
    const fromA: string[] = []
    const fromB: string[] = []
    await (await client.proxy<Plant>('plant', peer('routeA'))).remote!.on('alarm', (value: string) => fromA.push(value))
    await (await client.proxy<Plant>('plant', peer('routeB'))).remote!.on('alarm', (value: string) => fromB.push(value))

    plantA.fire()
    await waitFor(() => fromA.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 300))

    t.is(fromA.length, 1)
    t.deepEqual(fromB, [], "one peer's event reached a subscription taken out on another")

    await client.close()
    await first.close()
    await second.close()
})
