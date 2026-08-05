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
