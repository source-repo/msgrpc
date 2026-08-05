import { createHash } from 'node:crypto'
import type { SparkplugMetricMapping } from './Projection.js'
import { SparkplugDataType, assertSparkplugTopicSegment } from './Types.js'

export const SPARKPLUG_PROJECTION_SCHEMA_VERSION = 1
export const SPARKPLUG_PROJECTION_ENCODING_VERSION = 1

export const SPARKPLUG_PROJECTION_DATATYPES = [
    'Int8',
    'Int16',
    'Int32',
    'Int64',
    'UInt8',
    'UInt16',
    'UInt32',
    'UInt64',
    'Float',
    'Double',
    'Boolean',
    'String',
    'DateTime',
    'Text',
    'UUID',
    'Bytes',
    'File'
] as const

export type SparkplugProjectionDatatype = (typeof SPARKPLUG_PROJECTION_DATATYPES)[number]

export interface SparkplugProjectionSource {
    readonly peer: string
    readonly component: string
}

export interface SparkplugProjectionContractMetric {
    readonly name: string
    readonly path: `props.${string}` | `state.${string}`
    readonly qualityPath?: `props.${string}` | `state.${string}`
    readonly datatype: SparkplugProjectionDatatype
    readonly nullable?: boolean
    readonly unit?: string
    readonly minimum?: number
    readonly maximum?: number
    readonly deadband?: number
    readonly historical?: boolean
    readonly transient?: boolean
}

export interface SparkplugProjectionContractDevice {
    readonly deviceId: string
    readonly source: SparkplugProjectionSource
    readonly maxPublishHz?: number
    readonly metrics: readonly SparkplugProjectionContractMetric[]
}

export interface SparkplugProjectionContract {
    readonly schema: typeof SPARKPLUG_PROJECTION_SCHEMA_VERSION
    readonly groupId: string
    readonly edgeNodeId: string
    readonly devices: readonly SparkplugProjectionContractDevice[]
}

export interface SparkplugCompiledDeviceProjection {
    readonly deviceId: string
    readonly source: SparkplugProjectionSource
    readonly maxPublishHz?: number
    readonly mappings: readonly SparkplugMetricMapping[]
}

export interface SparkplugCompiledProjectionContract {
    readonly encodingVersion: typeof SPARKPLUG_PROJECTION_ENCODING_VERSION
    readonly contract: SparkplugProjectionContract
    readonly hash: string
    readonly devices: readonly SparkplugCompiledDeviceProjection[]
}

export interface SparkplugProjectionCompileOptions {
    /** Only the Source RPC contract fragments read by this projection. */
    readonly sourceContractFragments?: unknown
}

const DATATYPES: Readonly<Record<SparkplugProjectionDatatype, SparkplugDataType>> = {
    Int8: SparkplugDataType.Int8,
    Int16: SparkplugDataType.Int16,
    Int32: SparkplugDataType.Int32,
    Int64: SparkplugDataType.Int64,
    UInt8: SparkplugDataType.UInt8,
    UInt16: SparkplugDataType.UInt16,
    UInt32: SparkplugDataType.UInt32,
    UInt64: SparkplugDataType.UInt64,
    Float: SparkplugDataType.Float,
    Double: SparkplugDataType.Double,
    Boolean: SparkplugDataType.Boolean,
    String: SparkplugDataType.String,
    DateTime: SparkplugDataType.DateTime,
    Text: SparkplugDataType.Text,
    UUID: SparkplugDataType.UUID,
    Bytes: SparkplugDataType.Bytes,
    File: SparkplugDataType.File
}

const NUMERIC_DATATYPES = new Set<SparkplugProjectionDatatype>([
    'Int8',
    'Int16',
    'Int32',
    'Int64',
    'UInt8',
    'UInt16',
    'UInt32',
    'UInt64',
    'Float',
    'Double'
])

const INTEGER_DATATYPES = new Set<SparkplugProjectionDatatype>(['Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64'])

const PATH_ROOTS = new Set(['props', 'state'])
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const textEncoder = new TextEncoder()

export function validateSparkplugProjectionContract(input: unknown): SparkplugProjectionContract {
    const root = objectAt(input, 'contract')
    exactKeys(root, ['$schema', 'schema', 'groupId', 'edgeNodeId', 'devices'], ['schema', 'groupId', 'edgeNodeId', 'devices'], 'contract')
    if (root.$schema !== undefined && typeof root.$schema !== 'string') throw new Error('contract.$schema must be a string when present')
    if (root.schema !== SPARKPLUG_PROJECTION_SCHEMA_VERSION)
        throw new Error(`contract.schema must be ${SPARKPLUG_PROJECTION_SCHEMA_VERSION}`)

    const groupId = topicSegment(root.groupId, 'contract.groupId')
    const edgeNodeId = topicSegment(root.edgeNodeId, 'contract.edgeNodeId')
    const devicesInput = arrayAt(root.devices, 'contract.devices')
    if (devicesInput.length === 0) throw new Error('contract.devices must contain at least one Device')

    const deviceIds = new Set<string>()
    const devices = devicesInput.map((value, index) => {
        const path = `contract.devices[${index}]`
        const device = objectAt(value, path)
        exactKeys(device, ['deviceId', 'source', 'maxPublishHz', 'metrics'], ['deviceId', 'source', 'metrics'], path)
        const deviceId = topicSegment(device.deviceId, `${path}.deviceId`)
        if (deviceIds.has(deviceId)) throw new Error(`${path}.deviceId duplicates ${JSON.stringify(deviceId)}`)
        deviceIds.add(deviceId)

        const source = objectAt(device.source, `${path}.source`)
        exactKeys(source, ['peer', 'component'], ['peer', 'component'], `${path}.source`)
        const peer = boundedText(source.peer, `${path}.source.peer`, 256)
        const component = boundedText(source.component, `${path}.source.component`, 256)
        const maxPublishHz = optionalFiniteNumber(device.maxPublishHz, `${path}.maxPublishHz`)
        if (maxPublishHz !== undefined && maxPublishHz <= 0) throw new Error(`${path}.maxPublishHz must be greater than zero`)

        const metricsInput = arrayAt(device.metrics, `${path}.metrics`)
        if (metricsInput.length === 0) throw new Error(`${path}.metrics must contain at least one metric`)
        const metricNames = new Set<string>()
        const metrics = metricsInput.map((metricValue, metricIndex) => {
            const metricPath = `${path}.metrics[${metricIndex}]`
            const metric = objectAt(metricValue, metricPath)
            exactKeys(
                metric,
                ['name', 'path', 'qualityPath', 'datatype', 'nullable', 'unit', 'minimum', 'maximum', 'deadband', 'historical', 'transient'],
                ['name', 'path', 'datatype'],
                metricPath
            )
            const name = boundedText(metric.name, `${metricPath}.name`, 256)
            if (metricNames.has(name)) throw new Error(`${metricPath}.name duplicates ${JSON.stringify(name)} in Device ${JSON.stringify(deviceId)}`)
            metricNames.add(name)
            const projectionPath = metricPathValue(metric.path, `${metricPath}.path`)
            const qualityPath = metric.qualityPath === undefined ? undefined : metricPathValue(metric.qualityPath, `${metricPath}.qualityPath`)
            const datatype = projectionDatatype(metric.datatype, `${metricPath}.datatype`)
            const nullable = optionalBoolean(metric.nullable, `${metricPath}.nullable`)
            const unit = optionalBoundedText(metric.unit, `${metricPath}.unit`, 128)
            const minimum = optionalFiniteNumber(metric.minimum, `${metricPath}.minimum`)
            const maximum = optionalFiniteNumber(metric.maximum, `${metricPath}.maximum`)
            const deadband = optionalFiniteNumber(metric.deadband, `${metricPath}.deadband`)
            const historical = optionalBoolean(metric.historical, `${metricPath}.historical`)
            const transient = optionalBoolean(metric.transient, `${metricPath}.transient`)
            if ((unit !== undefined || minimum !== undefined || maximum !== undefined || deadband !== undefined) && !NUMERIC_DATATYPES.has(datatype))
                throw new Error(`${metricPath} units, bounds and deadband require a numeric datatype`)
            if (minimum !== undefined && maximum !== undefined && minimum > maximum)
                throw new Error(`${metricPath}.minimum must be less than or equal to maximum`)
            if (deadband !== undefined && deadband < 0) throw new Error(`${metricPath}.deadband must not be negative`)
            if (deadband !== undefined && INTEGER_DATATYPES.has(datatype) && !Number.isInteger(deadband))
                throw new Error(`${metricPath}.deadband must be an integer for ${datatype}`)
            if (historical && transient) throw new Error(`${metricPath} cannot be both historical and transient`)
            return {
                name,
                path: projectionPath,
                ...(qualityPath === undefined ? {} : { qualityPath }),
                datatype,
                ...(nullable === undefined ? {} : { nullable }),
                ...(unit === undefined ? {} : { unit }),
                ...(minimum === undefined ? {} : { minimum }),
                ...(maximum === undefined ? {} : { maximum }),
                ...(deadband === undefined ? {} : { deadband }),
                ...(historical === undefined ? {} : { historical }),
                ...(transient === undefined ? {} : { transient })
            }
        })
        return { deviceId, source: { peer, component }, ...(maxPublishHz === undefined ? {} : { maxPublishHz }), metrics }
    })
    return { schema: SPARKPLUG_PROJECTION_SCHEMA_VERSION, groupId, edgeNodeId, devices }
}

export function compileSparkplugProjectionContract(
    input: unknown,
    options: SparkplugProjectionCompileOptions = {}
): SparkplugCompiledProjectionContract {
    const validated = validateSparkplugProjectionContract(input)
    const contract: SparkplugProjectionContract = {
        ...validated,
        devices: [...validated.devices]
            .sort((left, right) => compareText(left.deviceId, right.deviceId))
            .map((device) => ({
                ...device,
                metrics: [...device.metrics]
                    .sort((left, right) => compareText(left.name, right.name))
                    .map((metric) => ({
                        ...metric,
                        nullable: metric.nullable ?? false,
                        historical: metric.historical ?? false,
                        transient: metric.transient ?? false
                    }))
            }))
    }
    assertJsonValue(options.sourceContractFragments ?? {}, 'sourceContractFragments')
    const aliases = new Map<string, number>()
    let alias = 1
    for (const device of contract.devices) {
        for (const metric of device.metrics) aliases.set(`${device.deviceId}\0${metric.name}`, alias++)
    }
    const devices = contract.devices.map((device): SparkplugCompiledDeviceProjection => ({
        deviceId: device.deviceId,
        source: device.source,
        ...(device.maxPublishHz === undefined ? {} : { maxPublishHz: device.maxPublishHz }),
        mappings: device.metrics.map((metric) => ({
            path: metric.path,
            ...(metric.qualityPath === undefined ? {} : { qualityPath: metric.qualityPath }),
            name: metric.name,
            alias: aliases.get(`${device.deviceId}\0${metric.name}`),
            datatype: DATATYPES[metric.datatype],
            nullable: metric.nullable ?? false,
            ...(metric.minimum === undefined ? {} : { minimum: metric.minimum }),
            ...(metric.maximum === undefined ? {} : { maximum: metric.maximum }),
            ...(metric.deadband === undefined ? {} : { deadband: metric.deadband }),
            ...(metric.historical ? { isHistorical: true } : {}),
            ...(metric.transient ? { isTransient: true } : {}),
            ...(!metric.unit && metric.minimum === undefined && metric.maximum === undefined
                ? {}
                : {
                      properties: {
                          ...(metric.unit === undefined
                              ? {}
                              : { 'source-rpc/unit': { datatype: SparkplugDataType.String, value: metric.unit } }),
                          ...(metric.minimum === undefined
                              ? {}
                              : { 'source-rpc/minimum': { datatype: SparkplugDataType.Double, value: metric.minimum } }),
                          ...(metric.maximum === undefined
                              ? {}
                              : { 'source-rpc/maximum': { datatype: SparkplugDataType.Double, value: metric.maximum } })
                      }
                  })
        }))
    }))
    const hash = createHash('sha256')
        .update(
            canonicalJson({
                encodingVersion: SPARKPLUG_PROJECTION_ENCODING_VERSION,
                contract,
                sourceContractFragments: options.sourceContractFragments ?? {}
            })
        )
        .digest('hex')
    return { encodingVersion: SPARKPLUG_PROJECTION_ENCODING_VERSION, contract, hash, devices }
}

export function canonicalSparkplugProjectionJson(value: unknown): string {
    assertJsonValue(value, 'value')
    return canonicalJson(value)
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
    return value as Record<string, unknown>
}

function arrayAt(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
    return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string): void {
    const allowedKeys = new Set(allowed)
    const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
    if (unknown) throw new Error(`${path}.${unknown} is not a supported property`)
    const missing = required.find((key) => !(key in value))
    if (missing) throw new Error(`${path}.${missing} is required`)
}

function boundedText(value: unknown, path: string, maxBytes: number): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
    if (value.includes('\0')) throw new Error(`${path} must not contain NUL`)
    if (textEncoder.encode(value).length > maxBytes) throw new Error(`${path} must not exceed ${maxBytes} UTF-8 bytes`)
    return value
}

function optionalBoundedText(value: unknown, path: string, maxBytes: number): string | undefined {
    return value === undefined ? undefined : boundedText(value, path, maxBytes)
}

function topicSegment(value: unknown, path: string): string {
    const segment = boundedText(value, path, 256)
    return assertSparkplugTopicSegment(segment, path)
}

function metricPathValue(value: unknown, path: string): `props.${string}` | `state.${string}` {
    const metricPath = boundedText(value, path, 512)
    const segments = metricPath.split('.')
    if (segments.length < 2 || !PATH_ROOTS.has(segments[0]!)) throw new Error(`${path} must start with props. or state.`)
    if (segments.some((segment) => segment.length === 0 || UNSAFE_PATH_SEGMENTS.has(segment))) throw new Error(`${path} contains an empty or unsafe segment`)
    return metricPath as `props.${string}` | `state.${string}`
}

function projectionDatatype(value: unknown, path: string): SparkplugProjectionDatatype {
    if (typeof value !== 'string' || !(SPARKPLUG_PROJECTION_DATATYPES as readonly string[]).includes(value))
        throw new Error(`${path} must be a supported scalar Sparkplug datatype`)
    return value as SparkplugProjectionDatatype
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new Error(`${path} must be boolean`)
    return value
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`)
    return value
}

function assertJsonValue(value: unknown, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`)
        return
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
        return
    }
    if (value && typeof value === 'object') {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain JSON objects`)
        for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`)
        return
    }
    throw new Error(`${path} must contain only JSON values`)
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}
