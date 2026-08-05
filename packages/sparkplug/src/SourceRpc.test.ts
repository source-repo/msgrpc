import test from 'ava'
import { RpcClient, RpcComponent, RpcServer, TransportEvent, rpcComponent, type RpcComponentProxy } from '@source-repo/rpc'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugComponentProjectionRunner } from './Projection.js'
import { compileSparkplugProjectionContract } from './ProjectionContract.js'
import { SparkplugSourceRpcProjectionRevalidator, sourceRpcComponentStore } from './SourceRpc.js'
import type { SparkplugComponentProjectionStore } from './Projection.js'
import { SparkplugDataType } from './Types.js'

interface Pump {
    readonly props: { tag: string }
    readonly state: { temperature: number }
}

test('Source RPC component proxies expose the store used by the projection runner', (t) => {
    const store: SparkplugComponentProjectionStore = {
        getSnapshot: () => ({ epoch: 'e1', revision: 0, props: { tag: 'pump-7' }, state: { temperature: 21.5 }, status: 'live' }),
        subscribe: () => () => undefined,
        close: async () => undefined
    }
    const component = { [rpcComponent]: store } as unknown as RpcComponentProxy<Pump>

    t.is(sourceRpcComponentStore(component), store)
})

class LivePump extends RpcComponent<{ tag: string }, { temperature: number }> {
    constructor() {
        super({ tag: 'pump-7' }, { temperature: 21.5 })
    }

    updateTemperature(temperature: number): void {
        this.setState({ temperature })
    }
}

const waitFor = async (condition: () => boolean, timeout = 5000): Promise<void> => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

test.serial('Source RPC owner churn does not change the projected Device identity or lifecycle', async (t) => {
    const serverName = `sparkplug-owner-host-${Date.now()}`
    const server = new RpcServer({ name: serverName, transports: [{ port: 3947 }] })
    const client = new RpcClient('http://localhost:3947', { name: `sparkplug-owner-gateway-${Date.now()}`, defaultTarget: serverName })
    let runner: SparkplugComponentProjectionRunner | undefined
    t.teardown(async () => {
        await runner?.close().catch(() => undefined)
        await client.close().catch(() => undefined)
        await server.close().catch(() => undefined)
    })
    await server.ready()
    const pump = new LivePump()
    server.exposeClassInstance(pump, 'pump')
    const initialTopology = await server.topology.declare('pump', { owner: { peer: 'mes', instance: 'line-a' } })

    await client.ready()
    const compiled = compileSparkplugProjectionContract({
        schema: 1,
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        devices: [
            {
                deviceId: 'pump-7',
                source: { peer: serverName, component: 'pump' },
                metrics: [{ name: 'State/Temperature', path: 'state.temperature', datatype: 'Double' }]
            }
        ]
    })
    const definition = compiled.devices[0]
    if (!definition) throw new Error('compiled Device is missing')
    const remote = await client.component<LivePump>(definition.source.component, definition.source.peer)
    const store = sourceRpcComponentStore(remote)
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: compiled.contract.groupId,
        edgeNodeId: compiled.contract.edgeNodeId,
        publish: (frame) => {
            published.push(frame)
        }
    })
    runner = new SparkplugComponentProjectionRunner({ session, store, definition })

    await session.birth()
    await runner.start()
    const beforeOwnerChange = store.getSnapshot()
    await server.topology.update('pump', { owner: { peer: 'mes', instance: 'maintenance' } }, { expectedVersion: initialTopology.version })
    await new Promise((resolve) => setTimeout(resolve, 50))

    t.is(store.getSnapshot().epoch, beforeOwnerChange.epoch)
    t.is(store.getSnapshot().revision, beforeOwnerChange.revision)
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH'])

    pump.updateTemperature(22)
    await waitFor(() => published.some((frame) => frame.type === 'DDATA'))
    await runner.flush()

    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'DDATA'])
    t.is(published.at(-1)?.topic, 'spBv1.0/plant-a/DDATA/edge-01/pump-7')

    await runner.close()
    runner = undefined
})

test.serial('peerShape revalidation rebirths only when the canonical projection hash changes', async (t) => {
    const serverName = `sparkplug-shape-host-${Date.now()}`
    const server = new RpcServer({ name: serverName, transports: [{ port: 3948 }] })
    const client = new RpcClient('http://localhost:3948', { name: `sparkplug-shape-gateway-${Date.now()}`, defaultTarget: serverName })
    let runner: SparkplugComponentProjectionRunner | undefined
    let revalidator: SparkplugSourceRpcProjectionRevalidator | undefined
    t.teardown(async () => {
        await revalidator?.close().catch(() => undefined)
        await runner?.close().catch(() => undefined)
        await client.close().catch(() => undefined)
        await server.close().catch(() => undefined)
    })
    server.exposeClassInstance(new LivePump(), 'pump')
    await server.ready()
    await client.peersSettled()
    await waitFor(() => client.peers.shapeOf(serverName) !== undefined)

    const projectionContract = {
        schema: 1,
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        devices: [
            {
                deviceId: 'pump-7',
                source: { peer: serverName, component: 'pump' },
                metrics: [{ name: 'State/Temperature', path: 'state.temperature', datatype: 'Double' }]
            }
        ]
    }
    let sourceFragmentVersion = 1
    const compile = () => compileSparkplugProjectionContract(projectionContract, { sourceContractFragments: { temperature: sourceFragmentVersion } })
    const compiled = compile()
    const definition = compiled.devices[0]
    if (!definition) throw new Error('compiled Device is missing')
    const remote = await client.component<LivePump>(definition.source.component, definition.source.peer)
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: compiled.contract.groupId,
        edgeNodeId: compiled.contract.edgeNodeId,
        maxPacketBytes: compiled.maxPacketBytes,
        publish: (frame) => {
            published.push(frame)
        }
    })
    runner = new SparkplugComponentProjectionRunner({ session, store: sourceRpcComponentStore(remote), definition })
    await session.birth()
    await runner.start()

    let recompileCount = 0
    const revalidationErrors: unknown[] = []
    revalidator = new SparkplugSourceRpcProjectionRevalidator({
        client,
        session,
        compiled,
        recompile: () => {
            recompileCount++
            return compile()
        },
        onError: (error) => revalidationErrors.push(error)
    })
    revalidator.start()

    server.exposeClassInstance(new LivePump(), 'unprojected-one')
    await waitFor(() => recompileCount === 1)
    await revalidator.flush()
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH'])

    sourceFragmentVersion = 2
    server.exposeClassInstance(new LivePump(), 'unprojected-two')
    await waitFor(() => published.filter((frame) => frame.type === 'NBIRTH').length === 2)
    await revalidator.flush()

    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH', 'NBIRTH', 'DBIRTH'])
    t.is(revalidator.compiled.hash, compile().hash)
    t.deepEqual(revalidationErrors, [])

    await revalidator.close()
    revalidator = undefined
    await runner.close()
    runner = undefined
})

test('a running projection refuses mapping changes instead of rebirthing stale definitions', async (t) => {
    const projectionContract = {
        schema: 1,
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        devices: [
            {
                deviceId: 'pump-7',
                source: { peer: 'pump-controller', component: 'pump' },
                metrics: [{ name: 'State/Temperature', path: 'state.temperature', datatype: 'Double' }]
            }
        ]
    }
    const compiled = compileSparkplugProjectionContract(projectionContract)
    const changed = compileSparkplugProjectionContract({
        ...projectionContract,
        devices: [
            {
                ...projectionContract.devices[0],
                metrics: [{ name: 'State/TemperatureC', path: 'state.temperature', datatype: 'Double' }]
            }
        ]
    })
    const published: SparkplugPublishFrame[] = []
    const session = new SparkplugEdgeNodeSession({
        groupId: compiled.contract.groupId,
        edgeNodeId: compiled.contract.edgeNodeId,
        publish: (frame) => {
            published.push(frame)
        }
    })
    await session.birth()
    await session.deviceBirth('pump-7', [{ name: 'State/Temperature', datatype: SparkplugDataType.Double, value: 21.5 }])
    const client = {
        on: (_event: typeof TransportEvent.peerShape, _listener: (peer: string, shape: string) => void) => undefined,
        off: (_event: typeof TransportEvent.peerShape, _listener: (peer: string, shape: string) => void) => undefined
    }
    const revalidator = new SparkplugSourceRpcProjectionRevalidator({ client, session, compiled, recompile: () => changed })

    await t.throwsAsync(revalidator.revalidate(), { message: /contract changed.*restart the projection runners/ })
    t.deepEqual(published.map((frame) => frame.type), ['NBIRTH', 'DBIRTH'])
    await revalidator.close()
})
