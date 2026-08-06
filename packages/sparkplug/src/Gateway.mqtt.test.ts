import { MqttTransport } from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { randomUUID } from 'node:crypto'
import { connectAsync } from 'mqtt'
import { SourceSparkGateway } from './Gateway.js'
import { nodeTopic } from './Types.js'

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

const run = randomUUID().slice(0, 8)
const name = (prefix: string) => `${prefix}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
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
    if (!available && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
    t.context = { skipped: !available }
})

test.serial('mqtt: gateway owns distinct Sparkplug and Source RPC sessions with distinct Wills', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }

    const runtimeId = name('source-edge')
    const groupId = name('source-spark')
    const edgeNodeId = name('edge')
    const seen: { topic: string; payload: string }[] = []
    const monitor = await connectAsync(BROKER_URL, { clientId: name('dual-session-monitor'), clean: true, reconnectPeriod: 0 })
    monitor.on('message', (topic, payload) => seen.push({ topic, payload: payload.toString() }))
    await monitor.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}`, { qos: 1 })
    await monitor.subscribeAsync(`msgrpc/v2/presence/${runtimeId}-rpc`, { qos: 1 })

    const gateway = await SourceSparkGateway.connect({ url: BROKER_URL, runtimeId, groupId, edgeNodeId })
    await waitFor(
        () =>
            seen.some((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })) &&
            seen.some((message) => message.topic === `msgrpc/v2/presence/${runtimeId}-rpc` && message.payload === 'online')
    )

    const rpcTransport = gateway.rpc.options.transport
    t.true(rpcTransport instanceof MqttTransport)
    if (!(rpcTransport instanceof MqttTransport)) throw new Error('gateway did not create an MQTT Source RPC transport')
    t.is(rpcTransport.client?.options.clientId, `${runtimeId}-rpc`)
    t.is(gateway.sparkplug.client.options.clientId, `${runtimeId}-sparkplug`)
    t.not(rpcTransport.client, gateway.sparkplug.client)
    t.deepEqual(rpcTransport.client?.options.will, {
        topic: `msgrpc/v2/presence/${runtimeId}-rpc`,
        payload: Buffer.from('offline'),
        qos: 1,
        retain: true
    })
    t.is(gateway.sparkplug.client.options.will?.topic, nodeTopic('NDEATH', { groupId, edgeNodeId }))
    t.false(gateway.sparkplug.client.options.will?.retain)

    await gateway.close()
    await waitFor(() => seen.some((message) => message.topic === nodeTopic('NDEATH', { groupId, edgeNodeId })))
    await monitor.endAsync()
})
