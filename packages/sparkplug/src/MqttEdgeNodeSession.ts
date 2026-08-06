import { Buffer } from 'node:buffer'
import type { IClientOptions, MqttClient } from 'mqtt'
import { connectAsync } from 'mqtt'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugBirthDeathSequence, SparkplugSequence } from './Sequence.js'
import type { SparkplugMetric, SparkplugPayload } from './Payload.js'
import { decodeSparkplugPayload } from './Protobuf.js'
import { decodeHostStatePayload, deviceCommandTopicFilter, hostStateTopic, nodeTopic, parseSparkplugTopic, type SparkplugHostState } from './Types.js'

export interface MqttSparkplugDeviceCommand {
    readonly topic: string
    readonly deviceId: string
    readonly payload: SparkplugPayload
    readonly payloadBytes: Uint8Array
    readonly gatewayClientId: string
    readonly receivedAt: number
}

export type MqttSparkplugDeviceCommandHandler = (command: MqttSparkplugDeviceCommand) => void | Promise<void>

export interface MqttSparkplugEdgeNodeSessionOptions {
    readonly url: string
    readonly groupId: string
    readonly edgeNodeId: string
    readonly clientId?: string
    readonly mqtt?: IClientOptions
    readonly now?: () => number
    readonly seq?: SparkplugSequence
    readonly bdSeq?: SparkplugBirthDeathSequence
    readonly maxPacketBytes?: number
    readonly birthMetrics?: readonly SparkplugMetric[]
    readonly primaryHostId?: string
    readonly onPrimaryHostState?: (state: SparkplugHostState) => void | Promise<void>
    readonly onDeviceCommand?: MqttSparkplugDeviceCommandHandler
}

export class MqttSparkplugEdgeNodeSession {
    readonly client: MqttClient
    readonly session: SparkplugEdgeNodeSession
    readonly will: SparkplugPublishFrame
    readonly birthMetrics: readonly SparkplugMetric[]
    readonly primaryHostTopic?: string
    #primaryHostState?: SparkplugHostState
    #onPrimaryHostState?: (state: SparkplugHostState) => void | Promise<void>
    #primaryHostQueue = Promise.resolve()
    #deviceCommandQueue = Promise.resolve()
    #onDeviceCommand?: MqttSparkplugDeviceCommandHandler

    private constructor(
        client: MqttClient,
        session: SparkplugEdgeNodeSession,
        will: SparkplugPublishFrame,
        birthMetrics: readonly SparkplugMetric[],
        primaryHostTopic: string | undefined,
        onPrimaryHostState: ((state: SparkplugHostState) => void | Promise<void>) | undefined,
        onDeviceCommand: MqttSparkplugDeviceCommandHandler | undefined
    ) {
        this.client = client
        this.session = session
        this.will = will
        this.birthMetrics = birthMetrics
        this.primaryHostTopic = primaryHostTopic
        this.#onPrimaryHostState = onPrimaryHostState
        this.#onDeviceCommand = onDeviceCommand
    }

    get primaryHostState(): SparkplugHostState | undefined {
        return this.#primaryHostState
    }

    static async connect(options: MqttSparkplugEdgeNodeSessionOptions): Promise<MqttSparkplugEdgeNodeSession> {
        const connection: { client?: MqttClient } = {}
        const session = new SparkplugEdgeNodeSession({
            groupId: options.groupId,
            edgeNodeId: options.edgeNodeId,
            now: options.now,
            seq: options.seq,
            bdSeq: options.bdSeq,
            maxPacketBytes: options.maxPacketBytes,
            publish: async (frame) => {
                if (!connection.client) throw new Error('Sparkplug MQTT client is not connected')
                await connection.client.publishAsync(frame.topic, Buffer.from(frame.payload), { qos: frame.qos, retain: frame.retain })
            }
        })
        const will = session.nodeWill()
        const client = await connectAsync(options.url, {
            clientId: options.clientId ?? `${options.edgeNodeId}-sparkplug`,
            clean: true,
            reconnectPeriod: 0,
            ...options.mqtt,
            will: {
                topic: will.topic,
                payload: Buffer.from(will.payload),
                qos: 1,
                retain: false,
                ...options.mqtt?.will
            }
        })
        connection.client = client
        const commandTopic = nodeTopic('NCMD', session)
        const deviceCommandTopic = deviceCommandTopicFilter(session)
        const primaryHostTopic = options.primaryHostId ? hostStateTopic(options.primaryHostId) : undefined
        const edge = new MqttSparkplugEdgeNodeSession(
            client,
            session,
            will,
            options.birthMetrics ?? [],
            primaryHostTopic,
            options.onPrimaryHostState,
            options.onDeviceCommand
        )
        client.on('message', (topic, payload) => {
            if (topic === commandTopic) {
                void edge.handleNodeCommand(new Uint8Array(payload)).catch((error: unknown) => edge.emitClientError(error))
                return
            }
            const parsed = parseSparkplugTopic(topic)
            if (parsed?.type === 'DCMD' && parsed.groupId === session.groupId && parsed.edgeNodeId === session.edgeNodeId && parsed.deviceId) {
                void edge.queueDeviceCommand(topic, parsed.deviceId, new Uint8Array(payload), Date.now()).catch((error: unknown) => edge.emitClientError(error))
                return
            }
            if (topic === primaryHostTopic) void edge.queuePrimaryHostState(new Uint8Array(payload)).catch((error: unknown) => edge.emitClientError(error))
        })
        await client.subscribeAsync(commandTopic, { qos: 0 })
        await client.subscribeAsync(deviceCommandTopic, { qos: 0 })
        if (primaryHostTopic) await client.subscribeAsync(primaryHostTopic, { qos: 1 })
        if (!primaryHostTopic) await session.birth(edge.birthMetrics)
        return edge
    }

    private async handleNodeCommand(payload: Uint8Array): Promise<void> {
        await this.session.handleNodeCommand(decodeSparkplugPayload(payload))
    }

    private async handlePrimaryHostState(payload: Uint8Array): Promise<void> {
        if (!this.primaryHostTopic) return
        const parsed = this.primaryHostTopic.split('/')
        const hostId = parsed[2]
        if (!hostId) return
        const state = decodeHostStatePayload(hostId, payload)
        if (this.#primaryHostState?.timestamp !== undefined && state.timestamp !== undefined && state.timestamp < this.#primaryHostState.timestamp) return
        this.#primaryHostState = state
        await this.#onPrimaryHostState?.(state)
        if (state.online && !this.session.born) {
            await this.session.resume(this.birthMetrics)
        } else if (!state.online && this.session.born) {
            await this.session.suspend()
        }
    }

    private queuePrimaryHostState(payload: Uint8Array): Promise<void> {
        const pending = this.#primaryHostQueue.then(
            () => this.handlePrimaryHostState(payload),
            () => this.handlePrimaryHostState(payload)
        )
        this.#primaryHostQueue = pending.then(
            () => undefined,
            () => undefined
        )
        return pending
    }

    /** Register the one projection firewall allowed to consume DCMD. With no handler, DCMD is ignored. */
    setDeviceCommandHandler(handler: MqttSparkplugDeviceCommandHandler): () => void {
        if (this.#onDeviceCommand && this.#onDeviceCommand !== handler) throw new Error('a Sparkplug Device command handler is already registered')
        this.#onDeviceCommand = handler
        return () => {
            if (this.#onDeviceCommand === handler) this.#onDeviceCommand = undefined
        }
    }

    private queueDeviceCommand(topic: string, deviceId: string, payloadBytes: Uint8Array, receivedAt: number): Promise<void> {
        const pending = this.#deviceCommandQueue.then(
            () => this.handleDeviceCommand(topic, deviceId, payloadBytes, receivedAt),
            () => this.handleDeviceCommand(topic, deviceId, payloadBytes, receivedAt)
        )
        this.#deviceCommandQueue = pending.then(
            () => undefined,
            () => undefined
        )
        return pending
    }

    private async handleDeviceCommand(topic: string, deviceId: string, payloadBytes: Uint8Array, receivedAt: number): Promise<void> {
        const handler = this.#onDeviceCommand
        if (!handler) return
        await handler({
            topic,
            deviceId,
            payload: decodeSparkplugPayload(payloadBytes),
            payloadBytes,
            gatewayClientId: this.client.options.clientId ?? 'unknown',
            receivedAt
        })
    }

    private emitClientError(error: unknown): void {
        this.client.emit('error', error instanceof Error ? error : new Error(String(error)))
    }

    async close(): Promise<void> {
        try {
            await Promise.all([this.#primaryHostQueue, this.#deviceCommandQueue])
            if (this.session.born) await this.session.suspend()
        } finally {
            await this.client.endAsync()
        }
    }
}
