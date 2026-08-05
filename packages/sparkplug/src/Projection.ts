import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugDataType } from './Types.js'
import type { SparkplugMetric, SparkplugMetricPrimitive, SparkplugPropertySet } from './Payload.js'

export interface SparkplugMetricMapping {
    readonly path: string
    readonly name?: string
    readonly alias?: number
    readonly datatype?: SparkplugDataType
    readonly nullable?: boolean
    readonly minimum?: number
    readonly maximum?: number
    readonly isHistorical?: boolean
    readonly isTransient?: boolean
    readonly properties?: SparkplugPropertySet
}

export type SparkplugNodeMetricMapping = SparkplugMetricMapping

export interface SparkplugProjectedMetric extends SparkplugMetric {
    readonly name: string
    readonly value?: SparkplugMetricPrimitive
}

export type SparkplugProjectionSnapshot = Record<string, unknown>

export type SparkplugComponentProjectionStatus = 'initializing' | 'live' | 'stale' | 'closed'

export interface SparkplugComponentProjectionView {
    readonly epoch: string
    readonly revision: number
    readonly props: Record<string, unknown>
    readonly state: Record<string, unknown>
    readonly status: SparkplugComponentProjectionStatus
    readonly receivedAt?: number
    readonly staleSince?: number
}

export interface SparkplugComponentProjectionStore {
    getSnapshot(): SparkplugComponentProjectionView
    subscribe(listener: () => void): () => void
    close(): Promise<void>
}

const metricName = (mapping: SparkplugMetricMapping) => mapping.name ?? mapping.path

function valueAtPath(snapshot: SparkplugProjectionSnapshot, path: string): unknown {
    let value: unknown = snapshot
    for (const segment of path.split('.')) {
        if (!segment) throw new Error('projection metric path must not contain an empty segment')
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined
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

export function projectNodeMetrics(snapshot: SparkplugProjectionSnapshot, mappings: readonly SparkplugMetricMapping[]): SparkplugProjectedMetric[] {
    const timestamp = typeof snapshot.receivedAt === 'number' && Number.isFinite(snapshot.receivedAt) ? snapshot.receivedAt : Date.now()
    return mappings.map((mapping) => {
        const name = metricName(mapping)
        const value = valueAtPath(snapshot, mapping.path)
        const definition = {
            name,
            ...(mapping.alias === undefined ? {} : { alias: mapping.alias }),
            timestamp,
            datatype: mapping.datatype ?? SparkplugDataType.Unknown,
            ...(mapping.isHistorical === undefined ? {} : { isHistorical: mapping.isHistorical }),
            ...(mapping.isTransient === undefined ? {} : { isTransient: mapping.isTransient }),
            ...(mapping.properties === undefined ? {} : { properties: mapping.properties })
        }
        if (value === undefined) {
            if (mapping.nullable === false) throw new Error(`cannot project ${name}: required path ${mapping.path} is missing`)
            return { ...definition, isNull: true }
        }
        const metricValue = assertMetricValue(name, value)
        if (typeof metricValue === 'number') {
            if (mapping.minimum !== undefined && metricValue < mapping.minimum) throw new Error(`cannot project ${name}: value is below minimum ${mapping.minimum}`)
            if (mapping.maximum !== undefined && metricValue > mapping.maximum) throw new Error(`cannot project ${name}: value is above maximum ${mapping.maximum}`)
        }
        return { ...definition, datatype: mapping.datatype ?? inferDatatype(name, metricValue), value: metricValue }
    })
}

function dataMetrics(metrics: readonly SparkplugProjectedMetric[]): SparkplugMetric[] {
    return metrics.map((metric) => {
        const { name, properties: _properties, ...data } = metric
        return metric.alias === undefined ? { name, ...data } : data
    })
}

class SparkplugMetricProjectionState {
    #latest = new Map<string, SparkplugProjectedMetric>()

    constructor(readonly mappings: readonly SparkplugMetricMapping[]) {}

    metrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        return projectNodeMetrics(snapshot, this.mappings)
    }

    changed(metrics: readonly SparkplugProjectedMetric[]): SparkplugProjectedMetric[] {
        return metrics.filter((metric) => {
            const previous = this.#latest.get(metric.name)
            return (
                !previous ||
                previous.datatype !== metric.datatype ||
                previous.isNull !== metric.isNull ||
                !sameMetricValue(previous.value, metric.value)
            )
        })
    }

    published(metrics: readonly SparkplugProjectedMetric[]): void {
        this.#latest = new Map(metrics.map((metric) => [metric.name, metric]))
    }

    clear(): void {
        this.#latest.clear()
    }
}

export class SparkplugNodeMetricProjection {
    readonly #state: SparkplugMetricProjectionState

    constructor(
        private readonly session: SparkplugEdgeNodeSession,
        mappings: readonly SparkplugMetricMapping[]
    ) {
        this.#state = new SparkplugMetricProjectionState(mappings)
    }

    get mappings(): readonly SparkplugMetricMapping[] {
        return this.#state.mappings
    }

    async birth(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame> {
        const metrics = this.#state.metrics(snapshot)
        const frame = await this.session.birth(metrics)
        this.#state.published(metrics)
        return frame
    }

    changedMetrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        return this.#state.changed(this.#state.metrics(snapshot))
    }

    async publishChanges(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame | undefined> {
        const metrics = this.#state.metrics(snapshot)
        const frame = await this.session.data(dataMetrics(this.#state.changed(metrics)))
        if (frame) this.#state.published(metrics)
        return frame
    }
}

export class SparkplugDeviceMetricProjection {
    readonly #state: SparkplugMetricProjectionState

    constructor(
        private readonly session: SparkplugEdgeNodeSession,
        readonly deviceId: string,
        mappings: readonly SparkplugMetricMapping[]
    ) {
        this.#state = new SparkplugMetricProjectionState(mappings)
    }

    get mappings(): readonly SparkplugMetricMapping[] {
        return this.#state.mappings
    }

    async birth(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame> {
        const metrics = this.#state.metrics(snapshot)
        const frame = await this.session.deviceBirth(this.deviceId, metrics)
        this.#state.published(metrics)
        return frame
    }

    async publishChanges(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame | undefined> {
        const metrics = this.#state.metrics(snapshot)
        const frame = await this.session.deviceData(this.deviceId, dataMetrics(this.#state.changed(metrics)))
        if (frame) this.#state.published(metrics)
        return frame
    }

    async death(): Promise<SparkplugPublishFrame> {
        const frame = await this.session.deviceDeath(this.deviceId)
        this.#state.clear()
        return frame
    }
}

interface SparkplugComponentProjectionRunnerCommonOptions {
    readonly session: SparkplugEdgeNodeSession
    readonly store: SparkplugComponentProjectionStore
}

export interface SparkplugDeviceProjectionDefinition {
    readonly deviceId: string
    readonly mappings: readonly SparkplugMetricMapping[]
}

export type SparkplugComponentProjectionRunnerOptions = SparkplugComponentProjectionRunnerCommonOptions &
    (
        | { readonly definition: SparkplugDeviceProjectionDefinition; readonly deviceId?: never; readonly mappings?: never }
        | { readonly definition?: never; readonly deviceId: string; readonly mappings: readonly SparkplugMetricMapping[] }
    )

export class SparkplugComponentProjectionRunner {
    readonly projection: SparkplugDeviceMetricProjection
    #unsubscribe?: () => void
    #latestKey?: string
    #bornEpoch?: string
    #queue = Promise.resolve()
    #queuedError?: unknown

    constructor(private readonly options: SparkplugComponentProjectionRunnerOptions) {
        const definition = options.definition ?? options
        this.projection = new SparkplugDeviceMetricProjection(options.session, definition.deviceId, definition.mappings)
    }

    async start(): Promise<SparkplugPublishFrame | undefined> {
        if (this.#unsubscribe) throw new Error('Sparkplug component projection is already started')
        this.#unsubscribe = this.options.store.subscribe(() => {
            void this.enqueue(this.options.store.getSnapshot()).catch(() => undefined)
        })
        try {
            return await this.enqueue(this.options.store.getSnapshot())
        } catch (error) {
            this.#unsubscribe?.()
            this.#unsubscribe = undefined
            this.#queuedError = undefined
            throw error
        }
    }

    async flush(): Promise<void> {
        await this.#queue
        if (this.#queuedError !== undefined) {
            const error = this.#queuedError
            this.#queuedError = undefined
            throw error
        }
    }

    async close(): Promise<void> {
        this.#unsubscribe?.()
        this.#unsubscribe = undefined
        let failure: unknown
        try {
            await this.flush()
        } catch (error) {
            failure = error
        }
        try {
            if (this.#bornEpoch) await this.projection.death()
            this.#bornEpoch = undefined
        } catch (error) {
            failure ??= error
        } finally {
            await this.options.store.close()
        }
        if (failure !== undefined) throw failure
    }

    private enqueue(snapshot: SparkplugComponentProjectionView): Promise<SparkplugPublishFrame | undefined> {
        const operation = this.#queue.then(() => this.publishObserved(snapshot))
        this.#queue = operation.then(
            () => undefined,
            (error: unknown) => {
                this.#queuedError ??= error
            }
        )
        return operation
    }

    private async publishObserved(snapshot: SparkplugComponentProjectionView): Promise<SparkplugPublishFrame | undefined> {
        const key = snapshotKey(snapshot)
        if (key === this.#latestKey) return undefined
        const previousKey = this.#latestKey
        this.#latestKey = key
        try {
            return await this.publishSnapshot(snapshot)
        } catch (error) {
            this.#latestKey = previousKey
            throw error
        }
    }

    private async publishSnapshot(snapshot: SparkplugComponentProjectionView): Promise<SparkplugPublishFrame | undefined> {
        if (snapshot.status !== 'live') {
            if (!this.#bornEpoch) return undefined
            const death = await this.projection.death()
            this.#bornEpoch = undefined
            return death
        }
        if (snapshot.epoch !== this.#bornEpoch) {
            const birth = await this.projection.birth(snapshotProjectionView(snapshot))
            this.#bornEpoch = snapshot.epoch
            return birth
        }
        return this.projection.publishChanges(snapshotProjectionView(snapshot))
    }
}

function snapshotKey(snapshot: SparkplugComponentProjectionView): string {
    return `${snapshot.status}:${snapshot.epoch}:${snapshot.revision}`
}

function snapshotProjectionView(snapshot: SparkplugComponentProjectionView): SparkplugProjectionSnapshot {
    return {
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        props: snapshot.props,
        state: snapshot.state,
        status: snapshot.status,
        ...(snapshot.receivedAt === undefined ? {} : { receivedAt: snapshot.receivedAt }),
        ...(snapshot.staleSince === undefined ? {} : { staleSince: snapshot.staleSince })
    }
}
