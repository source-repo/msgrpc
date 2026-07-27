import anyTest, { TestFn } from 'ava'
import { connectAsync } from 'mqtt'
import { EventEmitter } from 'events'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import { RpcCallInstanceMethodPayload, RpcMessageType } from './RPC/RpcServerHandler.js'

/**
 * These need a broker on localhost:1883 - docker-compose/ brings up EMQX for it. Tests that do
 * not touch the network run regardless; the rest skip when no broker is reachable.
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
    t.throws(() => new MqttTransport('#', BROKER_URL), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('+', BROKER_URL), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('plant/sub', BROKER_URL), { message: /unsafe peer name/ })
    t.throws(() => new MqttTransport('', BROKER_URL, { topic: '#' }), { message: /unsafe topic/ })
    t.throws(() => new MqttTransport('ok', BROKER_URL, { prefix: 'site/#' }), { message: /unsafe topic prefix/ })
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
    const server = new RpcServer({ name: 'mqttServer1', transports: [{ brokerurl: BROKER_URL }] })
    await server.ready()
    server.exposeClassInstance(new Plant(10), 'plant')

    const client = new RpcClient(undefined, {
        name: 'mqttClient1',
        transport: new MqttTransport('mqttClient1', BROKER_URL),
        defaultTarget: 'mqttServer1'
    })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')

    t.is(await plant.remote?.add(5, 6), 21)

    await client.close()
    await server.close()
})

test('rpc traffic is published per peer, not to a shared topic', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = 'msgrpc/test-isolation'
    const server = new RpcServer({ name: 'mqttServer2', transports: [{ brokerurl: BROKER_URL, prefix }] })
    await server.ready()
    server.exposeClassInstance(new Plant(1), 'plant')

    const observer = await connectAsync(BROKER_URL)
    const topics: string[] = []
    observer.on('message', (topic) => topics.push(topic))
    await observer.subscribeAsync(`${prefix}/rpc/#`)

    const client = new RpcClient(undefined, {
        name: 'mqttClient2',
        transport: new MqttTransport('mqttClient2', BROKER_URL, { prefix }),
        defaultTarget: 'mqttServer2'
    })
    await client.ready()
    await (await client.proxy<Plant>('plant')).remote?.add(1, 1)
    await waitFor(() => topics.length >= 2)

    // One topic per addressee: the request to the server, the reply to the client.
    t.deepEqual([...new Set(topics)].sort(), [`${prefix}/rpc/mqttClient2`, `${prefix}/rpc/mqttServer2`])

    await observer.endAsync()
    await client.close()
    await server.close()
})

test('a departing peer releases its subscriptions through presence', async (t) => {
    if (skipWithoutBroker(t)) return
    const server = new RpcServer({ name: 'mqttServer3', transports: [{ brokerurl: BROKER_URL }] })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    const client = new RpcClient(undefined, {
        name: 'mqttClient3',
        transport: new MqttTransport('mqttClient3', BROKER_URL),
        defaultTarget: 'mqttServer3'
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
    const server = new RpcServer({ name: 'mqttServer4', transports: [{ brokerurl: BROKER_URL }] })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    const client = new RpcClient(undefined, {
        name: 'mqttClient4',
        transport: new MqttTransport('mqttClient4', BROKER_URL),
        defaultTarget: 'mqttServer4'
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
    const server = new RpcServer({ name: 'mqttServer5', transports: [{ brokerurl: BROKER_URL }] })
    await server.ready()
    server.exposeClassInstance(new Plant(3), 'plant')

    const client = new RpcClient(BROKER_URL, { name: 'mqttClient5', defaultTarget: 'mqttServer5' })
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote?.add(1, 1), 5)

    await client.close()
    await server.close()
})
