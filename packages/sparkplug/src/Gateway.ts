import { RpcClient, type RpcClientOptions } from '@source-repo/rpc'
import type { IClientOptions } from 'mqtt'
import { MqttSparkplugEdgeNodeSession, type MqttSparkplugEdgeNodeSessionOptions } from './MqttEdgeNodeSession.js'

export interface SourceSparkRpcSessionOptions
    extends Omit<Partial<RpcClientOptions>, 'name' | 'transport' | 'credentials'> {
    /** Broker credentials and TLS options for the Source RPC connection. */
    readonly mqtt?: IClientOptions
}

export interface SourceSparkSparkplugSessionOptions
    extends Omit<MqttSparkplugEdgeNodeSessionOptions, 'url' | 'groupId' | 'edgeNodeId' | 'clientId'> {}

export interface SourceSparkGatewayOptions {
    readonly url: string
    /** Stable deployment identity. The two broker client IDs are derived from this value. */
    readonly runtimeId: string
    readonly groupId: string
    readonly edgeNodeId: string
    readonly rpc?: SourceSparkRpcSessionOptions
    readonly sparkplug?: SourceSparkSparkplugSessionOptions
}

export interface SourceSparkGatewayClientIds {
    readonly rpc: string
    readonly sparkplug: string
}

const UNSAFE_MQTT_CLIENT_ID = /[\0#+/]/u

export function sourceSparkGatewayClientIds(runtimeId: string): SourceSparkGatewayClientIds {
    if (typeof runtimeId !== 'string' || runtimeId.length === 0) throw new Error('runtimeId must be a non-empty string')
    if (UNSAFE_MQTT_CLIENT_ID.test(runtimeId)) throw new Error('runtimeId must not contain NUL, /, + or #')
    if (new TextEncoder().encode(runtimeId).length > 115) throw new Error('runtimeId must not exceed 115 UTF-8 bytes')
    return { rpc: `${runtimeId}-rpc`, sparkplug: `${runtimeId}-sparkplug` }
}

function assertFixedClientId(options: IClientOptions | undefined, expected: string, label: string): void {
    if (options?.clientId !== undefined && options.clientId !== expected)
        throw new Error(`${label}.mqtt.clientId must be ${JSON.stringify(expected)} when supplied`)
}

function assertSparkplugSessionOptions(options: IClientOptions | undefined): void {
    if (options?.clean !== undefined && options.clean !== true) throw new Error('sparkplug.mqtt.clean must remain true')
    if (options?.will !== undefined) throw new Error('sparkplug.mqtt.will cannot override the Sparkplug NDEATH Will')
}

/**
 * The two MQTT sessions a Source Spark runtime needs. Sparkplug and Source RPC require different
 * Wills, so sharing one broker connection would weaken one protocol or the other.
 */
export class SourceSparkGateway {
    private constructor(
        readonly clientIds: SourceSparkGatewayClientIds,
        readonly rpc: RpcClient,
        readonly sparkplug: MqttSparkplugEdgeNodeSession
    ) {}

    static async connect(options: SourceSparkGatewayOptions): Promise<SourceSparkGateway> {
        const clientIds = sourceSparkGatewayClientIds(options.runtimeId)
        const rpcMqtt = options.rpc?.mqtt
        const sparkplugMqtt = options.sparkplug?.mqtt
        assertFixedClientId(rpcMqtt, clientIds.rpc, 'rpc')
        assertFixedClientId(sparkplugMqtt, clientIds.sparkplug, 'sparkplug')
        assertSparkplugSessionOptions(sparkplugMqtt)

        const { mqtt: _rpcMqtt, ...rpcOptions } = options.rpc ?? {}
        const rpc = new RpcClient(options.url, {
            ...rpcOptions,
            name: clientIds.rpc,
            credentials: { ...rpcMqtt, clientId: clientIds.rpc }
        })
        try {
            await rpc.ready()
            const sparkplug = await MqttSparkplugEdgeNodeSession.connect({
                ...options.sparkplug,
                url: options.url,
                groupId: options.groupId,
                edgeNodeId: options.edgeNodeId,
                clientId: clientIds.sparkplug,
                mqtt: { ...sparkplugMqtt, clientId: clientIds.sparkplug }
            })
            return new SourceSparkGateway(clientIds, rpc, sparkplug)
        } catch (error) {
            await rpc.close()
            throw error
        }
    }

    async close(): Promise<void> {
        let failure: unknown
        try {
            await this.sparkplug.close()
        } catch (error) {
            failure = error
        }
        try {
            await this.rpc.close()
        } catch (error) {
            failure ??= error
        }
        if (failure !== undefined) throw failure
    }
}
