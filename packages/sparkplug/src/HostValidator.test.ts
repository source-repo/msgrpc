import test from 'ava'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugBirthDeathSequence, SparkplugSequence } from './Sequence.js'
import { SparkplugHostValidator } from './HostValidator.js'
import { SparkplugDataType } from './Types.js'

const validatorWithFrames = async () => {
    const frames: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        seq: new SparkplugSequence(254),
        bdSeq: new SparkplugBirthDeathSequence(12),
        publish: (frame) => {
            frames.push(frame)
        }
    })
    const validator = new SparkplugHostValidator()
    return { frames, session, validator }
}

test('Host validator accepts birth, rebirth and matching death', async (t) => {
    const { frames, session, validator } = await validatorWithFrames()
    const birth = await session.birth([{ name: 'temperature', datatype: SparkplugDataType.Double, value: 20 }])
    const rebirth = await session.rebirth()
    const death = await session.death()

    t.deepEqual(validator.observe(birth), [])
    t.deepEqual(validator.observe(rebirth), [])
    t.deepEqual(validator.observe(death), [])
    t.deepEqual(frames, [birth, rebirth, death])
})

test('Host validator rejects a death before birth', (t) => {
    const validator = new SparkplugHostValidator()

    t.like(
        validator.observe({
            topic: 'spBv1.0/plant-a/NDEATH/edge-01',
            payloadDescription: { timestamp: 1, metrics: [{ name: 'bdSeq', datatype: SparkplugDataType.UInt64, value: 1 }] }
        })[0],
        { code: 'death-before-birth' }
    )
})

test('Host validator rejects rebirth with changed bdSeq', async (t) => {
    const { session, validator } = await validatorWithFrames()
    const birth = await session.birth()
    validator.observe(birth)

    t.like(
        validator.observe({
            topic: 'spBv1.0/plant-a/NBIRTH/edge-01',
            payloadDescription: { timestamp: 1, seq: 255, metrics: [{ name: 'bdSeq', datatype: SparkplugDataType.UInt64, value: 13 }] }
        })[0],
        { code: 'rebirth-bdseq-changed' }
    )
})

test('Host validator rejects retained node lifecycle messages', async (t) => {
    const { session, validator } = await validatorWithFrames()
    const birth = await session.birth()

    t.like(validator.observe({ ...birth, retain: true })[0], { code: 'retained-node-message' })
})

test('Host validator follows one sequence across Node and Device frames', async (t) => {
    const { session, validator } = await validatorWithFrames()
    const birth = await session.birth()
    const deviceBirth = await session.deviceBirth('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 20 }])
    const deviceData = await session.deviceData('pump-7', [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21 }])
    const deviceDeath = await session.deviceDeath('pump-7')
    if (!deviceData) throw new Error('Device data was not published')

    t.deepEqual(validator.observe(birth), [])
    t.deepEqual(validator.observe(deviceBirth), [])
    t.deepEqual(validator.observe(deviceData), [])
    t.deepEqual(validator.observe(deviceDeath), [])
})

test('Host validator rejects Device data before Device birth', async (t) => {
    const { session, validator } = await validatorWithFrames()
    const birth = await session.birth()
    validator.observe(birth)

    t.like(
        validator.observe({
            topic: 'spBv1.0/plant-a/DDATA/edge-01/pump-7',
            payloadDescription: { timestamp: 1, seq: 255, metrics: [{ name: 'temperature', datatype: SparkplugDataType.Double, value: 21 }] }
        })[0],
        { code: 'device-data-before-birth' }
    )
})
