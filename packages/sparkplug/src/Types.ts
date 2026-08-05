export const SPARKPLUG_NAMESPACE = 'spBv1.0'

export const enum SparkplugDataType {
    Unknown = 0,
    Int8 = 1,
    Int16 = 2,
    Int32 = 3,
    Int64 = 4,
    UInt8 = 5,
    UInt16 = 6,
    UInt32 = 7,
    UInt64 = 8,
    Float = 9,
    Double = 10,
    Boolean = 11,
    String = 12,
    DateTime = 13,
    Text = 14,
    UUID = 15,
    DataSet = 16,
    Bytes = 17,
    File = 18,
    Template = 19,
    PropertySet = 20,
    PropertySetList = 21,
    Int8Array = 22,
    Int16Array = 23,
    Int32Array = 24,
    Int64Array = 25,
    UInt8Array = 26,
    UInt16Array = 27,
    UInt32Array = 28,
    UInt64Array = 29,
    FloatArray = 30,
    DoubleArray = 31,
    BooleanArray = 32,
    StringArray = 33,
    DateTimeArray = 34
}

export const SparkplugQuality = {
    BAD: 0,
    GOOD: 192,
    STALE: 500
} as const

export type SparkplugNodeMessageType = 'NBIRTH' | 'NDEATH' | 'NDATA' | 'NCMD'
export type SparkplugDeviceMessageType = 'DBIRTH' | 'DDEATH' | 'DDATA' | 'DCMD'
export type SparkplugMessageType = SparkplugNodeMessageType | SparkplugDeviceMessageType

export interface SparkplugNodeAddress {
    readonly groupId: string
    readonly edgeNodeId: string
}

export interface SparkplugDeviceAddress extends SparkplugNodeAddress {
    readonly deviceId: string
}

export interface ParsedSparkplugTopic {
    readonly namespace: typeof SPARKPLUG_NAMESPACE
    readonly type: SparkplugMessageType | 'STATE'
    readonly groupId?: string
    readonly edgeNodeId?: string
    readonly deviceId?: string
    readonly hostId?: string
}

export interface SparkplugHostState {
    readonly hostId: string
    readonly online: boolean
    readonly timestamp?: number
}

const NODE_MESSAGE_TYPES = new Set<SparkplugMessageType | 'STATE'>(['NBIRTH', 'NDEATH', 'NDATA', 'NCMD', 'STATE'])
const DEVICE_MESSAGE_TYPES = new Set<SparkplugMessageType>(['DBIRTH', 'DDEATH', 'DDATA', 'DCMD'])

export function assertSparkplugTopicSegment(value: string, name: string): string {
    if (value.length === 0) throw new Error(`${name} must not be empty`)
    if (value.includes('/') || value.includes('+') || value.includes('#') || value.includes('\0'))
        throw new Error(`${name} is not a safe Sparkplug topic segment`)
    return value
}

export function nodeTopic(type: SparkplugNodeMessageType, address: SparkplugNodeAddress): string {
    return [
        SPARKPLUG_NAMESPACE,
        type,
        assertSparkplugTopicSegment(address.groupId, 'groupId'),
        assertSparkplugTopicSegment(address.edgeNodeId, 'edgeNodeId')
    ].join('/')
}

export function deviceTopic(type: SparkplugDeviceMessageType, address: SparkplugDeviceAddress): string {
    return [
        SPARKPLUG_NAMESPACE,
        type,
        assertSparkplugTopicSegment(address.groupId, 'groupId'),
        assertSparkplugTopicSegment(address.edgeNodeId, 'edgeNodeId'),
        assertSparkplugTopicSegment(address.deviceId, 'deviceId')
    ].join('/')
}

export function hostStateTopic(hostId: string): string {
    return [SPARKPLUG_NAMESPACE, 'STATE', assertSparkplugTopicSegment(hostId, 'hostId')].join('/')
}

export function encodeHostStatePayload(state: Omit<SparkplugHostState, 'hostId'>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ online: state.online, ...(state.timestamp === undefined ? {} : { timestamp: state.timestamp }) }))
}

export function decodeHostStatePayload(hostId: string, payload: Uint8Array): SparkplugHostState {
    const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown
    if (!decoded || typeof decoded !== 'object') throw new Error('Sparkplug Host STATE payload must be a JSON object')
    const state = decoded as { online?: unknown; timestamp?: unknown }
    if (typeof state.online !== 'boolean') throw new Error('Sparkplug Host STATE payload must carry boolean online')
    if (state.timestamp !== undefined && typeof state.timestamp !== 'number') throw new Error('Sparkplug Host STATE timestamp must be a number when present')
    return { hostId: assertSparkplugTopicSegment(hostId, 'hostId'), online: state.online, ...(state.timestamp === undefined ? {} : { timestamp: state.timestamp }) }
}

export function parseSparkplugTopic(topic: string): ParsedSparkplugTopic | undefined {
    const parts = topic.split('/')
    if (parts[0] !== SPARKPLUG_NAMESPACE) return undefined
    const type = parts[1] as SparkplugMessageType | 'STATE' | undefined
    if (!type) return undefined
    if (type === 'STATE') {
        if (parts.length !== 3 || !NODE_MESSAGE_TYPES.has(type)) return undefined
        return { namespace: SPARKPLUG_NAMESPACE, type, hostId: parts[2] }
    }
    if (NODE_MESSAGE_TYPES.has(type)) {
        if (parts.length !== 4) return undefined
        return { namespace: SPARKPLUG_NAMESPACE, type, groupId: parts[2], edgeNodeId: parts[3] }
    }
    if (DEVICE_MESSAGE_TYPES.has(type)) {
        if (parts.length !== 5) return undefined
        return { namespace: SPARKPLUG_NAMESPACE, type, groupId: parts[2], edgeNodeId: parts[3], deviceId: parts[4] }
    }
    return undefined
}
