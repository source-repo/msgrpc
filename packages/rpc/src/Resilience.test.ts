import anyTest, { TestFn } from 'ava'
import { connectAsync } from 'mqtt'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { MqttTransport, RpcClient, RpcServer, TransportEvent } from './index.js'
import { Switch } from './Utilities/Switch.js'
import { GenericModule, Message } from './RPC/Core.js'

/**
 * What happens when things go wrong: a malformed frame, a handler that throws, a link that has
 * gone away. None of these should end the process, and none of them should leave the other end
 * waiting out a timeout with nothing to explain it.
 *
 * AVA fails a test on an unhandled rejection, so several of these assert the containment simply by
 * completing - before the fixes they took the whole worker down.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
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
    async add(a: number, b: number) {
        return a + b
    }
    async explode(): Promise<never> {
        throw new Error('pressure relief valve stuck')
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

test('a client that cannot start says why instead of timing out', async (t) => {
    // init() is async and the constructor cannot await it, so this rejection used to be unhandled -
    // which on Node's default settings ends the process from inside a constructor.
    const client = new RpcClient('mqtt://localhost:1883', { name: 'has/a/slash', readyTimeout: 2000 })
    await t.throwsAsync(client.ready(), { message: /could not start.*unsafe peer name/ })
    await client.close()
})

test('a call that cannot be sent fails at once rather than waiting out its timeout', async (t) => {
    // The socket.io client used to send through `this.socket?.emit(...)`, which is a no-op once the
    // transport is closed: the frame was dropped without a word and the caller waited the full
    // callTimeout for a reply that was never coming.
    const server = new RpcServer({ transports: [{ port: 3811 }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const client = new RpcClient('http://localhost:3811', { name: peer('shortCircuit'), callTimeout: 30000 })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')
    t.is(await plant.remote!.add(1, 2), 3)

    await client.close()
    const started = Date.now()
    await t.throwsAsync(plant.remote!.add(1, 2), { message: /TransportError/ })
    t.true(Date.now() - started < 5000, 'the call waited for its timeout instead of failing on the closed link')

    await server.close()
})

test('an event handler that throws does not take the client down', async (t) => {
    // These are application callbacks reached from the transport's inbound loop, so one that threw
    // unwound all the way back out and became an unhandled rejection.
    const server = new RpcServer({ transports: [{ port: 3812 }] })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')

    const client = new RpcClient('http://localhost:3812', { name: peer('throwingSubscriber') })
    await client.ready()
    const proxy = await client.proxy<Plant>('plant')

    const reported: unknown[] = []
    client.rpcClient!.on('subscriberError', (e) => reported.push(e))
    await proxy.remote!.on('alarm', () => {
        throw new Error('the subscriber is broken')
    })

    plant.fire()
    await waitFor(() => reported.length > 0)
    t.is(reported.length, 1, 'the failing subscriber was not reported')

    // The client is still usable, which is the point: one bad handler is not everybody's problem.
    t.is(await proxy.remote!.add(2, 3), 5)

    await client.close()
    await server.close()
})

test('a method that throws answers the caller with the reason', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3813 }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const client = new RpcClient('http://localhost:3813', { name: peer('errorCaller'), callTimeout: 4000 })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')

    await t.throwsAsync(plant.remote!.explode(), { message: /pressure relief valve stuck/ })

    await client.close()
    await server.close()
})

test('a command whose caller has already given up is refused instead of run late', async (t) => {
    // The hazard is not the wasted work. It is that the operator saw a timeout, did something else
    // about it, and then the original command runs anyway - which for 'start pump' or 'reset fault'
    // is a machine moving when nobody expects it to.
    let started = 0
    class SlowGate extends EventEmitter {
        async startPump() {
            started++
            return 'running'
        }
    }
    const server = new RpcServer({
        transports: [{ port: 3814 }],
        // Something in front of the method that takes longer than the caller will wait. An
        // authorizer is the honest version of it: the check has to finish before the method can be
        // allowed to run, and a directory server having a bad day is exactly how that happens.
        authorize: async () => {
            await new Promise((resolve) => setTimeout(resolve, 400))
            return true
        }
    })
    await server.ready()
    server.exposeClassInstance(new SlowGate(), 'gate')

    const client = new RpcClient('http://localhost:3814', { name: peer('impatient'), callTimeout: 120 })
    await client.ready()
    const gate = await client.proxy<SlowGate>('gate')

    await t.throwsAsync(gate.remote!.startPump(), { message: /Timeout/ }, 'the caller should have given up')
    // Long enough for the authorizer to finish and the method to run, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 600))
    t.is(started, 0, 'a command ran after its caller had already been told it timed out')

    await client.close()
    await server.close()
})

test('a switch says so when it cannot place a message', async (t) => {
    // It used to drop the message and return, so the only evidence was a call that never came back.
    const source = new GenericModule('source')
    const router = new Switch([source])
    const unroutable: unknown[] = []
    router.on(TransportEvent.unroutable, (event) => unroutable.push(event))

    await router.receive(new Message(), 'someone', 'nobody-here')

    t.is(unroutable.length, 1, 'an unplaceable message vanished without a word')
    t.like(unroutable[0], { source: 'someone', target: 'nobody-here' })
})

// ---------------------------------------------------------------- broker needed

test('a stray JSON payload on the rpc topic is refused, not fatal', async (t) => {
    if (skipWithoutBroker(t)) return
    // Anything that can reach the broker can publish anything to an rpc topic. A payload starting
    // with '{' and containing a '$' used to be split mid-string and handed to JSON.parse, whose
    // throw - on this path - was an unhandled rejection that ended the process.
    const name = peer('strayPayload')
    const prefix = prefixFor('stray')
    const server = new RpcServer({
        name,
        transports: [{ brokerurl: BROKER_URL, protocol: 4, prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }]
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const rejected: { reason?: string }[] = []
    server.transports[0].on(TransportEvent.rejected, (event) => rejected.push(event))

    const intruder = await connectAsync(BROKER_URL, { reconnectPeriod: 0 })
    for (const payload of ['{"cmd":"pay","amount":"$5"}', '{"$":"$"}', 'not a frame at all', '{']) {
        await intruder.publishAsync(`${prefix}/rpc/${name}`, payload, { qos: 1 })
    }
    await intruder.endAsync()

    await waitFor(() => rejected.length >= 4)
    t.true(rejected.every((event) => !!event.reason), 'a refused frame must carry a reason')

    // Still serving, which is the whole point.
    const client = new RpcClient(undefined, {
        name: peer('strayCaller'),
        transport: new MqttTransport(peer('strayCaller'), BROKER_URL, { protocol: 4, prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: name
    })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')
    t.is(await plant.remote!.add(20, 22), 42)

    await client.close()
    await server.close()
})

test('a peer whose name contains $ can still call over the v1 framing', async (t) => {
    if (skipWithoutBroker(t)) return
    // '$' is legal in an MQTT topic segment and nothing rejected it, but it is also the header
    // delimiter - so every frame this peer sent was cut mid-name at the receiver.
    const serverName = peer('plant$north')
    const clientName = peer('hmi$1')
    const prefix = prefixFor('dollar')
    const server = new RpcServer({
        name: serverName,
        transports: [{ brokerurl: BROKER_URL, protocol: 4, prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }]
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const client = new RpcClient(undefined, {
        name: clientName,
        transport: new MqttTransport(clientName, BROKER_URL, { protocol: 4, prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: serverName,
        callTimeout: 5000
    })
    await client.ready()
    const plant = await client.proxy<Plant>('plant')

    t.is(await plant.remote!.add(1, 2), 3, 'a call from a peer named with a $ was never delivered')

    await client.close()
    await server.close()
})
