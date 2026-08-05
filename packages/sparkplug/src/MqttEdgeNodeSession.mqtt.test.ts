import anyTest, { TestFn } from 'ava'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { connectAsync } from 'mqtt'
import { decodeSparkplugPayload, encodeSparkplugPayload } from './Protobuf.js'
import { nodeRebirthCommandPayload } from './Payload.js'
import { SparkplugBirthDeathSequence } from './Sequence.js'
import { SparkplugDataType, deviceTopic, encodeHostStatePayload, hostStateTopic, nodeTopic, type SparkplugHostState } from './Types.js'
import { MqttSparkplugEdgeNodeSession } from './MqttEdgeNodeSession.js'

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

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
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

const skipWithoutBroker = (t: { context: Context; pass: (message?: string) => void }) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return true
    }
    return false
}

test.serial('mqtt: Edge Node publishes NBIRTH bytes and graceful NDEATH with the same bdSeq', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-test')
    const edgeNodeId = name('edge')
    const seen: { topic: string; payload: Uint8Array }[] = []
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    host.on('message', (topic, payload) => {
        seen.push({ topic, payload: new Uint8Array(payload) })
    })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}`, { qos: 1 })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}/+`, { qos: 1 })

    const edge = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge'),
        now: () => 1234,
        birthMetrics: [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }]
    })

    await waitFor(() => seen.some((message) => message.topic.includes('/NBIRTH/')))
    await edge.session.deviceBirth('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    await edge.session.deviceData('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 22 }])
    await edge.session.deviceDeath('pump-7')
    await waitFor(() => seen.some((message) => message.topic.includes('/DDEATH/')))
    await edge.close()
    await waitFor(() => seen.some((message) => message.topic.includes('/NDEATH/')))

    const birth = seen.find((message) => message.topic.includes('/NBIRTH/'))
    const death = seen.find((message) => message.topic.includes('/NDEATH/'))
    const deviceBirth = seen.find((message) => message.topic.includes('/DBIRTH/'))
    const deviceData = seen.find((message) => message.topic.includes('/DDATA/'))
    const deviceDeath = seen.find((message) => message.topic.includes('/DDEATH/'))
    if (!birth || !death || !deviceBirth || !deviceData || !deviceDeath) throw new Error('missing Node or Device lifecycle frame')
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const deathPayload = decodeSparkplugPayload(death.payload)

    t.is(birth.topic, `spBv1.0/${groupId}/NBIRTH/${edgeNodeId}`)
    t.is(death.topic, `spBv1.0/${groupId}/NDEATH/${edgeNodeId}`)
    t.is(birthPayload.metrics[0]?.name, 'bdSeq')
    t.is(deathPayload.metrics[0]?.name, 'bdSeq')
    t.is(birthPayload.metrics[0]?.value, deathPayload.metrics[0]?.value)
    t.is(birthPayload.metrics[1]?.name, 'Node Control/Rebirth')
    t.is(birthPayload.metrics[1]?.value, false)
    t.is(birthPayload.metrics[2]?.name, 'temperature')
    t.is(birthPayload.metrics[2]?.value, 21.5)
    t.deepEqual(
        [birth, deviceBirth, deviceData, deviceDeath].map((message) => decodeSparkplugPayload(message.payload).seq),
        [0, 1, 2, 3]
    )

    await host.endAsync()
})

test.serial('mqtt: NCMD Node Control/Rebirth republishes NBIRTH', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-rebirth')
    const edgeNodeId = name('edge')
    const births: Uint8Array[] = []
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    host.on('message', (topic, payload) => {
        if (topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })) births.push(new Uint8Array(payload))
    })
    await host.subscribeAsync(nodeTopic('NBIRTH', { groupId, edgeNodeId }), { qos: 1 })

    const edge = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge'),
        now: () => 2222,
        birthMetrics: [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 19.25 }]
    })

    await waitFor(() => births.length === 1)
    await host.publishAsync(nodeTopic('NCMD', { groupId, edgeNodeId }), Buffer.from(encodeSparkplugPayload(nodeRebirthCommandPayload(3333))), { qos: 0 })
    await waitFor(() => births.length === 2)

    const first = decodeSparkplugPayload(births[0]!)
    const second = decodeSparkplugPayload(births[1]!)
    t.is(first.seq, 0)
    t.is(second.seq, 1)
    t.is(first.metrics[0]?.name, 'bdSeq')
    t.is(second.metrics[0]?.name, 'bdSeq')
    t.is(first.metrics[0]?.value, second.metrics[0]?.value)
    t.is(second.metrics[2]?.name, 'temperature')
    t.is(second.metrics[2]?.value, 19.25)

    await edge.close()
    await host.endAsync()
})

test.serial('mqtt: a missed QoS 0 DDATA converges through complete Node and Device rebirth', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-gap')
    const edgeNodeId = name('edge')
    const deviceId = 'pump-7'
    const seen: { topic: string; payload: Uint8Array }[] = []
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    host.on('message', (topic, payload) => {
        seen.push({ topic, payload: new Uint8Array(payload) })
    })
    const nBirthTopic = nodeTopic('NBIRTH', { groupId, edgeNodeId })
    const dBirthTopic = deviceTopic('DBIRTH', { groupId, edgeNodeId, deviceId })
    const dDataTopic = deviceTopic('DDATA', { groupId, edgeNodeId, deviceId })
    await host.subscribeAsync(nBirthTopic, { qos: 0 })
    await host.subscribeAsync(dBirthTopic, { qos: 0 })
    await host.subscribeAsync(dDataTopic, { qos: 0 })

    const edge = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge')
    })
    await waitFor(() => seen.some((message) => message.topic === nBirthTopic))
    await edge.session.deviceBirth(deviceId, [
        {
            name: 'State/Temperature',
            alias: 1,
            timestamp: 1000,
            datatype: SparkplugDataType.Double,
            properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } },
            value: 21.5
        }
    ])
    await waitFor(() => seen.some((message) => message.topic === dBirthTopic))

    await host.unsubscribeAsync(dDataTopic)
    await edge.session.deviceData(deviceId, [{ alias: 1, timestamp: 1001, datatype: SparkplugDataType.Double, value: 22 }])
    await host.subscribeAsync(dDataTopic, { qos: 0 })
    await edge.session.deviceData(deviceId, [{ alias: 1, timestamp: 1002, datatype: SparkplugDataType.Double, value: 23 }])
    await waitFor(() => seen.some((message) => message.topic === dDataTopic))

    const beforeRebirth = seen.map((message) => ({ topic: message.topic, seq: decodeSparkplugPayload(message.payload).seq }))
    t.deepEqual(beforeRebirth, [
        { topic: nBirthTopic, seq: 0 },
        { topic: dBirthTopic, seq: 1 },
        { topic: dDataTopic, seq: 3 }
    ])

    await host.publishAsync(nodeTopic('NCMD', { groupId, edgeNodeId }), Buffer.from(encodeSparkplugPayload(nodeRebirthCommandPayload(2000))), { qos: 0 })
    await waitFor(() => seen.filter((message) => message.topic === dBirthTopic).length === 2)

    const rebirth = decodeSparkplugPayload(seen.filter((message) => message.topic === dBirthTopic).at(-1)!.payload)
    t.is(rebirth.seq, 5)
    t.deepEqual(rebirth.metrics, [
        {
            name: 'State/Temperature',
            alias: 1,
            timestamp: 1002,
            datatype: SparkplugDataType.Double,
            properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } },
            value: 23
        }
    ])

    await edge.close()
    await host.endAsync()
})

test.serial('mqtt: Primary Host STATE gates birth, ignores old timestamps and restores complete births', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-host')
    const edgeNodeId = name('edge')
    const hostId = name('primary-host')
    const states: SparkplugHostState[] = []
    const seen: string[] = []
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    const stateTopic = hostStateTopic(hostId)
    host.on('message', (topic) => {
        if (topic.startsWith(`spBv1.0/${groupId}/`)) seen.push(topic)
    })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}`, { qos: 1 })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}/+`, { qos: 1 })
    await host.publishAsync(stateTopic, Buffer.from(encodeHostStatePayload({ online: true, timestamp: 1000 })), { qos: 1, retain: true })

    const edge = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge'),
        primaryHostId: hostId,
        onPrimaryHostState: (state) => {
            states.push(state)
        }
    })

    await waitFor(() => edge.primaryHostState?.online === true && edge.session.born)
    await edge.session.deviceBirth('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    t.deepEqual(edge.primaryHostState, { hostId, online: true, timestamp: 1000 })
    t.deepEqual(states, [{ hostId, online: true, timestamp: 1000 }])

    await host.publishAsync(stateTopic, Buffer.from(encodeHostStatePayload({ online: false, timestamp: 999 })), { qos: 1, retain: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    t.true(edge.session.born)
    t.deepEqual(edge.primaryHostState, { hostId, online: true, timestamp: 1000 })

    await host.publishAsync(stateTopic, Buffer.from(encodeHostStatePayload({ online: false, timestamp: 2000 })), { qos: 1, retain: true })
    await waitFor(() => edge.primaryHostState?.online === false && !edge.session.born)
    t.deepEqual(edge.primaryHostState, { hostId, online: false, timestamp: 2000 })
    t.true(seen.some((topic) => topic.includes('/DDEATH/')))
    t.true(seen.some((topic) => topic.includes('/NDEATH/')))

    await host.publishAsync(stateTopic, Buffer.from(encodeHostStatePayload({ online: true, timestamp: 1500 })), { qos: 1, retain: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    t.false(edge.session.born)

    await host.publishAsync(stateTopic, Buffer.from(encodeHostStatePayload({ online: true, timestamp: 2000 })), { qos: 1, retain: true })
    await waitFor(() => edge.primaryHostState?.online === true && edge.session.born)
    await waitFor(() => seen.filter((topic) => topic.includes('/DBIRTH/')).length === 2)
    t.deepEqual(states, [
        { hostId, online: true, timestamp: 1000 },
        { hostId, online: false, timestamp: 2000 },
        { hostId, online: true, timestamp: 2000 }
    ])

    await edge.close()
    await host.publishAsync(stateTopic, Buffer.alloc(0), { qos: 1, retain: true })
    await host.endAsync()
})

test.serial('mqtt: graceful reconnect claims the next bdSeq', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-bdseq')
    const edgeNodeId = name('edge')
    const seen: { topic: string; payload: Uint8Array }[] = []
    const bdSeq = new SparkplugBirthDeathSequence(250)
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    host.on('message', (topic, payload) => {
        seen.push({ topic, payload: new Uint8Array(payload) })
    })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}`, { qos: 1 })

    const first = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge-a'),
        bdSeq
    })
    await waitFor(() => seen.some((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })))
    await first.close()
    await waitFor(() => seen.some((message) => message.topic === nodeTopic('NDEATH', { groupId, edgeNodeId })))

    const second = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge-b'),
        bdSeq
    })
    await waitFor(() => seen.filter((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })).length === 2)

    const births = seen.filter((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })).map((message) => decodeSparkplugPayload(message.payload))
    const death = decodeSparkplugPayload(seen.find((message) => message.topic === nodeTopic('NDEATH', { groupId, edgeNodeId }))!.payload)

    t.is(births[0]?.metrics[0]?.value, 250n)
    t.is(death.metrics[0]?.value, 250n)
    t.is(births[1]?.metrics[0]?.value, 251n)

    await second.close()
    await host.endAsync()
})

test.serial('mqtt: ungraceful disconnect publishes the NDEATH Will with the live bdSeq', async (t) => {
    if (skipWithoutBroker(t)) return

    const groupId = name('source-spark-will')
    const edgeNodeId = name('edge')
    const seen: { topic: string; payload: Uint8Array }[] = []
    const host = await connectAsync(BROKER_URL, {
        clientId: name('sparkplug-host'),
        clean: true,
        reconnectPeriod: 0
    })
    host.on('message', (topic, payload) => {
        seen.push({ topic, payload: new Uint8Array(payload) })
    })
    await host.subscribeAsync(`spBv1.0/${groupId}/+/${edgeNodeId}`, { qos: 1 })

    const edge = await MqttSparkplugEdgeNodeSession.connect({
        url: BROKER_URL,
        groupId,
        edgeNodeId,
        clientId: name('sparkplug-edge'),
        bdSeq: new SparkplugBirthDeathSequence(17)
    })
    await waitFor(() => seen.some((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId })))

    const stream = edge.client.stream as { destroy?: () => void }
    stream.destroy?.()
    await waitFor(() => seen.some((message) => message.topic === nodeTopic('NDEATH', { groupId, edgeNodeId })))

    const birth = decodeSparkplugPayload(seen.find((message) => message.topic === nodeTopic('NBIRTH', { groupId, edgeNodeId }))!.payload)
    const death = decodeSparkplugPayload(seen.find((message) => message.topic === nodeTopic('NDEATH', { groupId, edgeNodeId }))!.payload)

    t.is(birth.metrics[0]?.value, 17n)
    t.is(death.metrics[0]?.value, 17n)

    await host.endAsync()
})
