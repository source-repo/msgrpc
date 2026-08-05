import { Buffer } from 'node:buffer'
import type { IClientOptions, MqttClient } from 'mqtt'
import { connectAsync } from 'mqtt'
import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugBirthDeathSequence, SparkplugSequence } from './Sequence.js'
import type { SparkplugMetric } from './Payload.js'
import { decodeSparkplugPayload } from './Protobuf.js'
import { decodeHostStatePayload, hostStateTopic, nodeTopic, type SparkplugHostState } from './Types.js'

export interface MqttSparkplugEdgeNodeSessionOptions {
    readonly url: string
    readonly groupId: string
    readonly edgeNodeId: string
    readonly clientId?: string
    readonly mqtt?: IClientOptions
    readonly now?: () => number
    readonly seq?: SparkplugSequence
    readonly bdSeq?: SparkplugBirthDeathSequence
    readonly birthMetrics?: readonly SparkplugMetric[]
    readonly primaryHostId?: string
    readonly onPrimaryHostState?: (state: SparkplugHostState) => void | Promise<void>
}

export class MqttSparkplugEdgeNodeSession {
    readonly client: MqttClient
    readonly session: SparkplugEdgeNodeSession
    readonly will: SparkplugPublishFrame
    readonly birthMetrics: readonly SparkplugMetric[]
    readonly primaryHostTopic?: string
    #primaryHostState?: SparkplugHostState
    #onPrimaryHostState?: (state: SparkplugHostState) => void | Promise<void>

    private constructor(
        client: MqttClient,
        session: SparkplugEdgeNodeSession,
        will: SparkplugPublishFrame,
        birthMetrics: readonly SparkplugMetric[],
        primaryHostTopic: string | undefined,
        onPrimaryHostState: ((state: SparkplugHostState) => void | Promise<void>) | undefined
    ) {
        this.client = client
        this.session = session
        this.will = will
        this.birthMetrics = birthMetrics
        this.primaryHostTopic = primaryHostTopic
        this.#onPrimaryHostState = onPrimaryHostState
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
        const primaryHostTopic = options.primaryHostId ? hostStateTopic(options.primaryHostId) : undefined
        const edge = new MqttSparkplugEdgeNodeSession(client, session, will, options.birthMetrics ?? [], primaryHostTopic, options.onPrimaryHostState)
        await client.subscribeAsync(commandTopic, { qos: 0 })
        if (primaryHostTopic) await client.subscribeAsync(primaryHostTopic, { qos: 1 })
        client.on('message', (topic, payload) => {
            if (topic === commandTopic) {
                void edge.handleNodeCommand(new Uint8Array(payload)).catch((error: unknown) => edge.emitClientError(error))
                return
            }
            if (topic === primaryHostTopic) void edge.handlePrimaryHostState(new Uint8Array(payload)).catch((error: unknown) => edge.emitClientError(error))
        })
        await session.birth(edge.birthMetrics)
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
        this.#primaryHostState = state
        await this.#onPrimaryHostState?.(state)
    }

    private emitClientError(error: unknown): void {
        this.client.emit('error', error instanceof Error ? error : new Error(String(error)))
    }

    async close(): Promise<void> {
        try {
            if (this.session.born) await this.session.death()
        } finally {
            await this.client.endAsync()
        }
    }
}
