import { SparkplugDataType } from './Types.js'

export type SparkplugMetricPrimitive = boolean | number | string | bigint | Uint8Array
export type SparkplugPropertyPrimitive = Exclude<SparkplugMetricPrimitive, Uint8Array>

export interface SparkplugPropertyValue {
    readonly datatype: SparkplugDataType
    readonly isNull?: boolean
    readonly value?: SparkplugPropertyPrimitive
}

export type SparkplugPropertySet = Readonly<Record<string, SparkplugPropertyValue>>

export interface SparkplugMetric {
    readonly name?: string
    readonly alias?: number
    readonly timestamp?: number
    readonly datatype: SparkplugDataType
    readonly isHistorical?: boolean
    readonly isTransient?: boolean
    readonly isNull?: boolean
    readonly properties?: SparkplugPropertySet
    readonly value?: SparkplugMetricPrimitive
}

export interface SparkplugPayload {
    readonly timestamp: number
    readonly seq?: number
    readonly metrics: readonly SparkplugMetric[]
}

export const NODE_CONTROL_REBIRTH = 'Node Control/Rebirth'

export function nodeRebirthCommandPayload(timestamp: number): SparkplugPayload {
    return {
        timestamp,
        metrics: [
            {
                name: NODE_CONTROL_REBIRTH,
                timestamp,
                datatype: SparkplugDataType.Boolean,
                value: true
            }
        ]
    }
}

export function isNodeRebirthCommand(payload: SparkplugPayload): boolean {
    return payload.metrics.some((metric) => metric.name === NODE_CONTROL_REBIRTH && metric.datatype === SparkplugDataType.Boolean && metric.value === true)
}

export function bdSeqMetric(bdSeq: number, timestamp: number): SparkplugMetric {
    if (!Number.isInteger(bdSeq) || bdSeq < 0 || bdSeq > 255) throw new Error('bdSeq must be an integer in the Sparkplug sequence range 0..255')
    return {
        name: 'bdSeq',
        timestamp,
        datatype: SparkplugDataType.UInt64,
        value: bdSeq
    }
}

export function nodeBirthPayload(options: {
    readonly timestamp: number
    readonly seq: number
    readonly bdSeq: number
    readonly metrics?: readonly SparkplugMetric[]
}): SparkplugPayload {
    return {
        timestamp: options.timestamp,
        seq: options.seq,
        metrics: [bdSeqMetric(options.bdSeq, options.timestamp), ...(options.metrics ?? [])]
    }
}

export function nodeDataPayload(options: { readonly timestamp: number; readonly seq: number; readonly metrics: readonly SparkplugMetric[] }): SparkplugPayload {
    return {
        timestamp: options.timestamp,
        seq: options.seq,
        metrics: options.metrics
    }
}

export function deviceBirthPayload(options: { readonly timestamp: number; readonly seq: number; readonly metrics: readonly SparkplugMetric[] }): SparkplugPayload {
    return nodeDataPayload(options)
}

export function deviceDataPayload(options: { readonly timestamp: number; readonly seq: number; readonly metrics: readonly SparkplugMetric[] }): SparkplugPayload {
    return nodeDataPayload(options)
}

export function deviceDeathPayload(options: { readonly timestamp: number; readonly seq: number }): SparkplugPayload {
    return nodeDataPayload({ ...options, metrics: [] })
}

export function nodeDeathPayload(options: { readonly timestamp: number; readonly bdSeq: number }): SparkplugPayload {
    return {
        timestamp: options.timestamp,
        metrics: [bdSeqMetric(options.bdSeq, options.timestamp)]
    }
}
