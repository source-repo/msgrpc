import test from 'ava'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugComponentProjectionRunner, SparkplugNodeMetricProjection, projectNodeMetrics, type SparkplugComponentProjectionView } from './Projection.js'
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

class FakeComponentStore {
    #snapshot: SparkplugComponentProjectionView
    #listeners = new Set<() => void>()
    closed = false

    constructor(snapshot: SparkplugComponentProjectionView) {
        this.#snapshot = snapshot
    }

    getSnapshot(): SparkplugComponentProjectionView {
        return this.#snapshot
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    async close(): Promise<void> {
        this.closed = true
    }

    push(snapshot: SparkplugComponentProjectionView): void {
        this.#snapshot = snapshot
        for (const listener of this.#listeners) listener()
    }
}

test('component projection runner births from the first snapshot and publishes one NDATA per changed revision', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 1000,
        publish: (frame) => {
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({
        epoch: 'e1',
        revision: 0,
        props: { tag: 'pump-7' },
        state: { running: true, temperature: 21.5 },
        status: 'live'
    })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        store,
        mappings: [
            { path: 'props.tag', name: 'Properties/Tag' },
            { path: 'state.running', name: 'State/Running' },
            { path: 'state.temperature', name: 'State/Temperature' }
        ]
    })

    const birth = await runner.start()
    store.push({
        epoch: 'e1',
        revision: 1,
        props: { tag: 'pump-7' },
        state: { running: true, temperature: 22 },
        status: 'live'
    })
    await runner.flush()

    const data = published[1]
    if (!data) throw new Error('runner did not publish NDATA')
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const dataPayload = decodeSparkplugPayload(data.payload)

    t.is(birth.type, 'NBIRTH')
    t.is(data.type, 'NDATA')
    t.deepEqual(
        birthPayload.metrics.map((metric) => metric.name),
        ['bdSeq', 'Properties/Tag', 'State/Running', 'State/Temperature']
    )
    t.deepEqual(
        dataPayload.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        [{ name: 'State/Temperature', value: 22 }]
    )

    await runner.close()
    t.true(store.closed)
})
