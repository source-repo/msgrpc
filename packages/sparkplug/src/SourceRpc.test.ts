import test from 'ava'
import { RpcClient, RpcComponent, RpcServer, rpcComponent, type RpcComponentProxy } from '@source-repo/rpc'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugComponentProjectionRunner } from './Projection.js'
import { compileSparkplugProjectionContract } from './ProjectionContract.js'
import { sourceRpcComponentStore } from './SourceRpc.js'
import type { SparkplugComponentProjectionStore } from './Projection.js'

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
    t.is(published.at(-1)?.topic, 'spBv1.0/DDATA/plant-a/edge-01/pump-7')

    await runner.close()
    runner = undefined
})
