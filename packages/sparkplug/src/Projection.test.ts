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
import { compileSparkplugProjectionContract } from './ProjectionContract.js'
import { SparkplugDataType } from './Types.js'

test('projection maps explicit paths to Sparkplug metrics', (t) => {
    t.deepEqual(
        projectNodeMetrics(
            {
                props: { tag: 'pump-7' },
                state: { running: true, temperature: 21.5 },
                receivedAt: 1234
            },
            [
                { path: 'props.tag', name: 'Properties/Tag' },
                { path: 'state.running', name: 'State/Running' },
                { path: 'state.temperature', name: 'State/Temperature' }
            ]
        ),
        [
            { name: 'Properties/Tag', timestamp: 1234, datatype: SparkplugDataType.String, value: 'pump-7' },
            { name: 'State/Running', timestamp: 1234, datatype: SparkplugDataType.Boolean, value: true },
            { name: 'State/Temperature', timestamp: 1234, datatype: SparkplugDataType.Double, value: 21.5 }
        ]
    )
})

test('projection emits null metrics for missing mapped paths', (t) => {
    t.deepEqual(projectNodeMetrics({ receivedAt: 1234 }, [{ path: 'state.temperature', name: 'State/Temperature', datatype: SparkplugDataType.Double }]), [
        { name: 'State/Temperature', timestamp: 1234, datatype: SparkplugDataType.Double, isNull: true }
    ])
})

test('projection enforces declared variable-value byte bounds', (t) => {
    t.throws(
        () =>
            projectNodeMetrics(
                { state: { label: 'värde' } },
                [{ path: 'state.label', name: 'State/Label', datatype: SparkplugDataType.String, maxBytes: 5 }]
            ),
        { message: /value is 6 bytes, exceeding maxBytes 5/ }
    )
})

test('metric quality transitions publish even when the value does not change', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const projection = new SparkplugDeviceMetricProjection(session, 'pump-7', [
        {
            path: 'state.temperature',
            qualityPath: 'state.temperatureQuality',
            name: 'State/Temperature',
            alias: 1,
            datatype: SparkplugDataType.Double,
            properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } }
        }
    ])

    await session.birth()
    const birth = await projection.birth({ state: { temperature: 21.5, temperatureQuality: 192 }, receivedAt: 1000 })
    const stale = await projection.publishChanges({ state: { temperature: 21.5, temperatureQuality: 500 }, receivedAt: 1001 })
    const good = await projection.publishChanges({ state: { temperature: 21.5, temperatureQuality: 192 }, receivedAt: 1002 })
    if (!stale || !good) throw new Error('quality transition did not publish')

    t.deepEqual(decodeSparkplugPayload(birth.payload).metrics[0]?.properties, {
        Quality: { datatype: SparkplugDataType.Int32, value: 192 },
        'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' }
    })
    t.deepEqual(decodeSparkplugPayload(stale.payload).metrics, [
        {
            alias: 1,
            timestamp: 1001,
            datatype: SparkplugDataType.Double,
            properties: { Quality: { datatype: SparkplugDataType.Int32, value: 500 } },
            value: 21.5
        }
    ])
    t.deepEqual(decodeSparkplugPayload(good.payload).metrics[0]?.properties, {
        Quality: { datatype: SparkplugDataType.Int32, value: 192 }
    })

    await session.handleNodeCommand({
        timestamp: 1003,
        metrics: [{ name: 'Node Control/Rebirth', datatype: SparkplugDataType.Boolean, value: true }]
    })
    t.deepEqual(decodeSparkplugPayload(published.at(-1)!.payload).metrics[0]?.properties, {
        Quality: { datatype: SparkplugDataType.Int32, value: 192 },
        'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' }
    })
})

test('deadband accumulates against the last published value', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const projection = new SparkplugDeviceMetricProjection(session, 'pump-7', [
        { path: 'state.temperature', name: 'State/Temperature', datatype: SparkplugDataType.Double, deadband: 2 }
    ])

    await session.birth()
    await projection.birth({ state: { temperature: 20 } })
    t.is(await projection.publishChanges({ state: { temperature: 21 } }), undefined)
    t.is(await projection.publishChanges({ state: { temperature: 21.9 } }), undefined)
    const accumulated = await projection.publishChanges({ state: { temperature: 22 } })
    if (!accumulated) throw new Error('accumulated deadband change did not publish')

    t.deepEqual(decodeSparkplugPayload(accumulated.payload).metrics.map((metric) => metric.value), [22])
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDATA'])
})

test('compiled contract definitions publish full DBIRTH metrics, alias-only DDATA and complete rebirth definitions', async (t) => {
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        now: () => 2000,
        publish: (frame) => {
            published.push(frame)
        }
    })
    const compiled = compileSparkplugProjectionContract({
        schema: 1,
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        devices: [
            {
                deviceId: 'pump-7',
                source: { peer: 'pump-controller', component: 'pump' },
                metrics: [
                    { name: 'Properties/Tag', path: 'props.tag', datatype: 'String', maxBytes: 64 },
                    { name: 'State/Temperature', path: 'state.temperature', datatype: 'Double', unit: 'degC', minimum: -40, maximum: 180 }
                ]
            }
        ]
    })
    const store = new FakeComponentStore({
        epoch: 'e1',
        revision: 0,
        props: { tag: 'pump-7' },
        state: { temperature: 21.5 },
        status: 'live',
        receivedAt: 1001
    })
    const definition = compiled.devices[0]
    if (!definition) throw new Error('compiled Device is missing')
    const runner = new SparkplugComponentProjectionRunner({ session, store, definition })

    await session.birth()
    const birth = await runner.start()
    if (!birth) throw new Error('runner did not publish DBIRTH')
    store.push({ ...store.getSnapshot(), revision: 1, state: { temperature: 22 }, receivedAt: 1002 })
    await runner.flush()

    const birthMetrics = decodeSparkplugPayload(birth.payload).metrics
    const dataMetrics = decodeSparkplugPayload(published[2]!.payload).metrics
    t.deepEqual(
        birthMetrics.map((metric) => ({ name: metric.name, alias: metric.alias, timestamp: metric.timestamp })),
        [
            { name: 'Properties/Tag', alias: 1, timestamp: 1001 },
            { name: 'State/Temperature', alias: 2, timestamp: 1001 }
        ]
    )
    t.deepEqual(birthMetrics[1]?.properties, {
        'source-rpc/maximum': { datatype: SparkplugDataType.Double, value: 180 },
        'source-rpc/minimum': { datatype: SparkplugDataType.Double, value: -40 },
        'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' }
    })
    t.deepEqual(
        dataMetrics.map((metric) => ({ name: metric.name, alias: metric.alias, timestamp: metric.timestamp, properties: metric.properties, value: metric.value })),
        [{ name: undefined, alias: 2, timestamp: 1002, properties: undefined, value: 22 }]
    )

    await session.handleNodeCommand({
        timestamp: 2001,
        metrics: [{ name: 'Node Control/Rebirth', datatype: SparkplugDataType.Boolean, value: true }]
    })
    const rebirth = decodeSparkplugPayload(published.at(-1)!.payload)
    t.deepEqual(
        rebirth.metrics.map((metric) => ({ name: metric.name, alias: metric.alias, value: metric.value, hasProperties: metric.properties !== undefined })),
        [
            { name: 'Properties/Tag', alias: 1, value: 'pump-7', hasProperties: false },
            { name: 'State/Temperature', alias: 2, value: 22, hasProperties: true }
        ]
    )

    await runner.close()
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

test('component projection keeps only the latest pending snapshot while MQTT publishing is busy', async (t) => {
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
    store.push({ epoch: 'e1', revision: 3, props: {}, state: { temperature: 24 }, status: 'live' })
    releases.shift()?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    releases.shift()?.()
    await runner.flush()

    const values = published
        .filter((frame) => frame.type === 'DDATA')
        .map((frame) => decodeSparkplugPayload(frame.payload).metrics[0]?.value)
    t.deepEqual(values, [22, 24])

    await runner.close()
})

test('component projection applies maxPublishHz without sleeping in tests', async (t) => {
    const published: SparkplugPublishFrame[] = []
    let now = 0
    const waits: number[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({ epoch: 'e1', revision: 0, props: {}, state: { temperature: 20 }, status: 'live' })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        store,
        definition: {
            deviceId: 'pump-7',
            maxPublishHz: 10,
            mappings: [{ path: 'state.temperature', name: 'State/Temperature' }]
        },
        scheduler: {
            now: () => now,
            wait: async (milliseconds) => {
                waits.push(milliseconds)
                now += milliseconds
            }
        }
    })

    await session.birth()
    await runner.start()
    store.push({ ...store.getSnapshot(), revision: 1, state: { temperature: 21 } })
    await runner.flush()
    store.push({ ...store.getSnapshot(), revision: 2, state: { temperature: 22 } })
    await runner.flush()

    t.deepEqual(waits, [100])
    t.deepEqual(
        published.filter((frame) => frame.type === 'DDATA').map((frame) => decodeSparkplugPayload(frame.payload).metrics[0]?.value),
        [21, 22]
    )
    await runner.close()
})

test('Device lifecycle transitions interrupt a maxPublishHz data wait', async (t) => {
    const published: SparkplugPublishFrame[] = []
    let releaseWaitStarted!: () => void
    const waitStarted = new Promise<void>((resolve) => (releaseWaitStarted = resolve))
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({ epoch: 'e1', revision: 0, props: {}, state: { temperature: 20 }, status: 'live' })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        store,
        definition: {
            deviceId: 'pump-7',
            maxPublishHz: 0.1,
            mappings: [{ path: 'state.temperature', name: 'State/Temperature' }]
        },
        scheduler: {
            now: () => 0,
            wait: (_milliseconds, signal) =>
                new Promise((resolve) => {
                    releaseWaitStarted()
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                })
        }
    })

    await session.birth()
    await runner.start()
    store.push({ ...store.getSnapshot(), revision: 1, state: { temperature: 21 } })
    await runner.flush()
    store.push({ ...store.getSnapshot(), revision: 2, state: { temperature: 22 } })
    await waitStarted
    store.push({ ...store.getSnapshot(), status: 'stale', staleSince: 2000 })
    await runner.flush()

    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDATA', 'DDEATH'])
    await runner.close()
})

test('component projection retains a failed latest snapshot for retry', async (t) => {
    const published: SparkplugPublishFrame[] = []
    let rejectData = true
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            if (frame.type === 'DDATA' && rejectData) {
                rejectData = false
                throw new Error('broker unavailable')
            }
            published.push(frame)
        }
    })
    const store = new FakeComponentStore({ epoch: 'e1', revision: 0, props: {}, state: { temperature: 20 }, status: 'live' })
    const runner = new SparkplugComponentProjectionRunner({
        session,
        deviceId: 'pump-7',
        store,
        mappings: [{ path: 'state.temperature', name: 'State/Temperature' }]
    })

    await session.birth()
    await runner.start()
    store.push({ ...store.getSnapshot(), revision: 1, state: { temperature: 22 } })
    await t.throwsAsync(runner.flush(), { message: 'broker unavailable' })
    await runner.retry()

    t.deepEqual(
        published.filter((frame) => frame.type === 'DDATA').map((frame) => decodeSparkplugPayload(frame.payload).metrics[0]?.value),
        [22]
    )
    await runner.close()
})
