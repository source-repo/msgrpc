import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync } from 'mqtt'
import { rpc, rpcNamespace, RpcClient, RpcServer, TransportEvent } from './index.js'

/**
 * The description hash in presence: caches notice a peer changed shape.
 *
 * The bargain stands - peers describe themselves as the network is used, never on sight - and the
 * hash is only the invalidation signal: a cache holding a description whose hash no longer matches
 * knows to re-describe when next asked. These tests pin the signal itself: it arrives with
 * presence, it changes when the surface changes, and it stays quiet when nothing did.
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
    const available = await brokerAvailable()
    // Skipping is right on a laptop with no broker and wrong everywhere it matters: a suite that
    // reports itself green having quietly run none of its MQTT tests is worse than one that fails,
    // because it is the version somebody trusts. CI sets this, so the skip cannot happen unnoticed.
    if (!available && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
    t.context = { skipped: !available }
})

const skipWithoutBroker = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
    return t.context.skipped
}

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

@rpcNamespace('gauge')
class Gauge {
    @rpc({ semantics: 'query' })
    async read() {
        return 21
    }
}

@rpcNamespace('valve')
class Valve {
    @rpc({ semantics: 'idempotent-command' })
    async open() {
        return 'opened'
    }
}

test('a restart with a different surface changes the announced hash; one with the same surface does not', async (t) => {
    const hub = new RpcServer({ name: peer('hub3852'), transports: [{ port: 3852, host: '127.0.0.1' }] })
    await hub.ready()

    const watcher = new RpcClient('http://localhost:3852', { name: peer('watcher3852') })
    const reshapes: { peer: string; shape: string }[] = []
    watcher.on(TransportEvent.peerShape, (name: string, shape: string) => reshapes.push({ peer: name, shape }))
    await watcher.peersSettled()

    const first = new RpcServer({ name: peer('device3852'), transports: [{ connect: 'http://localhost:3852' }], exposeIntrospection: true })
    first.exposeClassInstance(new Gauge())
    await first.ready()
    await waitFor(() => reshapes.some((entry) => entry.peer === peer('device3852')))
    const original = reshapes.find((entry) => entry.peer === peer('device3852'))!.shape
    t.is(watcher.peers.shapeOf(peer('device3852')), original, 'the registry holds what presence carried')

    // The same surface under the same name: the hash must not move, or every reconnect would
    // invalidate every cache and the signal would be noise.
    await first.close()
    const same = new RpcServer({ name: peer('device3852'), transports: [{ connect: 'http://localhost:3852' }], exposeIntrospection: true })
    same.exposeClassInstance(new Gauge())
    await same.ready()
    await waitFor(() => watcher.peers.names().includes(peer('device3852')))
    t.is(watcher.peers.shapeOf(peer('device3852')), original, 'an unchanged surface keeps its hash across a restart')

    // The field trial's case: a restart under the same name serving something else.
    await same.close()
    const changed = new RpcServer({ name: peer('device3852'), transports: [{ connect: 'http://localhost:3852' }], exposeIntrospection: true })
    changed.exposeClassInstance(new Valve())
    await changed.ready()
    await waitFor(() => watcher.peers.shapeOf(peer('device3852')) !== original)
    const reshaped = watcher.peers.shapeOf(peer('device3852'))!
    t.not(reshaped, original)
    t.is(reshapes.filter((entry) => entry.peer === peer('device3852')).pop()!.shape, reshaped, 'the change arrived as a peerShape event, not only in the registry')

    await changed.close()
    await watcher.close()
    await hub.close()
})

test('an expose after ready() re-announces, so caches hear about surfaces that grow in place', async (t) => {
    const hub = new RpcServer({ name: peer('hub3853'), transports: [{ port: 3853, host: '127.0.0.1' }] })
    await hub.ready()

    const device = new RpcServer({ name: peer('device3853'), transports: [{ connect: 'http://localhost:3853' }], exposeIntrospection: true })
    device.exposeClassInstance(new Gauge())
    await device.ready()

    const watcher = new RpcClient('http://localhost:3853', { name: peer('watcher3853') })
    await watcher.peersSettled()
    const before = watcher.peers.shapeOf(peer('device3853'))
    t.truthy(before, 'the sweep already carries the hash')

    const reshapes: string[] = []
    watcher.on(TransportEvent.peerShape, (name: string, shape: string) => void (name === peer('device3853') && reshapes.push(shape)))

    device.exposeClassInstance(new Valve())
    await waitFor(() => reshapes.length > 0)
    t.not(reshapes[0], before, 'growing the surface moved the hash')
    t.is(watcher.peers.shapeOf(peer('device3853')), reshapes[0])

    await watcher.close()
    await device.close()
    await hub.close()
})

test('over MQTT the hash rides retained presence as a user property', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = `shape-${run}`

    const first = new RpcServer({ name: peer('deviceM'), transports: [{ brokerurl: BROKER_URL, prefix }], exposeIntrospection: true })
    first.exposeClassInstance(new Gauge())
    await first.ready()

    const watcher = new RpcServer({ name: peer('watcherM'), transports: [{ brokerurl: BROKER_URL, prefix }] })
    await watcher.peersSettled(5000)
    const original = watcher.peers.shapeOf(peer('deviceM'))
    t.truthy(original, 'retained presence carries the hash to a subscriber that arrives later')

    // Restart serving something else: the retained announcement is republished with the new hash.
    await first.close()
    const changed = new RpcServer({ name: peer('deviceM'), transports: [{ brokerurl: BROKER_URL, prefix }], exposeIntrospection: true })
    changed.exposeClassInstance(new Valve())
    await changed.ready()
    await waitFor(() => watcher.peers.shapeOf(peer('deviceM')) !== original, 8000)
    t.not(watcher.peers.shapeOf(peer('deviceM')), original)

    await changed.close()
    await watcher.close()
})
