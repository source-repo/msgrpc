import test from 'ava'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugNodeMetricProjection, projectNodeMetrics } from './Projection.js'
import { decodeSparkplugPayload } from './Protobuf.js'
import { SparkplugDataType } from './Types.js'

test('projection maps explicit paths to Sparkplug metrics', (t) => {
    t.deepEqual(
        projectNodeMetrics(
            {
                props: { tag: 'pump-7' },
                state: { running: true, temperature: 21.5 }
            },
            [
                { path: 'props.tag', name: 'Properties/Tag' },
                { path: 'state.running', name: 'State/Running' },
                { path: 'state.temperature', name: 'State/Temperature' }
            ]
        ),
        [
            { name: 'Properties/Tag', datatype: SparkplugDataType.String, value: 'pump-7' },
            { name: 'State/Running', datatype: SparkplugDataType.Boolean, value: true },
            { name: 'State/Temperature', datatype: SparkplugDataType.Double, value: 21.5 }
        ]
    )
})

test('projection emits null metrics for missing mapped paths', (t) => {
    t.deepEqual(projectNodeMetrics({}, [{ path: 'state.temperature', name: 'State/Temperature', datatype: SparkplugDataType.Double }]), [
        { name: 'State/Temperature', datatype: SparkplugDataType.Double, isNull: true }
    ])
})

test('node metric projection publishes NDATA only for changed metrics', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 1000,
        publish: (frame) => {
            published.push(frame)
        }
    })
    const projection = new SparkplugNodeMetricProjection(session, [
        { path: 'state.running', name: 'State/Running' },
        { path: 'state.temperature', name: 'State/Temperature' }
    ])

    const birth = await session.birth(projection.birthMetrics({ state: { running: true, temperature: 21.5 } }))
    const unchanged = await projection.publishChanges({ state: { running: true, temperature: 21.5 } })
    const changed = await projection.publishChanges({ state: { running: true, temperature: 22 } })
    if (!changed) throw new Error('changed snapshot did not publish')

    const dataPayload = decodeSparkplugPayload(changed.payload)

    t.is(unchanged, undefined)
    t.is(changed.topic, 'spBv1.0/NDATA/plant-a/edge-01')
    t.is(dataPayload.seq, 1)
    t.deepEqual(
        dataPayload.metrics.map((metric) => ({ name: metric.name, datatype: metric.datatype, value: metric.value })),
        [{ name: 'State/Temperature', datatype: SparkplugDataType.Double, value: 22 }]
    )
    t.deepEqual(published, [birth, changed])
})
