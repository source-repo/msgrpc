import test from 'ava'
import type { RpcProxy, ServerDescription } from '@source-repo/rpc'
import { SparkplugSourceRpcCommandRunner, type SparkplugCommandAuditEvent, type SparkplugSourceRpcCommandClient } from './Command.js'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import type { MqttSparkplugDeviceCommand, MqttSparkplugDeviceCommandHandler, MqttSparkplugEdgeNodeSession } from './MqttEdgeNodeSession.js'
import { encodeSparkplugPayload } from './Protobuf.js'
import { SparkplugComponentProjectionRunner, type SparkplugComponentProjectionStore, type SparkplugComponentProjectionView } from './Projection.js'
import { compileSparkplugProjectionContract, type SparkplugCompiledDeviceProjection } from './ProjectionContract.js'
import { SparkplugDataType, deviceTopic } from './Types.js'

class Store implements SparkplugComponentProjectionStore {
    #snapshot: SparkplugComponentProjectionView = {
        epoch: 'pump-epoch',
        revision: 0,
        props: {},
        state: { temperature: 5 },
        status: 'live',
        receivedAt: Date.now()
    }
    readonly #listeners = new Set<() => void>()

    getSnapshot(): SparkplugComponentProjectionView {
        return this.#snapshot
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    setTemperature(temperature: number): void {
        if (temperature === this.#snapshot.state.temperature) return
        this.#snapshot = {
            ...this.#snapshot,
            revision: this.#snapshot.revision + 1,
            state: { temperature },
            receivedAt: Date.now()
        }
        for (const listener of this.#listeners) listener()
    }

    async close(): Promise<void> {}
}

const compiledDevice = (writable = true, deadlineMs = 3000): SparkplugCompiledDeviceProjection => {
    const compiled = compileSparkplugProjectionContract({
        schema: 1,
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        devices: [
            {
                deviceId: 'pump-7',
                source: { peer: 'pump-controller', component: 'pump' },
                metrics: [
                    {
                        name: 'State/Temperature',
                        path: 'state.temperature',
                        datatype: 'Double',
                        unit: 'degC',
                        minimum: 0,
                        maximum: 10,
                        ...(writable ? { writable: { method: 'setTemperature', deadlineMs, maxCommandsPerSecond: 1000 } } : {})
                    }
                ]
            }
        ]
    })
    return compiled.devices[0]!
}

const description = (method: Partial<ServerDescription['namespaces'][number]['methods'][number]> = {}): ServerDescription => ({
    name: 'pump-controller',
    validating: true,
    namespaces: [
        {
            name: 'pump',
            created: false,
            emitter: false,
            methods: [
                {
                    name: 'setTemperature',
                    params: [{ kind: 'number', min: 0, max: 10 }],
                    semantics: 'idempotent-command',
                    effect: 'operate',
                    ...method
                }
            ],
            events: []
        }
    ]
})

const fakeEdge = () => {
    let handler: MqttSparkplugDeviceCommandHandler | undefined
    const edge = {
        setDeviceCommandHandler(next: MqttSparkplugDeviceCommandHandler) {
            if (handler) throw new Error('handler already registered')
            handler = next
            return () => {
                if (handler === next) handler = undefined
            }
        }
    } as unknown as MqttSparkplugEdgeNodeSession
    return { edge, deliver: (command: MqttSparkplugDeviceCommand) => handler?.(command) }
}

const fakeClient = (describe: ServerDescription, invoke: (value: number) => Promise<void>): SparkplugSourceRpcCommandClient => {
    const surface = new Proxy(
        {},
        {
            get: (_target, property) => {
                if (property === '$with') return () => surface
                if (property === 'setTemperature') return (value: number) => invoke(value)
                return undefined
            }
        }
    ) as RpcProxy<Record<string, (value: unknown) => Promise<unknown>>>
    return {
        proxy: async <T>(name: string) => (name === 'msgrpc' ? ({ describe: async () => describe } as T) : (surface as T)) as RpcProxy<T>
    }
}

const command = (metrics: MqttSparkplugDeviceCommand['payload']['metrics']): MqttSparkplugDeviceCommand => {
    const payload = { timestamp: Date.now(), metrics }
    return {
        topic: deviceTopic('DCMD', { groupId: 'plant-a', edgeNodeId: 'edge-01', deviceId: 'pump-7' }),
        deviceId: 'pump-7',
        payload,
        payloadBytes: encodeSparkplugPayload(payload),
        gatewayClientId: 'source-edge-01-sparkplug',
        receivedAt: Date.now()
    }
}

const setup = async (options: { deadlineMs?: number; perform?: (value: number, store: Store) => Promise<void> } = {}) => {
    const frames: SparkplugPublishFrame[] = []
    const store = new Store()
    const definition = compiledDevice(true, options.deadlineMs)
    const session = new SparkplugEdgeNodeSession({
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        publish: (frame) => {
            frames.push(frame)
        }
    })
    await session.birth()
    const projection = new SparkplugComponentProjectionRunner({ session, store, definition })
    await projection.start()
    const calls: number[] = []
    const edge = fakeEdge()
    const audit: SparkplugCommandAuditEvent[] = []
    const runner = new SparkplugSourceRpcCommandRunner({
        edge: edge.edge,
        client: fakeClient(description(), async (value) => {
            calls.push(value)
            if (options.perform) await options.perform(value, store)
            else store.setTemperature(value)
        }),
        devices: [{ definition, projection }],
        onAudit: (event) => {
            audit.push(event)
        }
    })
    await runner.start()
    return { frames, store, definition, projection, calls, edge, audit, runner }
}

test('valid and same-value DCMDs are confirmed through reported DDATA', async (t) => {
    const harness = await setup()
    const alias = harness.definition.writable[0]!.alias
    await harness.edge.deliver(
        command([
            {
                alias,
                datatype: SparkplugDataType.Double,
                properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'degC' } },
                value: 6
            }
        ])
    )
    t.deepEqual(harness.calls, [6])
    t.deepEqual(harness.audit.map((event) => event.outcome), ['accepted', 'confirmed'])
    t.is(harness.frames.filter((frame) => frame.type === 'DDATA').length, 1)

    await new Promise((resolve) => setTimeout(resolve, 2))
    await harness.edge.deliver(command([{ alias, datatype: SparkplugDataType.Double, value: 6 }]))
    t.deepEqual(harness.calls, [6, 6])
    t.deepEqual(harness.audit.map((event) => event.outcome), ['accepted', 'confirmed', 'accepted', 'confirmed'])
    t.is(harness.frames.filter((frame) => frame.type === 'DDATA').length, 2, 'same-value command did not republish its current state')

    await harness.runner.close()
    await harness.projection.close()
})

test('DCMD is fully prevalidated before any mapped RPC call', async (t) => {
    const harness = await setup()
    const alias = harness.definition.writable[0]!.alias

    await harness.runner.handle(command([{ alias, datatype: SparkplugDataType.Double, value: 11 }]))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await harness.runner.handle(
        command([
            { alias, datatype: SparkplugDataType.Double, value: 6 },
            { name: 'State/NotWritable', datatype: SparkplugDataType.Double, value: 1 }
        ])
    )
    await new Promise((resolve) => setTimeout(resolve, 2))
    await harness.runner.handle(
        command([
            {
                alias,
                datatype: SparkplugDataType.Double,
                properties: { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: 'psi' } },
                value: 6
            }
        ])
    )

    t.deepEqual(harness.calls, [])
    t.deepEqual(harness.audit.map((event) => event.outcome), ['refused', 'refused', 'refused'])
    t.regex(harness.audit[0]?.reason ?? '', /above maximum/)
    t.regex(harness.audit[1]?.reason ?? '', /not writable/)
    t.regex(harness.audit[2]?.reason ?? '', /does not match/)

    await harness.runner.close()
    await harness.projection.close()
})

test('reported state confirms a command even when its RPC response is lost', async (t) => {
    const harness = await setup({
        deadlineMs: 100,
        perform: async (value, store) => {
            store.setTemperature(value)
            await new Promise<void>(() => undefined)
        }
    })
    const alias = harness.definition.writable[0]!.alias

    await harness.runner.handle(command([{ alias, datatype: SparkplugDataType.Double, value: 6 }]))

    t.deepEqual(harness.calls, [6])
    t.deepEqual(harness.audit.map((event) => event.outcome), ['accepted', 'confirmed'])
    t.is(harness.frames.filter((frame) => frame.type === 'DDATA').length, 1)
    await harness.runner.close()
    await harness.projection.close()
})

test('a successful RPC call without reported state becomes an unknown outcome', async (t) => {
    const harness = await setup({ deadlineMs: 25, perform: async () => undefined })
    const alias = harness.definition.writable[0]!.alias

    await harness.runner.handle(command([{ alias, datatype: SparkplugDataType.Double, value: 6 }]))

    t.deepEqual(harness.calls, [6])
    t.deepEqual(harness.audit.map((event) => event.outcome), ['accepted', 'unknown'])
    t.regex(harness.audit[1]?.reason ?? '', /did not reach reported state/)
    await harness.runner.close()
    await harness.projection.close()
})

test('startup refuses non-idempotent and authority-gated methods', async (t) => {
    const definition = compiledDevice()
    const projection = {} as SparkplugComponentProjectionRunner
    for (const unsafe of [{ semantics: 'query' as const }, { requiresAuthority: true }]) {
        const edge = fakeEdge()
        const runner = new SparkplugSourceRpcCommandRunner({
            edge: edge.edge,
            client: fakeClient(description(unsafe), async () => undefined),
            devices: [{ definition, projection }]
        })
        await t.throwsAsync(runner.start(), { message: unsafe.requiresAuthority ? /requires authority/ : /idempotent-command/ })
    }
})

test('an empty writable allowlist starts without Source RPC introspection', async (t) => {
    const definition = compiledDevice(false)
    const edge = fakeEdge()
    const audit: SparkplugCommandAuditEvent[] = []
    const runner = new SparkplugSourceRpcCommandRunner({
        edge: edge.edge,
        client: { proxy: async () => Promise.reject(new Error('introspection should not be called')) },
        devices: [{ definition, projection: {} as SparkplugComponentProjectionRunner }],
        onAudit: (event) => {
            audit.push(event)
        }
    })
    await runner.start()
    await edge.deliver(command([{ alias: 1, datatype: SparkplugDataType.Double, value: 6 }]))
    t.deepEqual(audit.map((event) => event.outcome), ['refused'])
    await runner.close()
})
