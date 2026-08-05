import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugDataType } from './Types.js'
import type { SparkplugMetric, SparkplugMetricPrimitive } from './Payload.js'

export interface SparkplugNodeMetricMapping {
    readonly path: string
    readonly name?: string
    readonly datatype?: SparkplugDataType
}

export interface SparkplugProjectedMetric extends SparkplugMetric {
    readonly name: string
    readonly value?: SparkplugMetricPrimitive
}

export type SparkplugProjectionSnapshot = Record<string, unknown>

const metricName = (mapping: SparkplugNodeMetricMapping) => mapping.name ?? mapping.path

function valueAtPath(snapshot: SparkplugProjectionSnapshot, path: string): unknown {
    let value: unknown = snapshot
    for (const segment of path.split('.')) {
        if (!segment) throw new Error('projection metric path must not contain an empty segment')
        if (!value || typeof value !== 'object' || !(segment in value)) return undefined
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

function inferDatatype(name: string, value: unknown): SparkplugDataType {
    switch (typeof value) {
        case 'boolean':
            return SparkplugDataType.Boolean
        case 'number':
            return SparkplugDataType.Double
        case 'bigint':
            return SparkplugDataType.Int64
        case 'string':
            return SparkplugDataType.String
        default:
            if (value instanceof Uint8Array) return SparkplugDataType.Bytes
            throw new Error(`cannot infer Sparkplug datatype for ${name}`)
    }
}

function assertMetricValue(name: string, value: unknown): SparkplugMetricPrimitive {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
    if (value instanceof Uint8Array) return value
    throw new Error(`cannot project ${name}: value is not a Sparkplug primitive`)
}

function sameMetricValue(left: SparkplugMetricPrimitive | undefined, right: SparkplugMetricPrimitive | undefined): boolean {
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
        if (left.length !== right.length) return false
        return left.every((value, index) => value === right[index])
    }
    return Object.is(left, right)
}

export function projectNodeMetrics(snapshot: SparkplugProjectionSnapshot, mappings: readonly SparkplugNodeMetricMapping[]): SparkplugProjectedMetric[] {
    return mappings.map((mapping) => {
        const name = metricName(mapping)
        const value = valueAtPath(snapshot, mapping.path)
        if (value === undefined) return { name, datatype: mapping.datatype ?? SparkplugDataType.Unknown, isNull: true }
        const metricValue = assertMetricValue(name, value)
        return { name, datatype: mapping.datatype ?? inferDatatype(name, metricValue), value: metricValue }
    })
}

export class SparkplugNodeMetricProjection {
    readonly mappings: readonly SparkplugNodeMetricMapping[]
    #latest = new Map<string, SparkplugProjectedMetric>()

    constructor(
        private readonly session: SparkplugEdgeNodeSession,
        mappings: readonly SparkplugNodeMetricMapping[]
    ) {
        this.mappings = mappings
    }

    birthMetrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        const metrics = projectNodeMetrics(snapshot, this.mappings)
        this.#latest = new Map(metrics.map((metric) => [metric.name, metric]))
        return metrics
    }

    changedMetrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        const metrics = projectNodeMetrics(snapshot, this.mappings)
        const changed = metrics.filter((metric) => {
            const previous = this.#latest.get(metric.name)
            return (
                !previous ||
                previous.datatype !== metric.datatype ||
                previous.isNull !== metric.isNull ||
                !sameMetricValue(previous.value, metric.value)
            )
        })
        for (const metric of metrics) this.#latest.set(metric.name, metric)
        return changed
    }

    async publishChanges(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame | undefined> {
        return this.session.data(this.changedMetrics(snapshot))
    }
}
