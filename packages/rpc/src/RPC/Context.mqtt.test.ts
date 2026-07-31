import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync } from 'mqtt'
import { RpcServer } from '../index.js'
import { defineRpcContext } from './Context.js'
import { HOST_ROOT } from './Topology.js'

/**
 * The context conformance subset over MQTT 5: the same programs the socket.io suite passed, so
 * anything failing here is the transport showing through the contract. Register-then-snapshot
 * subscriptions and full-frame pushes are exactly what makes broker QoS 1 redelivery harmless.
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

const waitFor = async (condition: () => boolean, timeout = 10_000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
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

const skipWithoutBroker = (t: { context: Context; pass: (message?: string) => void }) => {
    if (t.context.skipped) {
        t.pass('no broker reachable, skipped')
        return true
    }
    return false
}

test.serial('mqtt: context inherits across hosts, updates flow, and the owner remount stays atomic', async (t) => {
    if (skipWithoutBroker(t)) return
    const plantName = peer('ctx-plant')
    const plant = new RpcServer({ name: plantName, transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await plant.ready()
    await plant.topology.declare('line')
    await plant.topology.declare('maintenance')
    const order = defineRpcContext<{ workOrder: string }>({ id: `acme.mqtt-wo.${run}`, schemaVersion: '1', axis: 'logical' })
    const handle = plant.provideContext('line', order, { workOrder: 'WO-17' })
    plant.provideContext('maintenance', order, { workOrder: 'bearing-job' })

    const edge = new RpcServer({ name: peer('ctx-edge'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await edge.ready()
    await edge.topology.declare('machine', { owner: { peer: plantName, instance: 'line' } })

    const store = edge.contextOf('machine', order)
    await waitFor(() => store.getSnapshot().status === 'live', 15_000)
    t.is((store.getSnapshot().entry?.value as { workOrder: string }).workOrder, 'WO-17', 'the logical chain crossed the broker')

    handle.set({ workOrder: 'WO-18' })
    await waitFor(() => (store.getSnapshot().entry?.value as { workOrder: string } | undefined)?.workOrder === 'WO-18')
    t.pass()

    // The remount, over the broker: reassigned owner, new mount, never a mixture.
    const machine = edge.topology.get('machine')!
    const mounted = store.getSnapshot().mountEpoch
    await edge.topology.update('machine', { owner: { peer: plantName, instance: 'maintenance' } }, { expectedVersion: machine.version })
    await waitFor(() => (store.getSnapshot().entry?.value as { workOrder: string } | undefined)?.workOrder === 'bearing-job', 15_000)
    t.not(store.getSnapshot().mountEpoch, mounted)
    t.is(store.getSnapshot().transitionReason, 'owner-remount')

    store.close()
    await edge.close()
    await plant.close()
})

test.serial('mqtt: a local-only value never crosses the broker, and capture still refuses it', async (t) => {
    if (skipWithoutBroker(t)) return
    const plantName = peer('ctx-secret')
    const plant = new RpcServer({ name: plantName, transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await plant.ready()
    const secret = defineRpcContext({ id: `acme.mqtt-secret.${run}`, schemaVersion: '1', axis: 'physical', exposure: 'local' })
    plant.provideContext(HOST_ROOT, secret, 'broker-password')

    const edge = new RpcServer({ name: peer('ctx-nosy'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })

    const store = edge.contextOf(HOST_ROOT, secret)
    await waitFor(() => store.getSnapshot().status === 'missing', 15_000)
    t.is(store.getSnapshot().status, 'missing', 'absence, not refusal - the wire snapshot simply does not contain it')

    store.close()
    await edge.close()
    await plant.close()
})
