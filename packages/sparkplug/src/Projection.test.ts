import test from 'ava'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import {
    SparkplugComponentProjectionRunner,
    SparkplugDeviceMetricProjection,
    SparkplugNodeMetricProjection,
    projectNodeMetrics,
    type SparkplugComponentProjectionView
} from './Projection.js'
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

    const birth = await projection.birth({ state: { running: true, temperature: 21.5 } })
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

test('component projection runner births a Device from the first snapshot and publishes one DDATA per changed revision', async (t) => {
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
        deviceId: 'pump-7',
        store,
        mappings: [
            { path: 'props.tag', name: 'Properties/Tag' },
            { path: 'state.running', name: 'State/Running' },
            { path: 'state.temperature', name: 'State/Temperature' }
        ]
    })

    await session.birth()
    const birth = await runner.start()
    if (!birth) throw new Error('runner did not publish DBIRTH')
    store.push({
        epoch: 'e1',
        revision: 1,
        props: { tag: 'pump-7' },
        state: { running: true, temperature: 22 },
        status: 'live'
    })
    await runner.flush()

    const data = published[2]
    if (!data) throw new Error('runner did not publish DDATA')
    const birthPayload = decodeSparkplugPayload(birth.payload)
    const dataPayload = decodeSparkplugPayload(data.payload)

    t.is(birth.type, 'DBIRTH')
    t.is(birth.topic, 'spBv1.0/DBIRTH/plant-a/edge-01/pump-7')
    t.is(data.type, 'DDATA')
    t.is(data.topic, 'spBv1.0/DDATA/plant-a/edge-01/pump-7')
    t.deepEqual(
        birthPayload.metrics.map((metric) => metric.name),
        ['Properties/Tag', 'State/Running', 'State/Temperature']
    )
    t.deepEqual(
        dataPayload.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        [{ name: 'State/Temperature', value: 22 }]
    )

    await runner.close()
    t.true(store.closed)
    t.is(published.at(-1)?.type, 'DDEATH')
})

test('component projection maps stale and closed channels to Device death and live recovery to full birth', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({
        epoch: 'e1',
        revision: 0,
        props: { tag: 'pump-7' },
        state: { temperature: 21.5 },
        status: 'live'
    })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        deviceId: 'pump-7',
        store,
        mappings: [
            { path: 'props.tag', name: 'Properties/Tag' },
            { path: 'state.temperature', name: 'State/Temperature' }
        ]
    })

    await session.birth()
    await runner.start()
    store.push({ ...store.getSnapshot(), status: 'stale', staleSince: 2000 })
    await runner.flush()
    store.push({ epoch: 'e2', revision: 0, props: { tag: 'pump-7' }, state: { temperature: 23 }, status: 'live' })
    await runner.flush()
    store.push({ ...store.getSnapshot(), status: 'closed' })
    await runner.flush()

    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDEATH', 'DBIRTH', 'DDEATH'])
    const recovered = decodeSparkplugPayload(published[3]!.payload)
    t.deepEqual(
        recovered.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
        [
            { name: 'Properties/Tag', value: 'pump-7' },
            { name: 'State/Temperature', value: 23 }
        ]
    )

    await runner.close()
    t.true(store.closed)
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDEATH', 'DBIRTH', 'DDEATH'])
})

test('component projection waits for a complete live snapshot before DBIRTH', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({ epoch: '', revision: -1, props: {}, state: {}, status: 'initializing' })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        deviceId: 'pump-7',
        store,
        mappings: [{ path: 'state.temperature', name: 'State/Temperature' }]
    })

    await session.birth()
    t.is(await runner.start(), undefined)
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH'])

    store.push({ epoch: 'e1', revision: 0, props: {}, state: { temperature: 21.5 }, status: 'live' })
    await runner.flush()
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH'])

    await runner.close()
})

test('Device projection only advances its diff baseline after MQTT accepts a frame', async (t) => {
    const published: SparkplugPublishFrame[] = []
    let rejectNextData = true
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            if (frame.type === 'DDATA' && rejectNextData) {
                rejectNextData = false
                throw new Error('publish failed')
            }
            published.push(frame)
        }
    })
    const projection = new SparkplugDeviceMetricProjection(session, 'pump-7', [
        { path: 'state.running', name: 'State/Running' },
        { path: 'state.temperature', name: 'State/Temperature' }
    ])

    await session.birth()
    await projection.birth({ state: { running: true, temperature: 21.5 } })
    await t.throwsAsync(projection.publishChanges({ state: { running: false, temperature: 22 } }), { message: 'publish failed' })
    const retried = await projection.publishChanges({ state: { running: false, temperature: 22 } })
    if (!retried) throw new Error('retry did not publish')

    t.deepEqual(
        decodeSparkplugPayload(retried.payload).metrics.map((metric) => metric.name),
        ['State/Running', 'State/Temperature']
    )
})

test('component projection preserves each snapshot commit while MQTT publishing is busy', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const releases: Array<() => void> = []
    let holdData = false
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: async (frame) => {
            published.push(frame)
            if (holdData && frame.type === 'DDATA') await new Promise<void>((resolve) => releases.push(resolve))
        }
    })
    const store = new FakeComponentStore({ epoch: 'e1', revision: 0, props: {}, state: { temperature: 21 }, status: 'live' })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        deviceId: 'pump-7',
        store,
        mappings: [{ path: 'state.temperature', name: 'State/Temperature' }]
    })

    await session.birth()
    await runner.start()
    holdData = true
    store.push({ epoch: 'e1', revision: 1, props: {}, state: { temperature: 22 }, status: 'live' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    store.push({ epoch: 'e1', revision: 2, props: {}, state: { temperature: 23 }, status: 'live' })
    releases.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    releases.shift()?.()
    await runner.flush()

    const values = published
        .filter((frame) => frame.type === 'DDATA')
        .map((frame) => decodeSparkplugPayload(frame.payload).metrics[0]?.value)
    t.deepEqual(values, [22, 23])

    await runner.close()
})
