import { validateValue, type RpcProxy, type ServerDescription, type TypeNode } from '@source-repo/rpc'
import type { SparkplugMetric, SparkplugMetricPrimitive } from './Payload.js'
import { sparkplugValueAtPath, type SparkplugComponentProjectionRunner, type SparkplugComponentProjectionView } from './Projection.js'
import type { SparkplugCompiledDeviceProjection, SparkplugCompiledWritableMetric } from './ProjectionContract.js'
import type { MqttSparkplugDeviceCommand, MqttSparkplugEdgeNodeSession } from './MqttEdgeNodeSession.js'
import { SparkplugDataType } from './Types.js'

type SourceRpcCommandSurface = Record<string, (value: unknown) => Promise<unknown>>

export interface SparkplugSourceRpcCommandClient {
    proxy<T>(name: string, target?: string): Promise<RpcProxy<T>>
}

export interface SparkplugSourceRpcCommandDevice {
    readonly definition: SparkplugCompiledDeviceProjection
    readonly projection: SparkplugComponentProjectionRunner
}

export type SparkplugCommandAuditOutcome = 'refused' | 'accepted' | 'confirmed' | 'unknown'

export interface SparkplugCommandAuditEvent {
    readonly outcome: SparkplugCommandAuditOutcome
    readonly topic: string
    readonly deviceId: string
    readonly gatewayClientId: string
    readonly receivedAt: number
    readonly payloadTimestamp: number
    readonly payloadBytes: Uint8Array
    readonly metrics: readonly SparkplugMetric[]
    readonly reason?: string
}

export interface SparkplugSourceRpcCommandRunnerOptions {
    readonly edge: MqttSparkplugEdgeNodeSession
    readonly client: SparkplugSourceRpcCommandClient
    readonly devices: readonly SparkplugSourceRpcCommandDevice[]
    readonly onAudit?: (event: SparkplugCommandAuditEvent) => void | Promise<void>
    readonly now?: () => number
}

interface RuntimeWritableMetric extends SparkplugCompiledWritableMetric {
    readonly parameterType: TypeNode
    readonly sourceTypes: ServerDescription['types']
    readonly proxy: RpcProxy<SourceRpcCommandSurface>
}

interface RuntimeDevice {
    readonly definition: SparkplugCompiledDeviceProjection
    readonly projection: SparkplugComponentProjectionRunner
    readonly byName: ReadonlyMap<string, RuntimeWritableMetric>
    readonly byAlias: ReadonlyMap<number, RuntimeWritableMetric>
}

interface ValidatedCommandMetric {
    readonly definition: RuntimeWritableMetric
    readonly value: SparkplugMetricPrimitive
    readonly rateKey: string
}

class CommandDeadlineError extends Error {}

const textEncoder = new TextEncoder()

/** The explicit projection firewall from Sparkplug DCMD to Source RPC methods. */
export class SparkplugSourceRpcCommandRunner {
    readonly #devices = new Map<string, RuntimeDevice>()
    readonly #lastAcceptedAt = new Map<string, number>()
    readonly #now: () => number
    #removeHandler?: () => void
    #queue = Promise.resolve()

    constructor(private readonly options: SparkplugSourceRpcCommandRunnerOptions) {
        this.#now = options.now ?? Date.now
        const deviceIds = new Set<string>()
        for (const device of options.devices) {
            if (deviceIds.has(device.definition.deviceId)) throw new Error(`duplicate command Device ${JSON.stringify(device.definition.deviceId)}`)
            deviceIds.add(device.definition.deviceId)
        }
    }

    async start(): Promise<void> {
        if (this.#removeHandler) throw new Error('Sparkplug Source RPC command runner is already started')
        await this.loadRuntimeMappings()
        this.#removeHandler = this.options.edge.setDeviceCommandHandler((command) => this.handle(command))
    }

    handle(command: MqttSparkplugDeviceCommand): Promise<void> {
        const pending = this.#queue.then(
            () => this.process(command),
            () => this.process(command)
        )
        this.#queue = pending.then(
            () => undefined,
            () => undefined
        )
        return pending
    }

    async close(): Promise<void> {
        this.#removeHandler?.()
        this.#removeHandler = undefined
        await this.#queue
        this.#devices.clear()
    }

    private async loadRuntimeMappings(): Promise<void> {
        this.#devices.clear()
        const descriptions = new Map<string, ServerDescription>()
        for (const device of this.options.devices) {
            const writable = device.definition.writable
            if (writable.length === 0) {
                this.#devices.set(device.definition.deviceId, {
                    definition: device.definition,
                    projection: device.projection,
                    byName: new Map(),
                    byAlias: new Map()
                })
                continue
            }
            let description = descriptions.get(device.definition.source.peer)
            if (!description) {
                const introspection = await this.options.client.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', device.definition.source.peer)
                description = await introspection.describe()
                descriptions.set(device.definition.source.peer, description)
            }
            const namespace = description.namespaces.find((candidate) => candidate.name === device.definition.source.component)
            if (!namespace)
                throw new Error(
                    `writable Device ${JSON.stringify(device.definition.deviceId)} source ${device.definition.source.peer}.${device.definition.source.component} is not described`
                )
            const proxy = await this.options.client.proxy<SourceRpcCommandSurface>(device.definition.source.component, device.definition.source.peer)
            const runtime = writable.map((mapping): RuntimeWritableMetric => {
                const method = namespace.methods.find((candidate) => candidate.name === mapping.method)
                if (!method)
                    throw new Error(
                        `writable metric ${JSON.stringify(mapping.name)} maps to missing method ${device.definition.source.peer}.${device.definition.source.component}.${mapping.method}`
                    )
                if (method.semantics !== 'idempotent-command')
                    throw new Error(`${device.definition.source.component}.${mapping.method} must declare idempotent-command semantics`)
                if (method.requiresAuthority) throw new Error(`${device.definition.source.component}.${mapping.method} requires authority and cannot cross Sparkplug`)
                if (!method.params || method.params.length !== 1 || method.rest)
                    throw new Error(`${device.definition.source.component}.${mapping.method} must publish a schema with exactly one parameter and no rest parameter`)
                return { ...mapping, parameterType: method.params[0]!, sourceTypes: description!.types, proxy }
            })
            this.#devices.set(device.definition.deviceId, {
                definition: device.definition,
                projection: device.projection,
                byName: new Map(runtime.map((mapping) => [mapping.name, mapping])),
                byAlias: new Map(runtime.map((mapping) => [mapping.alias, mapping]))
            })
        }
    }

    private async process(command: MqttSparkplugDeviceCommand): Promise<void> {
        let validated: { device: RuntimeDevice; metrics: ValidatedCommandMetric[] }
        try {
            validated = this.validate(command)
        } catch (error) {
            await this.audit(command, 'refused', errorText(error))
            return
        }

        const acceptedAt = this.#now()
        for (const metric of validated.metrics) this.#lastAcceptedAt.set(metric.rateKey, acceptedAt)
        await this.audit(command, 'accepted')

        try {
            for (const metric of validated.metrics) await this.execute(command, validated.device, metric)
            await this.audit(command, 'confirmed')
        } catch (error) {
            await this.audit(command, 'unknown', errorText(error))
        }
    }

    private validate(command: MqttSparkplugDeviceCommand): { device: RuntimeDevice; metrics: ValidatedCommandMetric[] } {
        const device = this.#devices.get(command.deviceId)
        if (!device) throw new Error(`Device ${JSON.stringify(command.deviceId)} is not projected`)
        if (command.payload.metrics.length === 0) throw new Error('DCMD contains no metrics')
        const seen = new Set<string>()
        const now = this.#now()
        const metrics = command.payload.metrics.map((metric, index): ValidatedCommandMetric => {
            const definition = resolveWritableMetric(device, metric, index)
            if (seen.has(definition.name)) throw new Error(`DCMD duplicates writable metric ${JSON.stringify(definition.name)}`)
            seen.add(definition.name)
            if (metric.isNull || metric.value === undefined) throw new Error(`DCMD metric ${JSON.stringify(definition.name)} cannot be null`)
            if (metric.isHistorical || metric.isTransient) throw new Error(`DCMD metric ${JSON.stringify(definition.name)} cannot be historical or transient`)
            if (metric.datatype !== SparkplugDataType.Unknown && metric.datatype !== definition.sparkplugDatatype)
                throw new Error(`DCMD metric ${JSON.stringify(definition.name)} datatype does not match the projection contract`)
            validateCommandUnit(metric, definition)
            const value = validateCommandValue(metric.value, definition)
            const sourceFailure = validateValue(value, definition.parameterType, definition.sourceTypes)
            if (sourceFailure)
                throw new Error(
                    `DCMD metric ${JSON.stringify(definition.name)} is incompatible with ${device.definition.source.component}.${definition.method}: ${sourceFailure}`
                )
            const rateKey = `${device.definition.deviceId}\0${definition.name}`
            const previous = this.#lastAcceptedAt.get(rateKey)
            const minimumInterval = 1000 / definition.maxCommandsPerSecond
            if (previous !== undefined && now - previous < minimumInterval)
                throw new Error(`DCMD metric ${JSON.stringify(definition.name)} exceeds maxCommandsPerSecond ${definition.maxCommandsPerSecond}`)
            return { definition, value, rateKey }
        })
        return { device, metrics }
    }

    private async execute(command: MqttSparkplugDeviceCommand, device: RuntimeDevice, metric: ValidatedCommandMetric): Promise<void> {
        const deadline = command.receivedAt + metric.definition.deadlineMs
        const before = device.projection.store.getSnapshot()
        const sameBefore = reportedValueMatches(before, metric.definition.path, metric.value)
        const timeoutMs = remainingMilliseconds(deadline, this.#now())
        const method = metric.definition.proxy.$with({ timeoutMs })[metric.definition.method]
        const call = method!(metric.value).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error })
        )

        if (sameBefore) {
            const result = await call
            if (!result.ok)
                throw new CommandDeadlineError(
                    `${metric.definition.method} did not return successfully; unchanged state cannot confirm its outcome: ${errorText(result.error)}`
                )
            await this.waitForReportedValue(device, metric.definition, metric.value, deadline)
            await this.beforeDeadline(() => device.projection.confirmMetric(metric.definition.name, true), deadline)
            return
        }

        const reported = this.waitForReportedValue(device, metric.definition, metric.value, deadline)
        const first = await Promise.race([reported.then(() => 'reported' as const), call.then(() => 'call' as const)])
        if (first === 'call') await reported
        await this.beforeDeadline(() => device.projection.confirmMetric(metric.definition.name), deadline)
    }

    private async waitForReportedValue(
        device: RuntimeDevice,
        definition: RuntimeWritableMetric,
        expected: SparkplugMetricPrimitive,
        deadline: number
    ): Promise<void> {
        if (reportedValueMatches(device.projection.store.getSnapshot(), definition.path, expected)) return
        const timeoutMs = remainingMilliseconds(deadline, this.#now())
        await new Promise<void>((resolve, reject) => {
            let settled = false
            let unsubscribe: () => void = () => undefined
            const finish = (error?: Error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                unsubscribe()
                if (error) reject(error)
                else resolve()
            }
            const check = () => {
                if (reportedValueMatches(device.projection.store.getSnapshot(), definition.path, expected)) finish()
            }
            const timer = setTimeout(
                () => finish(new CommandDeadlineError(`${definition.method} did not reach reported state ${definition.path} within ${definition.deadlineMs} ms`)),
                timeoutMs
            )
            unsubscribe = device.projection.store.subscribe(check)
            check()
        })
    }

    private async beforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<T> {
        const timeoutMs = remainingMilliseconds(deadline, this.#now())
        const operation = start()
        return await new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new CommandDeadlineError('reported state reached the gateway but was not published before the command deadline')), timeoutMs)
            void operation.then(
                (value) => {
                    clearTimeout(timer)
                    resolve(value)
                },
                (error) => {
                    clearTimeout(timer)
                    reject(error)
                }
            )
        })
    }

    private async audit(command: MqttSparkplugDeviceCommand, outcome: SparkplugCommandAuditOutcome, reason?: string): Promise<void> {
        await this.options.onAudit?.({
            outcome,
            topic: command.topic,
            deviceId: command.deviceId,
            gatewayClientId: command.gatewayClientId,
            receivedAt: command.receivedAt,
            payloadTimestamp: command.payload.timestamp,
            payloadBytes: command.payloadBytes,
            metrics: command.payload.metrics,
            ...(reason === undefined ? {} : { reason })
        })
    }
}

function resolveWritableMetric(device: RuntimeDevice, metric: SparkplugMetric, index: number): RuntimeWritableMetric {
    const byName = metric.name === undefined ? undefined : device.byName.get(metric.name)
    const byAlias = metric.alias === undefined ? undefined : device.byAlias.get(metric.alias)
    if (metric.name !== undefined && !byName) throw new Error(`DCMD metric ${index} name ${JSON.stringify(metric.name)} is not writable`)
    if (metric.alias !== undefined && !byAlias) throw new Error(`DCMD metric ${index} alias ${metric.alias} is not writable`)
    if (byName && byAlias && byName !== byAlias) throw new Error(`DCMD metric ${index} name and alias identify different writable metrics`)
    const resolved = byName ?? byAlias
    if (!resolved) throw new Error(`DCMD metric ${index} must identify a writable metric by name or alias`)
    return resolved
}

function validateCommandUnit(metric: SparkplugMetric, definition: SparkplugCompiledWritableMetric): void {
    const supplied = metric.properties?.['source-rpc/unit']
    if (!supplied) return
    if (supplied.isNull || supplied.datatype !== SparkplugDataType.String || typeof supplied.value !== 'string')
        throw new Error(`DCMD metric ${JSON.stringify(definition.name)} unit must be a non-null String property`)
    if (definition.unit === undefined) throw new Error(`DCMD metric ${JSON.stringify(definition.name)} supplies a unit for a dimensionless mapping`)
    if (supplied.value !== definition.unit)
        throw new Error(`DCMD metric ${JSON.stringify(definition.name)} unit ${JSON.stringify(supplied.value)} does not match ${JSON.stringify(definition.unit)}`)
}

function validateCommandValue(value: SparkplugMetricPrimitive, definition: SparkplugCompiledWritableMetric): SparkplugMetricPrimitive {
    let normalized = value
    switch (definition.sparkplugDatatype) {
        case SparkplugDataType.Boolean:
            if (typeof value !== 'boolean') throw commandTypeError(definition, 'boolean')
            break
        case SparkplugDataType.Float:
        case SparkplugDataType.Double:
            if (typeof value !== 'number' || !Number.isFinite(value)) throw commandTypeError(definition, 'finite number')
            break
        case SparkplugDataType.Int8:
            normalized = commandInteger(value, definition, -0x80, 0x7f)
            break
        case SparkplugDataType.Int16:
            normalized = commandInteger(value, definition, -0x8000, 0x7fff)
            break
        case SparkplugDataType.Int32:
            normalized = commandInteger(value, definition, -0x8000_0000, 0x7fff_ffff)
            break
        case SparkplugDataType.UInt8:
            normalized = commandInteger(value, definition, 0, 0xff)
            break
        case SparkplugDataType.UInt16:
            normalized = commandInteger(value, definition, 0, 0xffff)
            break
        case SparkplugDataType.UInt32:
            normalized = commandInteger(value, definition, 0, 0xffff_ffff)
            break
        case SparkplugDataType.Int64:
        case SparkplugDataType.UInt64:
            normalized = safeLong(value, definition)
            break
        case SparkplugDataType.String:
        case SparkplugDataType.Text:
        case SparkplugDataType.UUID:
            if (typeof value !== 'string') throw commandTypeError(definition, 'string')
            if (definition.maxBytes !== undefined && textEncoder.encode(value).length > definition.maxBytes)
                throw new Error(`DCMD metric ${JSON.stringify(definition.name)} exceeds maxBytes ${definition.maxBytes}`)
            break
        case SparkplugDataType.Bytes:
        case SparkplugDataType.File:
            if (!(value instanceof Uint8Array)) throw commandTypeError(definition, 'bytes')
            if (definition.maxBytes !== undefined && value.length > definition.maxBytes)
                throw new Error(`DCMD metric ${JSON.stringify(definition.name)} exceeds maxBytes ${definition.maxBytes}`)
            break
        default:
            throw new Error(`DCMD metric ${JSON.stringify(definition.name)} uses an unsupported writable datatype`)
    }
    if (typeof normalized === 'number') {
        if (definition.minimum !== undefined && normalized < definition.minimum)
            throw new Error(`DCMD metric ${JSON.stringify(definition.name)} is below minimum ${definition.minimum}`)
        if (definition.maximum !== undefined && normalized > definition.maximum)
            throw new Error(`DCMD metric ${JSON.stringify(definition.name)} is above maximum ${definition.maximum}`)
    }
    return normalized
}

function commandInteger(value: SparkplugMetricPrimitive, definition: SparkplugCompiledWritableMetric, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw commandTypeError(definition, 'safe integer')
    if (value < minimum || value > maximum) throw new Error(`DCMD metric ${JSON.stringify(definition.name)} is outside its ${definition.datatype} range`)
    return value
}

function safeLong(value: SparkplugMetricPrimitive, definition: SparkplugCompiledWritableMetric): number {
    let normalized: number
    if (typeof value === 'bigint') {
        const converted = Number(value)
        if (!Number.isSafeInteger(converted) || BigInt(converted) !== value)
            throw new Error(`DCMD metric ${JSON.stringify(definition.name)} cannot cross Source RPC without losing 64-bit precision`)
        normalized = converted
    } else {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw commandTypeError(definition, 'safe integer')
        normalized = value
    }
    if (definition.sparkplugDatatype === SparkplugDataType.UInt64 && normalized < 0)
        throw new Error(`DCMD metric ${JSON.stringify(definition.name)} is outside its UInt64 range`)
    return normalized
}

function commandTypeError(definition: SparkplugCompiledWritableMetric, expected: string): Error {
    return new Error(`DCMD metric ${JSON.stringify(definition.name)} must carry ${expected}`)
}

function reportedValueMatches(snapshot: SparkplugComponentProjectionView, path: string, expected: SparkplugMetricPrimitive): boolean {
    if (snapshot.status !== 'live') return false
    const actual = sparkplugValueAtPath({ props: snapshot.props, state: snapshot.state }, path)
    if (actual instanceof Uint8Array && expected instanceof Uint8Array)
        return actual.length === expected.length && actual.every((value, index) => value === expected[index])
    if (typeof actual === 'bigint' && typeof expected === 'number' && Number.isSafeInteger(expected)) return actual === BigInt(expected)
    if (typeof actual === 'number' && Number.isSafeInteger(actual) && typeof expected === 'bigint') return BigInt(actual) === expected
    return Object.is(actual, expected)
}

function remainingMilliseconds(deadline: number, now: number): number {
    const remaining = Math.ceil(deadline - now)
    if (remaining <= 0) throw new CommandDeadlineError('command deadline expired before completion')
    return remaining
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
