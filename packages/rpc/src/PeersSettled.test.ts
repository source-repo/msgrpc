import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync } from 'mqtt'
import { RpcClient, RpcServer } from './index.js'
import { MqttTransport } from './Transports/MqttTransport.js'

/**
 * peersSettled(): presence-settled ready.
 *
 * ready() means the link is up, not that presence has arrived - so asking who is there
 * immediately finds an empty network on a bus that is plainly there, and every script (and a
 * dozen tests in this repo) re-wrote the same poll-for-peers loop. These tests hold the promise
 * to exactly what the doc comment states: the first sweep has arrived, nothing more.
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

test('a client settles knowing who was already on the hub, with no poll loop', async (t) => {
    const hub = new RpcServer({ name: peer('hub3849'), transports: [{ port: 3849, host: '127.0.0.1' }] })
    await hub.ready()
    const resident = new RpcServer({ name: peer('resident3849'), transports: [{ connect: 'http://localhost:3849' }] })
    await resident.ready()
    // The resident's announcement has to have landed at the hub before the newcomer arrives, or
    // the test would race the very machinery it is checking.
    t.true(await hub.awaitPeer(peer('resident3849')))

    // This is the whole point: no waitFor, no sleep. The first sweep is the server's answer to
    // this client's announcement, and it carries the resident.
    const newcomer = new RpcClient('http://localhost:3849', { name: peer('newcomer3849') })
    const found = await newcomer.peersSettled()
    t.true(found.includes(peer('resident3849')), `sweep should carry the resident, got: ${found.join(', ')}`)
    t.true(found.includes(peer('hub3849')), 'the hub names itself first in its own sweep')
    t.false(found.includes(peer('newcomer3849')), 'own name excluded')

    await newcomer.close()
    await resident.close()
    await hub.close()
})

test('an empty network settles empty, quickly, rather than timing out', async (t) => {
    const hub = new RpcServer({ name: peer('hub3850'), transports: [{ port: 3850, host: '127.0.0.1' }] })
    await hub.ready()

    const started = Date.now()
    const alone = new RpcClient('http://localhost:3850', { name: peer('alone3850') })
    const found = await alone.peersSettled()
    // The hub itself is all there is to find. Settling must come from the sweep arriving, not
    // from the bound expiring - an empty network is an answer, not a timeout.
    t.deepEqual(found, [peer('hub3850')])
    t.true(Date.now() - started < 1900, 'settled by sweep, not by exhausting the bound')

    // A connecting server settles the same way, through the same transports.
    const server = new RpcServer({ name: peer('server3850'), transports: [{ connect: 'http://localhost:3850' }] })
    const seen = await server.peersSettled()
    t.true(seen.includes(peer('hub3850')))

    await server.close()
    await alone.close()
    await hub.close()
})

test('a listening hub settles at once: there is no sweep to wait for, only who has dialled', async (t) => {
    const hub = new RpcServer({ name: peer('hub3851'), transports: [{ port: 3851, host: '127.0.0.1' }] })
    const started = Date.now()
    const found = await hub.peersSettled()
    t.deepEqual(found, [], 'nobody has dialled in yet, and that is the honest answer')
    t.true(Date.now() - started < 500, 'a listener must not sit out the bound')
    await hub.close()
})

test('over MQTT the retained burst is the sweep, and the quiet gap ends it', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = `settled-${run}`
    const resident = new RpcServer({ name: peer('residentM'), transports: [{ brokerurl: BROKER_URL, prefix }] })
    await resident.ready()

    // Retained presence is what makes this work at all: the resident announced once, and the
    // broker replays it to whoever subscribes later. The newcomer polls nothing. The transport is
    // handed in because RpcClient's url shorthand has no way to say a per-run prefix.
    const transport = new MqttTransport(peer('newcomerM'), BROKER_URL, { prefix })
    const newcomer = new RpcClient(undefined, { name: peer('newcomerM'), transport })
    const found = await newcomer.peersSettled(5000)
    t.true(found.includes(peer('residentM')), `retained sweep should carry the resident, got: ${found.join(', ')}`)

    await newcomer.close()
    await resident.close()
})
