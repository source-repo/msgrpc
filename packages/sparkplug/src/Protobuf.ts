import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { Payload_MetricSchema, PayloadSchema, type Payload, type Payload_Metric } from './generated/sparkplug_b_pb.js'
import { SparkplugDataType } from './Types.js'
import type { SparkplugMetric, SparkplugPayload } from './Payload.js'

function asBigInt(value: number | bigint | undefined): bigint | undefined {
    if (value === undefined) return undefined
    return typeof value === 'bigint' ? value : BigInt(value)
}

function metricValue(metric: SparkplugMetric): Payload_Metric['value'] {
    if (metric.isNull || metric.value === undefined) return { case: undefined }
    switch (metric.datatype) {
        case SparkplugDataType.Boolean:
            if (typeof metric.value !== 'boolean') throw new Error(`${metric.name ?? 'metric'} Boolean value must be boolean`)
            return { case: 'booleanValue', value: metric.value }
        case SparkplugDataType.String:
        case SparkplugDataType.Text:
        case SparkplugDataType.UUID:
            if (typeof metric.value !== 'string') throw new Error(`${metric.name ?? 'metric'} String value must be string`)
            return { case: 'stringValue', value: metric.value }
        case SparkplugDataType.Float:
            if (typeof metric.value !== 'number') throw new Error(`${metric.name ?? 'metric'} Float value must be number`)
            return { case: 'floatValue', value: metric.value }
        case SparkplugDataType.Double:
            if (typeof metric.value !== 'number') throw new Error(`${metric.name ?? 'metric'} Double value must be number`)
            return { case: 'doubleValue', value: metric.value }
        case SparkplugDataType.Int8:
        case SparkplugDataType.Int16:
        case SparkplugDataType.Int32:
        case SparkplugDataType.UInt8:
        case SparkplugDataType.UInt16:
        case SparkplugDataType.UInt32:
            if (typeof metric.value !== 'number') throw new Error(`${metric.name ?? 'metric'} integer value must be number`)
            return { case: 'intValue', value: metric.value }
        case SparkplugDataType.Int64:
        case SparkplugDataType.UInt64:
        case SparkplugDataType.DateTime:
            if (typeof metric.value !== 'number' && typeof metric.value !== 'bigint') throw new Error(`${metric.name ?? 'metric'} long value must be number or bigint`)
            return { case: 'longValue', value: BigInt(metric.value) }
        case SparkplugDataType.Bytes:
        case SparkplugDataType.File:
            if (!(metric.value instanceof Uint8Array)) throw new Error(`${metric.name ?? 'metric'} Bytes value must be Uint8Array`)
            return { case: 'bytesValue', value: metric.value }
        default:
            throw new Error(`${metric.name ?? 'metric'} datatype ${metric.datatype} is not implemented in the M1 encoder`)
    }
}

function encodeMetric(metric: SparkplugMetric): Payload_Metric {
    return create(Payload_MetricSchema, {
        name: metric.name,
        alias: asBigInt(metric.alias),
        timestamp: asBigInt(metric.timestamp),
        datatype: metric.datatype,
        isHistorical: metric.isHistorical,
        isTransient: metric.isTransient,
        isNull: metric.isNull,
        value: metricValue(metric)
    })
}

function decodeMetric(metric: Payload_Metric): SparkplugMetric {
    const decoded: {
        name?: string
        alias?: number
        timestamp?: number
        datatype: SparkplugDataType
        isHistorical?: boolean
        isTransient?: boolean
        isNull?: boolean
        value?: SparkplugMetric['value']
    } = { datatype: metric.datatype }
    if (metric.name) decoded.name = metric.name
    if (metric.alias !== 0n) decoded.alias = Number(metric.alias)
    if (metric.timestamp !== 0n) decoded.timestamp = Number(metric.timestamp)
    if (metric.isHistorical) decoded.isHistorical = metric.isHistorical
    if (metric.isTransient) decoded.isTransient = metric.isTransient
    if (metric.isNull) decoded.isNull = metric.isNull
    const value = decodedMetricValue(metric)
    if (value !== undefined) decoded.value = value
    return decoded
}

function decodedMetricValue(metric: Payload_Metric): SparkplugMetric['value'] | undefined {
    switch (metric.value.case) {
        case 'booleanValue':
            return metric.value.value
        case 'stringValue':
            return metric.value.value
        case 'floatValue':
            return metric.value.value
        case 'doubleValue':
            return metric.value.value
        case 'intValue':
            return metric.value.value
        case 'longValue':
            return metric.value.value
        case 'bytesValue':
            return metric.value.value
        default:
            return undefined
    }
}

export function encodeSparkplugPayload(payload: SparkplugPayload): Uint8Array {
    const proto = create(PayloadSchema, {
        timestamp: BigInt(payload.timestamp),
        seq: asBigInt(payload.seq),
        metrics: payload.metrics.map(encodeMetric)
    })
    return toBinary(PayloadSchema, proto)
}

export function decodeSparkplugPayload(bytes: Uint8Array): SparkplugPayload {
    const payload = fromBinary(PayloadSchema, bytes) as Payload
    return {
        timestamp: Number(payload.timestamp),
        seq: payload.seq === 0n ? undefined : Number(payload.seq),
        metrics: payload.metrics.map(decodeMetric)
    }
}
