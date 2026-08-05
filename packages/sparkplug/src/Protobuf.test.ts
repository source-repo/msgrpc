import test from 'ava'
import { SparkplugDataType } from './Types.js'
import { decodeSparkplugPayload, encodeSparkplugPayload } from './Protobuf.js'
import { NODE_CONTROL_REBIRTH, isNodeRebirthCommand } from './Payload.js'

test('Sparkplug payloads encode to protobuf bytes and decode back', (t) => {
    const bytes = encodeSparkplugPayload({
        timestamp: 1234,
        seq: 42,
        metrics: [
            { name: 'bdSeq', timestamp: 1234, datatype: SparkplugDataType.UInt64, value: 7 },
            { name: 'running', timestamp: 1234, datatype: SparkplugDataType.Boolean, value: true },
            { name: 'temperature', timestamp: 1234, datatype: SparkplugDataType.Double, value: 21.5 },
            { name: 'mode', timestamp: 1234, datatype: SparkplugDataType.String, value: 'auto' }
        ]
    })

    t.true(bytes.length > 0)
    t.deepEqual(decodeSparkplugPayload(bytes), {
        timestamp: 1234,
        seq: 42,
        metrics: [
            { name: 'bdSeq', timestamp: 1234, datatype: SparkplugDataType.UInt64, value: 7n },
            { name: 'running', timestamp: 1234, datatype: SparkplugDataType.Boolean, value: true },
            { name: 'temperature', timestamp: 1234, datatype: SparkplugDataType.Double, value: 21.5 },
            { name: 'mode', timestamp: 1234, datatype: SparkplugDataType.String, value: 'auto' }
        ]
    })
})

test('sequence zero survives protobuf encoding', (t) => {
    const decoded = decodeSparkplugPayload(encodeSparkplugPayload({ timestamp: 1234, seq: 0, metrics: [] }))

    t.is(decoded.seq, 0)
})

test('the M1 encoder refuses datatypes it does not implement yet', (t) => {
    t.throws(
        () =>
            encodeSparkplugPayload({
                timestamp: 1,
                metrics: [{ name: 'dataset', datatype: SparkplugDataType.DataSet, value: 'not-a-dataset' }]
            }),
        { message: /not implemented/ }
    )
})

test('Node Control/Rebirth is recognised as a boolean true command', (t) => {
    t.true(
        isNodeRebirthCommand({
            timestamp: 1,
            metrics: [{ name: NODE_CONTROL_REBIRTH, datatype: SparkplugDataType.Boolean, value: true }]
        })
    )
    t.false(
        isNodeRebirthCommand({
            timestamp: 1,
            metrics: [{ name: NODE_CONTROL_REBIRTH, datatype: SparkplugDataType.Boolean, value: false }]
        })
    )
})
