import test from 'ava'
import { SparkplugDataType } from './Types.js'
import { SparkplugBirthDeathSequence, SparkplugSequence } from './Sequence.js'
import { decodeSparkplugPayload } from './Protobuf.js'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { nodeRebirthCommandPayload } from './Payload.js'

test('an Edge Node birth publishes NBIRTH with seq and bdSeq', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 1234,
        seq: new SparkplugSequence(7),
        bdSeq: new SparkplugBirthDeathSequence(3),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const frame = await session.birth([{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    const payload = decodeSparkplugPayload(frame.payload)

    t.is(frame.topic, 'spBv1.0/NBIRTH/plant-a/edge-01')
    t.true(frame.payload.length > 0)
    t.is(payload.seq, 7)
    t.is(payload.metrics[0]?.name, 'bdSeq')
    t.is(payload.metrics[0]?.value, 3n)
    t.is(payload.metrics[1]?.name, 'temperature')
    t.is(payload.metrics[1]?.value, 21.5)
    t.is(session.bdSeq, 3)
    t.deepEqual(published, [frame])
})

test('an oversized frame is refused before the publisher is called', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        maxPacketBytes: 100,
        publish: (frame) => {
            published.push(frame)
        }
    })

    await t.throwsAsync(session.birth([{ name: 'large', datatype: SparkplugDataType.String, value: 'x'.repeat(100) }]), {
        message: /exceeding maxPacketBytes 100.*one snapshot/
    })
    t.deepEqual(published, [])
})

test('the NDEATH will reuses the same bdSeq as NBIRTH and is not retained', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 5678,
        bdSeq: new SparkplugBirthDeathSequence(9),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const will = session.nodeWill()
    const birth = await session.birth()
    const death = await session.death()
    const willPayload = decodeSparkplugPayload(will.payload)
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const deathPayload = decodeSparkplugPayload(death.payload)

    t.is(will.topic, 'spBv1.0/NDEATH/plant-a/edge-01')
    t.is(will.qos, 1)
    t.false(will.retain)
    t.is(willPayload.metrics[0]?.value, 9n)
    t.is(birthPayload.metrics[0]?.value, 9n)
    t.is(deathPayload.metrics[0]?.value, 9n)
    t.deepEqual(published, [birth, death])
})

test('a new birth after graceful death claims the next bdSeq', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 7777,
        bdSeq: new SparkplugBirthDeathSequence(254),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const firstBirth = await session.birth()
    const firstDeath = await session.death()
    const secondBirth = await session.birth()

    t.is(decodeSparkplugPayload(firstBirth.payload).metrics[0]?.value, 254n)
    t.is(decodeSparkplugPayload(firstDeath.payload).metrics[0]?.value, 254n)
    t.is(decodeSparkplugPayload(secondBirth.payload).metrics[0]?.value, 255n)
    t.deepEqual(published, [firstBirth, firstDeath, secondBirth])
})

test('Node Control/Rebirth republishes NBIRTH with the same bdSeq and next seq', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 9000,
        seq: new SparkplugSequence(41),
        bdSeq: new SparkplugBirthDeathSequence(8),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const birth = await session.birth([{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    const rebirth = await session.handleNodeCommand(nodeRebirthCommandPayload(9100))
    if (!rebirth) throw new Error('rebirth command did not publish')
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const rebirthPayload = decodeSparkplugPayload(rebirth.payload)

    t.is(rebirth.topic, 'spBv1.0/NBIRTH/plant-a/edge-01')
    t.is(birthPayload.seq, 41)
    t.is(rebirthPayload.seq, 42)
    t.is(birthPayload.metrics[0]?.value, 8n)
    t.is(rebirthPayload.metrics[0]?.value, 8n)
    t.is(rebirthPayload.metrics[1]?.name, 'temperature')
    t.is(rebirthPayload.metrics[1]?.value, 21.5)
    t.deepEqual(published, [birth, rebirth])
})

test('Node Control/Rebirth retains Node definitions after alias-only NDATA', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })

    await session.birth([
        {
            name: 'temperature',
            alias: 1,
            timestamp: 1000,
            datatype: SparkplugDataType.Double,
            properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } },
            value: 21.5
        }
    ])
    await session.data([{ alias: 1, timestamp: 1001, datatype: SparkplugDataType.Double, value: 22 }])
    await session.handleNodeCommand(nodeRebirthCommandPayload(1002))

    const rebirth = decodeSparkplugPayload(published.at(-1)!.payload).metrics[1]
    t.deepEqual(rebirth, {
        name: 'temperature',
        alias: 1,
        timestamp: 1001,
        datatype: SparkplugDataType.Double,
        properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } },
        value: 22
    })
})

test('non-rebirth NCMD payloads are ignored', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })

    const birth = await session.birth()
    const ignored = await session.handleNodeCommand({
        timestamp: 1,
        metrics: [{ name: 'Node Control/Rebirth', datatype: SparkplugDataType.Boolean, value: false }]
    })

    t.is(ignored, undefined)
    t.deepEqual(published, [birth])
})

test('rebirth republishes NBIRTH with the same bdSeq and a new seq', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 1234,
        seq: new SparkplugSequence(10),
        bdSeq: new SparkplugBirthDeathSequence(4),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const birth = await session.birth()
    const rebirth = await session.rebirth([{ name: 'temperature', datatype: SparkplugDataType.Double, value: 22 }])
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const rebirthPayload = decodeSparkplugPayload(rebirth.payload)

    t.is(rebirth.topic, 'spBv1.0/NBIRTH/plant-a/edge-01')
    t.is(birthPayload.metrics[0]?.value, 4n)
    t.is(rebirthPayload.metrics[0]?.value, 4n)
    t.is(birthPayload.seq, 10)
    t.is(rebirthPayload.seq, 11)
    t.is(rebirthPayload.metrics[1]?.name, 'temperature')
    t.deepEqual(published, [birth, rebirth])
})

test('Device lifecycle frames share the Edge Node sequence and wrap at 255', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        seq: new SparkplugSequence(254),
        publish: (frame) => {
            published.push(frame)
        }
    })

    const nodeBirth = await session.birth()
    const deviceBirth = await session.deviceBirth('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    const deviceData = await session.deviceData('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 22 }])
    const deviceDeath = await session.deviceDeath('pump-7')
    if (!deviceData) throw new Error('Device data was not published')

    t.deepEqual(
        [nodeBirth, deviceBirth, deviceData, deviceDeath].map((frame) => ({ type: frame.type, topic: frame.topic, seq: decodeSparkplugPayload(frame.payload).seq })),
        [
            { type: 'NBIRTH', topic: 'spBv1.0/NBIRTH/plant-a/edge-01', seq: 254 },
            { type: 'DBIRTH', topic: 'spBv1.0/DBIRTH/plant-a/edge-01/pump-7', seq: 255 },
            { type: 'DDATA', topic: 'spBv1.0/DDATA/plant-a/edge-01/pump-7', seq: 0 },
            { type: 'DDEATH', topic: 'spBv1.0/DDEATH/plant-a/edge-01/pump-7', seq: 1 }
        ]
    )
    t.deepEqual(published, [nodeBirth, deviceBirth, deviceData, deviceDeath])
})

test('Node Control/Rebirth republishes complete current Device births', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })

    await session.birth()
    await session.deviceBirth('pump-7', [
        { name: 'running', datatype: SparkplugDataType.Boolean, value: true },
        { name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }
    ])
    await session.deviceData('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 22 }])
    const rebirth = await session.handleNodeCommand(nodeRebirthCommandPayload(9100))
    if (!rebirth) throw new Error('rebirth command did not publish')

    const deviceRebirth = published.at(-1)
    if (!deviceRebirth) throw new Error('Device rebirth was not published')
    const payload = decodeSparkplugPayload(deviceRebirth.payload)

    t.is(rebirth.type, 'NBIRTH')
    t.is(deviceRebirth.type, 'DBIRTH')
    t.is(deviceRebirth.topic, 'spBv1.0/DBIRTH/plant-a/edge-01/pump-7')
    t.deepEqual(
        payload.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        [
            { name: 'running', value: true },
            { name: 'temperature', value: 22 }
        ]
    )
    t.deepEqual(published.map((frame) => decodeSparkplugPayload(frame.payload).seq), [0, 1, 2, 3, 4])
})

test('queued Device publishes cannot overtake one another', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const releases: Array<() => void> = []
    let hold = false
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: async (frame) => {
            published.push(frame)
            if (hold) await new Promise<void>((resolve) => releases.push(resolve))
        }
    })

    await session.birth()
    hold = true
    const birth = session.deviceBirth('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    const data = session.deviceData('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 22 }])
    await new Promise<void>((resolve) => setImmediate(resolve))

    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH'])
    releases.shift()?.()
    await birth
    await new Promise<void>((resolve) => setImmediate(resolve))
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDATA'])
    releases.shift()?.()
    await data
    t.deepEqual(published.map((frame) => decodeSparkplugPayload(frame.payload).seq), [0, 1, 2])
})
