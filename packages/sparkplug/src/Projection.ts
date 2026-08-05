import { SparkplugEdgeNodeSession, type SparkplugPublishFrame } from './EdgeNodeSession.js'
import { SparkplugDataType, SparkplugQuality } from './Types.js'
import type { SparkplugMetric, SparkplugMetricPrimitive, SparkplugPropertySet } from './Payload.js'

export interface SparkplugMetricMapping {
    readonly path: string
    readonly qualityPath?: string
    readonly name?: string
    readonly alias?: number
    readonly datatype?: SparkplugDataType
    readonly nullable?: boolean
    readonly minimum?: number
    readonly maximum?: number
    readonly deadband?: number
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

function metricProperties(snapshot: SparkplugProjectionSnapshot, mapping: SparkplugMetricMapping, name: string): SparkplugPropertySet | undefined {
    if (!mapping.qualityPath) return mapping.properties
    const quality = valueAtPath(snapshot, mapping.qualityPath)
    if (quality !== SparkplugQuality.BAD && quality !== SparkplugQuality.GOOD && quality !== SparkplugQuality.STALE)
        throw new Error(`cannot project ${name}: ${mapping.qualityPath} must be Sparkplug Quality 0, 192 or 500`)
    return {
        ...mapping.properties,
        Quality: { datatype: SparkplugDataType.Int32, value: quality }
    }
}

export function projectNodeMetrics(snapshot: SparkplugProjectionSnapshot, mappings: readonly SparkplugMetricMapping[]): SparkplugProjectedMetric[] {
    const timestamp = typeof snapshot.receivedAt === 'number' && Number.isFinite(snapshot.receivedAt) ? snapshot.receivedAt : Date.now()
    return mappings.map((mapping) => {
        const name = metricName(mapping)
        const value = valueAtPath(snapshot, mapping.path)
        const properties = metricProperties(snapshot, mapping, name)
        const definition = {
            name,
            ...(mapping.alias === undefined ? {} : { alias: mapping.alias }),
            timestamp,
            datatype: mapping.datatype ?? SparkplugDataType.Unknown,
            ...(mapping.isHistorical === undefined ? {} : { isHistorical: mapping.isHistorical }),
            ...(mapping.isTransient === undefined ? {} : { isTransient: mapping.isTransient }),
            ...(properties === undefined ? {} : { properties })
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
        const { name, properties, ...data } = metric
        const quality = properties?.Quality
        const dataMetric = { ...data, ...(quality === undefined ? {} : { properties: { Quality: quality } }) }
        return metric.alias === undefined ? { name, ...dataMetric } : dataMetric
    })
}

class SparkplugMetricProjectionState {
    #latest = new Map<string, SparkplugProjectedMetric>()
    readonly #mappingsByName: ReadonlyMap<string, SparkplugMetricMapping>

    constructor(readonly mappings: readonly SparkplugMetricMapping[]) {
        this.#mappingsByName = new Map(mappings.map((mapping) => [metricName(mapping), mapping]))
    }

    metrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        return projectNodeMetrics(snapshot, this.mappings)
    }

    changed(metrics: readonly SparkplugProjectedMetric[]): SparkplugProjectedMetric[] {
        return metrics.filter((metric) => {
            const previous = this.#latest.get(metric.name)
            const mapping = this.#mappingsByName.get(metric.name)
            return (
                !previous ||
                previous.datatype !== metric.datatype ||
                previous.isNull !== metric.isNull ||
                !sameMetricProperty(previous.properties?.Quality, metric.properties?.Quality) ||
                metricValueChanged(previous.value, metric.value, mapping?.deadband)
            )
        })
    }

    published(metrics: readonly SparkplugProjectedMetric[], replace = false): void {
        if (replace) this.#latest.clear()
        for (const metric of metrics) this.#latest.set(metric.name, metric)
    }

    clear(): void {
        this.#latest.clear()
    }
}

function sameMetricProperty(left: SparkplugPropertySet[string] | undefined, right: SparkplugPropertySet[string] | undefined): boolean {
    return (
        left?.datatype === right?.datatype &&
        left?.isNull === right?.isNull &&
        sameMetricValue(left?.value, right?.value)
    )
}

function metricValueChanged(
    previous: SparkplugMetricPrimitive | undefined,
    current: SparkplugMetricPrimitive | undefined,
    deadband: number | undefined
): boolean {
    if (sameMetricValue(previous, current)) return false
    if (deadband !== undefined) {
        if (typeof previous === 'number' && typeof current === 'number') return Math.abs(current - previous) >= deadband
        if (typeof previous === 'bigint' && typeof current === 'bigint') return absBigInt(current - previous) >= BigInt(deadband)
    }
    return true
}

function absBigInt(value: bigint): bigint {
    return value < 0n ? -value : value
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
        this.#state.published(metrics, true)
        return frame
    }

    changedMetrics(snapshot: SparkplugProjectionSnapshot): SparkplugProjectedMetric[] {
        return this.#state.changed(this.#state.metrics(snapshot))
    }

    async publishChanges(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame | undefined> {
        const metrics = this.#state.metrics(snapshot)
        const changed = this.#state.changed(metrics)
        const frame = await this.session.data(dataMetrics(changed))
        if (frame) this.#state.published(changed)
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
        this.#state.published(metrics, true)
        return frame
    }

    async publishChanges(snapshot: SparkplugProjectionSnapshot): Promise<SparkplugPublishFrame | undefined> {
        const metrics = this.#state.metrics(snapshot)
        const changed = this.#state.changed(metrics)
        const frame = await this.session.deviceData(this.deviceId, dataMetrics(changed))
        if (frame) this.#state.published(changed)
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
    readonly scheduler?: SparkplugProjectionScheduler
}

export interface SparkplugDeviceProjectionDefinition {
    readonly deviceId: string
    readonly maxPublishHz?: number
    readonly mappings: readonly SparkplugMetricMapping[]
}

export interface SparkplugProjectionScheduler {
    now(): number
    wait(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export type SparkplugComponentProjectionRunnerOptions = SparkplugComponentProjectionRunnerCommonOptions &
    (
        | { readonly definition: SparkplugDeviceProjectionDefinition; readonly deviceId?: never; readonly mappings?: never; readonly maxPublishHz?: never }
        | { readonly definition?: never; readonly deviceId: string; readonly mappings: readonly SparkplugMetricMapping[]; readonly maxPublishHz?: number }
    )

const defaultScheduler: SparkplugProjectionScheduler = {
    now: Date.now,
    wait: (milliseconds, signal) =>
        new Promise((resolve) => {
            const timer = setTimeout(resolve, milliseconds)
            signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer)
                    resolve()
                },
                { once: true }
            )
        })
}

export class SparkplugComponentProjectionRunner {
    readonly projection: SparkplugDeviceMetricProjection
    #unsubscribe?: () => void
    #latestKey?: string
    #bornEpoch?: string
    #pending?: SparkplugComponentProjectionView
    #drain?: Promise<void>
    #queuedError?: unknown
    #failed = false
    #starting = false
    #lastDataPublishedAt?: number
    #rateWait?: AbortController
    readonly #minimumPublishInterval: number
    readonly #scheduler: SparkplugProjectionScheduler

    constructor(private readonly options: SparkplugComponentProjectionRunnerOptions) {
        const definition = options.definition ?? options
        if (definition.maxPublishHz !== undefined && (!Number.isFinite(definition.maxPublishHz) || definition.maxPublishHz <= 0))
            throw new Error('maxPublishHz must be a finite number greater than zero')
        this.projection = new SparkplugDeviceMetricProjection(options.session, definition.deviceId, definition.mappings)
        this.#minimumPublishInterval = definition.maxPublishHz === undefined ? 0 : 1000 / definition.maxPublishHz
        this.#scheduler = options.scheduler ?? defaultScheduler
    }

    async start(): Promise<SparkplugPublishFrame | undefined> {
        if (this.#unsubscribe) throw new Error('Sparkplug component projection is already started')
        this.#starting = true
        this.#unsubscribe = this.options.store.subscribe(() => {
            this.observe(this.options.store.getSnapshot())
        })
        try {
            return await this.publishObserved(this.options.store.getSnapshot())
        } catch (error) {
            this.#unsubscribe?.()
            this.#unsubscribe = undefined
            this.#pending = undefined
            this.#queuedError = undefined
            throw error
        } finally {
            this.#starting = false
            if (this.#pending) this.startDrain()
        }
    }

    async flush(): Promise<void> {
        while (this.#drain) await this.#drain
        if (this.#queuedError !== undefined) {
            const error = this.#queuedError
            this.#queuedError = undefined
            throw error
        }
    }

    async retry(): Promise<void> {
        if (!this.#unsubscribe) throw new Error('Sparkplug component projection is not started')
        if (this.#drain) await this.#drain
        this.#queuedError = undefined
        this.#failed = false
        this.#pending ??= this.options.store.getSnapshot()
        this.startDrain()
        await this.flush()
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

    private observe(snapshot: SparkplugComponentProjectionView): void {
        this.#pending = snapshot
        this.#failed = false
        this.#rateWait?.abort()
        if (!this.#starting) this.startDrain()
    }

    private startDrain(): void {
        if (this.#drain || this.#failed || !this.#pending) return
        const drain = this.drainPending()
        this.#drain = drain
        void drain.then(() => {
            if (this.#drain !== drain) return
            this.#drain = undefined
            if (this.#pending && !this.#failed) this.startDrain()
        })
    }

    private async drainPending(): Promise<void> {
        while (this.#pending) {
            let snapshot = this.#pending
            this.#pending = undefined
            try {
                snapshot = await this.rateLimitedSnapshot(snapshot)
                const frame = await this.publishObserved(snapshot)
                if (frame?.type === 'DDATA') this.#lastDataPublishedAt = this.#scheduler.now()
            } catch (error) {
                this.#pending ??= snapshot
                this.#queuedError ??= error
                this.#failed = true
                return
            }
        }
    }

    private async rateLimitedSnapshot(snapshot: SparkplugComponentProjectionView): Promise<SparkplugComponentProjectionView> {
        while (
            this.#minimumPublishInterval !== 0 &&
            this.#lastDataPublishedAt !== undefined &&
            snapshot.status === 'live' &&
            snapshot.epoch === this.#bornEpoch
        ) {
            const remaining = this.#minimumPublishInterval - (this.#scheduler.now() - this.#lastDataPublishedAt)
            if (remaining <= 0) return snapshot
            const wait = new AbortController()
            this.#rateWait = wait
            await this.#scheduler.wait(remaining, wait.signal)
            if (this.#rateWait === wait) this.#rateWait = undefined
            if (!this.#pending) return snapshot
            snapshot = this.#pending
            this.#pending = undefined
        }
        return snapshot
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
