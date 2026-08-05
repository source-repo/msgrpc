import { create, fromBinary, isFieldSet, toBinary } from '@bufbuild/protobuf'
import {
    Payload_MetricSchema,
    Payload_PropertySetSchema,
    Payload_PropertyValueSchema,
    PayloadSchema,
    type Payload,
    type Payload_Metric,
    type Payload_PropertySet,
    type Payload_PropertyValue
} from './generated/sparkplug_b_pb.js'
import { SparkplugDataType } from './Types.js'
import type { SparkplugMetric, SparkplugPayload, SparkplugPropertyPrimitive, SparkplugPropertySet, SparkplugPropertyValue } from './Payload.js'

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

function propertyValue(property: SparkplugPropertyValue): Payload_PropertyValue['value'] {
    if (property.isNull || property.value === undefined) return { case: undefined }
    switch (property.datatype) {
        case SparkplugDataType.Boolean:
            if (typeof property.value !== 'boolean') throw new Error('Boolean property value must be boolean')
            return { case: 'booleanValue', value: property.value }
        case SparkplugDataType.String:
        case SparkplugDataType.Text:
        case SparkplugDataType.UUID:
            if (typeof property.value !== 'string') throw new Error('String property value must be string')
            return { case: 'stringValue', value: property.value }
        case SparkplugDataType.Float:
            if (typeof property.value !== 'number') throw new Error('Float property value must be number')
            return { case: 'floatValue', value: property.value }
        case SparkplugDataType.Double:
            if (typeof property.value !== 'number') throw new Error('Double property value must be number')
            return { case: 'doubleValue', value: property.value }
        case SparkplugDataType.Int8:
        case SparkplugDataType.Int16:
        case SparkplugDataType.Int32:
        case SparkplugDataType.UInt8:
        case SparkplugDataType.UInt16:
        case SparkplugDataType.UInt32:
            if (typeof property.value !== 'number') throw new Error('integer property value must be number')
            return { case: 'intValue', value: property.value }
        case SparkplugDataType.Int64:
        case SparkplugDataType.UInt64:
        case SparkplugDataType.DateTime:
            if (typeof property.value !== 'number' && typeof property.value !== 'bigint')
                throw new Error('long property value must be number or bigint')
            return { case: 'longValue', value: BigInt(property.value) }
        default:
            throw new Error(`property datatype ${property.datatype} is not implemented`)
    }
}

function encodeProperties(properties: SparkplugPropertySet | undefined): Payload_PropertySet | undefined {
    if (!properties) return undefined
    const entries = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))
    return create(Payload_PropertySetSchema, {
        keys: entries.map(([key]) => key),
        values: entries.map(([, property]) =>
            create(Payload_PropertyValueSchema, {
                type: property.datatype,
                isNull: property.isNull,
                value: propertyValue(property)
            })
        )
    })
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
        properties: encodeProperties(metric.properties),
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
        properties?: SparkplugPropertySet
        value?: SparkplugMetric['value']
    } = { datatype: metric.datatype }
    if (metric.name) decoded.name = metric.name
    if (isFieldSet(metric, Payload_MetricSchema.field.alias)) decoded.alias = Number(metric.alias)
    if (isFieldSet(metric, Payload_MetricSchema.field.timestamp)) decoded.timestamp = Number(metric.timestamp)
    if (metric.isHistorical) decoded.isHistorical = metric.isHistorical
    if (metric.isTransient) decoded.isTransient = metric.isTransient
    if (metric.isNull) decoded.isNull = metric.isNull
    const properties = decodeProperties(metric.properties)
    if (properties !== undefined) decoded.properties = properties
    const value = decodedMetricValue(metric)
    if (value !== undefined) decoded.value = value
    return decoded
}

function decodeProperties(properties: Payload_PropertySet | undefined): SparkplugPropertySet | undefined {
    if (!properties) return undefined
    const decoded: Record<string, SparkplugPropertyValue> = {}
    properties.keys.forEach((key, index) => {
        const property = properties.values[index]
        if (!property) throw new Error(`Sparkplug property ${JSON.stringify(key)} has no value`)
        const value = decodedPropertyValue(property)
        decoded[key] = {
            datatype: property.type as SparkplugDataType,
            ...(property.isNull ? { isNull: true } : {}),
            ...(value === undefined ? {} : { value })
        }
    })
    return decoded
}

function decodedPropertyValue(property: Payload_PropertyValue): SparkplugPropertyPrimitive | undefined {
    switch (property.value.case) {
        case 'booleanValue':
        case 'stringValue':
        case 'floatValue':
        case 'doubleValue':
        case 'intValue':
        case 'longValue':
            return property.value.value
        default:
            return undefined
    }
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
        seq: isFieldSet(payload, PayloadSchema.field.seq) ? Number(payload.seq) : undefined,
        metrics: payload.metrics.map(decodeMetric)
    }
}
