import {
    RpcComponent,
    RpcServer,
    rpc,
    rpcNamespace,
    type RpcInvocationHandle,
    type RpcSchema
} from '@source-repo/rpc'
import anyTest, { type TestFn } from 'ava'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { connectAsync } from 'mqtt'
import { SparkplugSourceRpcCommandRunner, type SparkplugCommandAuditEvent } from './Command.js'
import { SourceSparkGateway } from './Gateway.js'
import { encodeSparkplugPayload, decodeSparkplugPayload } from './Protobuf.js'
import { SparkplugComponentProjectionRunner } from './Projection.js'
import { compileSparkplugProjectionContract } from './ProjectionContract.js'
import { sourceRpcComponentStore } from './SourceRpc.js'
import { SparkplugDataType, deviceTopic } from './Types.js'

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

const run = randomUUID().slice(0, 8)
const name = (prefix: string) => `${prefix}-${run}`

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

@rpcNamespace('pump')
class CommandPump extends RpcComponent<Record<string, never>, { temperature: number }> {
    readonly calls: number[] = []
    readonly callers: string[] = []

    constructor() {
        super({}, { temperature: 5 })
    }

    @rpc({ semantics: 'idempotent-command', effect: 'operate', injectInvocation: true })
    async setTemperature(value: number, invocation?: RpcInvocationHandle): Promise<number> {
        this.calls.push(value)
        this.callers.push(invocation?.context.identity?.name ?? invocation?.context.source ?? 'unknown')
        if (value !== this.state.temperature) this.setState({ temperature: value })
        return value
    }
}

const pumpSchema: RpcSchema = {
    schema: 1,
    namespaces: {
        pump: {
            methods: {
                setTemperature: {
                    params: [{ kind: 'number', min: 0, max: 10 }],
                    returns: { kind: 'number' },
                    semantics: 'idempotent-command',
                    effect: 'operate'
                }
            },
            component: {
                snapshot: 1,
                props: { kind: 'object', fields: {} },
                state: { kind: 'object', fields: { temperature: { type: { kind: 'number', min: 0, max: 10 } } } }
            }
        }
    }
}

interface Context {
    skipped: boolean
}

const test = anyTest as TestFn<Context>

test.before(async (t) => {
    const available = await brokerAvailable()
    if (!available && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
    t.context = { skipped: !available }
})

test.serial('mqtt: DCMD reaches Source RPC as the gateway principal and is confirmed by reported DDATA', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }

    const serverName = name('pump-controller')
    const runtimeId = name('source-edge')
    const groupId = name('plant')
    const edgeNodeId = name('source-gateway')
    const deviceId = 'pump-7'
    const server = new RpcServer({
        name: serverName,
        transports: [{ brokerurl: BROKER_URL }],
        schema: pumpSchema,
        exposeIntrospection: true
    })
    const pump = new CommandPump()
    server.exposeClassInstance(pump)
    const resources: {
        gateway?: SourceSparkGateway
        projection?: SparkplugComponentProjectionRunner
        commands?: SparkplugSourceRpcCommandRunner
        host?: Awaited<ReturnType<typeof connectAsync>>
    } = {}
    t.teardown(async () => {
        await resources.commands?.close().catch(() => undefined)
        await resources.projection?.close().catch(() => undefined)
        await resources.gateway?.close().catch(() => undefined)
        await resources.host?.endAsync().catch(() => undefined)
        await server.close().catch(() => undefined)
    })
    await server.ready()

    const compiled = compileSparkplugProjectionContract({
        schema: 1,
        groupId,
        edgeNodeId,
        devices: [
            {
                deviceId,
                source: { peer: serverName, component: 'pump' },
                metrics: [
                    {
                        name: 'State/Temperature',
                        path: 'state.temperature',
                        datatype: 'Double',
                        unit: 'degC',
                        minimum: 0,
                        maximum: 10,
                        writable: { method: 'setTemperature', deadlineMs: 3000, maxCommandsPerSecond: 1000 }
                    }
                ]
            }
        ]
    })
    const definition = compiled.devices[0]!
    const audit: SparkplugCommandAuditEvent[] = []
    const dataValues: number[] = []
    const host = (resources.host = await connectAsync(BROKER_URL, { clientId: name('scada-host'), clean: true, reconnectPeriod: 0 }))
    host.on('message', (topic, bytes) => {
        if (topic !== deviceTopic('DDATA', { groupId, edgeNodeId, deviceId })) return
        const value = decodeSparkplugPayload(new Uint8Array(bytes)).metrics[0]?.value
        if (typeof value === 'number') dataValues.push(value)
    })
    await host.subscribeAsync(deviceTopic('DBIRTH', { groupId, edgeNodeId, deviceId }), { qos: 0 })
    await host.subscribeAsync(deviceTopic('DDATA', { groupId, edgeNodeId, deviceId }), { qos: 0 })

    const gateway = (resources.gateway = await SourceSparkGateway.connect({ url: BROKER_URL, runtimeId, groupId, edgeNodeId }))
    const remote = await gateway.rpc.component<CommandPump>('pump', serverName)
    const projection = (resources.projection = new SparkplugComponentProjectionRunner({
        session: gateway.sparkplug.session,
        store: sourceRpcComponentStore(remote),
        definition
    }))
    await projection.start()
    const commands = (resources.commands = new SparkplugSourceRpcCommandRunner({
        edge: gateway.sparkplug,
        client: gateway.rpc,
        devices: [{ definition, projection }],
        onAudit: (event) => {
            audit.push(event)
        }
    }))
    await commands.start()

    const commandTopic = deviceTopic('DCMD', { groupId, edgeNodeId, deviceId })
    const alias = definition.writable[0]!.alias
    const publish = async (value: number) => {
        const payload = encodeSparkplugPayload({
            timestamp: Date.now(),
            metrics: [{ alias, datatype: SparkplugDataType.Double, value }]
        })
        await host!.publishAsync(commandTopic, Buffer.from(payload), { qos: 0, retain: false })
    }

    await publish(11)
    await waitFor(() => audit.some((event) => event.outcome === 'refused'))
    t.deepEqual(pump.calls, [], 'out-of-range DCMD crossed the gateway boundary')

    await new Promise((resolve) => setTimeout(resolve, 2))
    await publish(6)
    await waitFor(() => audit.filter((event) => event.outcome === 'confirmed').length === 1 && dataValues.includes(6))
    t.deepEqual(pump.calls, [6])
    t.deepEqual(pump.callers, [`${runtimeId}-rpc`])

    const dataBeforeSameValue = dataValues.length
    await new Promise((resolve) => setTimeout(resolve, 2))
    await publish(6)
    await waitFor(() => audit.filter((event) => event.outcome === 'confirmed').length === 2 && dataValues.length > dataBeforeSameValue)
    t.deepEqual(pump.calls, [6, 6])
    t.deepEqual(pump.callers, [`${runtimeId}-rpc`, `${runtimeId}-rpc`])

    const accepted = audit.find((event) => event.outcome === 'accepted')!
    t.is(accepted.topic, commandTopic)
    t.is(accepted.gatewayClientId, `${runtimeId}-sparkplug`)
    t.true(accepted.payloadBytes.length > 0)
    t.false(Object.hasOwn(accepted, 'publisherClientId'), 'MQTT delivery invented a publisher identity')
})
