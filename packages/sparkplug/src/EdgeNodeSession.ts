import { SparkplugBirthDeathSequence, SparkplugSequence, type SparkplugBirthDeathClaim } from './Sequence.js'
import {
    deviceBirthPayload,
    deviceDataPayload,
    deviceDeathPayload,
    isNodeRebirthCommand,
    nodeBirthPayload,
    nodeDataPayload,
    nodeDeathPayload,
    type SparkplugMetric,
    type SparkplugPayload
} from './Payload.js'
import { encodeSparkplugPayload } from './Protobuf.js'
import { deviceTopic, nodeTopic, type SparkplugDeviceMessageType, type SparkplugNodeAddress, type SparkplugNodeMessageType } from './Types.js'

export type SparkplugPublishMessageType = Exclude<SparkplugNodeMessageType | SparkplugDeviceMessageType, 'NCMD' | 'DCMD'>

export interface SparkplugPublishFrame {
    readonly topic: string
    readonly payload: Uint8Array
    readonly payloadDescription: SparkplugPayload
    readonly qos: 0 | 1
    readonly retain: false
    readonly type: SparkplugPublishMessageType
}

export type SparkplugPublisher = (frame: SparkplugPublishFrame) => void | Promise<void>

export interface SparkplugEdgeNodeSessionOptions extends SparkplugNodeAddress {
    readonly publish: SparkplugPublisher
    readonly now?: () => number
    readonly seq?: SparkplugSequence
    readonly bdSeq?: SparkplugBirthDeathSequence
}

export class SparkplugEdgeNodeSession {
    readonly groupId: string
    readonly edgeNodeId: string

    #publish: SparkplugPublisher
    #now: () => number
    #seq: SparkplugSequence
    #bdSeq: SparkplugBirthDeathSequence
    #birth?: SparkplugBirthDeathClaim
    #birthMetrics: readonly SparkplugMetric[] = []
    #bornDevices = new Set<string>()
    #deviceMetrics = new Map<string, Map<string, SparkplugMetric>>()
    #publishQueue = Promise.resolve()

    constructor(options: SparkplugEdgeNodeSessionOptions) {
        this.groupId = options.groupId
        this.edgeNodeId = options.edgeNodeId
        this.#publish = options.publish
        this.#now = options.now ?? Date.now
        this.#seq = options.seq ?? new SparkplugSequence()
        this.#bdSeq = options.bdSeq ?? new SparkplugBirthDeathSequence()
    }

    get born(): boolean {
        return this.#birth !== undefined
    }

    get bdSeq(): number | undefined {
        return this.#birth?.bdSeq
    }

    nodeWill(): SparkplugPublishFrame {
        const birth = this.#birth ?? this.#bdSeq.claimBirth()
        this.#birth = birth
        const payloadDescription = nodeDeathPayload({ timestamp: this.#now(), bdSeq: birth.bdSeq })
        return {
            topic: nodeTopic('NDEATH', this),
            payload: encodeSparkplugPayload(payloadDescription),
            payloadDescription,
            qos: 1,
            retain: false,
            type: 'NDEATH'
        }
    }

    async birth(metrics: readonly SparkplugMetric[] = []): Promise<SparkplugPublishFrame> {
        return this.enqueue(async () => {
            const birth = this.#birth ?? this.#bdSeq.claimBirth()
            this.#birth = birth
            const payloadDescription = nodeBirthPayload({ timestamp: this.#now(), seq: this.#seq.next(), bdSeq: birth.bdSeq, metrics })
            const frame = this.frame('NBIRTH', nodeTopic('NBIRTH', this), payloadDescription)
            await this.#publish(frame)
            this.#birthMetrics = metrics
            this.#bornDevices.clear()
            this.#deviceMetrics.clear()
            return frame
        })
    }

    async rebirth(metrics: readonly SparkplugMetric[] = []): Promise<SparkplugPublishFrame> {
        if (!this.#birth) throw new Error('cannot publish NBIRTH rebirth before the Edge Node is born')
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish NBIRTH rebirth before the Edge Node is born')
            const birthMetrics = metrics.length ? metrics : this.#birthMetrics
            const payloadDescription = nodeBirthPayload({ timestamp: this.#now(), seq: this.#seq.next(), bdSeq: this.#birth.bdSeq, metrics: birthMetrics })
            const birth = this.frame('NBIRTH', nodeTopic('NBIRTH', this), payloadDescription)
            await this.#publish(birth)
            this.#birthMetrics = birthMetrics
            this.#bornDevices.clear()
            for (const [deviceId, deviceMetrics] of this.#deviceMetrics) {
                const devicePayload = deviceBirthPayload({ timestamp: this.#now(), seq: this.#seq.next(), metrics: [...deviceMetrics.values()] })
                const deviceBirth = this.frame(
                    'DBIRTH',
                    deviceTopic('DBIRTH', { groupId: this.groupId, edgeNodeId: this.edgeNodeId, deviceId }),
                    devicePayload
                )
                await this.#publish(deviceBirth)
                this.#bornDevices.add(deviceId)
            }
            return birth
        })
    }

    async handleNodeCommand(payload: SparkplugPayload): Promise<SparkplugPublishFrame | undefined> {
        if (!isNodeRebirthCommand(payload)) return undefined
        return this.rebirth()
    }

    async data(metrics: readonly SparkplugMetric[]): Promise<SparkplugPublishFrame | undefined> {
        if (metrics.length === 0) return undefined
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish NDATA before NBIRTH')
            const latest = mergeMetricMap(metricMap(this.#birthMetrics), metrics)
            const payloadDescription = nodeDataPayload({ timestamp: this.#now(), seq: this.#seq.next(), metrics })
            const frame = this.frame('NDATA', nodeTopic('NDATA', this), payloadDescription)
            await this.#publish(frame)
            this.#birthMetrics = [...latest.values()]
            return frame
        })
    }

    async deviceBirth(deviceId: string, metrics: readonly SparkplugMetric[] = []): Promise<SparkplugPublishFrame> {
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish DBIRTH before NBIRTH')
            const latest = metricMap(metrics)
            const payloadDescription = deviceBirthPayload({ timestamp: this.#now(), seq: this.#seq.next(), metrics })
            const frame = this.frame('DBIRTH', deviceTopic('DBIRTH', { groupId: this.groupId, edgeNodeId: this.edgeNodeId, deviceId }), payloadDescription)
            await this.#publish(frame)
            this.#bornDevices.add(deviceId)
            this.#deviceMetrics.set(deviceId, latest)
            return frame
        })
    }

    async deviceData(deviceId: string, metrics: readonly SparkplugMetric[]): Promise<SparkplugPublishFrame | undefined> {
        if (metrics.length === 0) return undefined
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish DDATA before NBIRTH')
            if (!this.#bornDevices.has(deviceId)) throw new Error(`cannot publish DDATA before DBIRTH for ${deviceId}`)
            const latest = mergeMetricMap(new Map(this.#deviceMetrics.get(deviceId) ?? []), metrics)
            const payloadDescription = deviceDataPayload({ timestamp: this.#now(), seq: this.#seq.next(), metrics })
            const frame = this.frame('DDATA', deviceTopic('DDATA', { groupId: this.groupId, edgeNodeId: this.edgeNodeId, deviceId }), payloadDescription)
            await this.#publish(frame)
            this.#deviceMetrics.set(deviceId, latest)
            return frame
        })
    }

    async deviceDeath(deviceId: string): Promise<SparkplugPublishFrame> {
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish DDEATH before NBIRTH')
            if (!this.#bornDevices.has(deviceId)) throw new Error(`cannot publish DDEATH before DBIRTH for ${deviceId}`)
            const payloadDescription = deviceDeathPayload({ timestamp: this.#now(), seq: this.#seq.next() })
            const frame = this.frame('DDEATH', deviceTopic('DDEATH', { groupId: this.groupId, edgeNodeId: this.edgeNodeId, deviceId }), payloadDescription)
            await this.#publish(frame)
            this.#bornDevices.delete(deviceId)
            this.#deviceMetrics.delete(deviceId)
            return frame
        })
    }

    async death(): Promise<SparkplugPublishFrame> {
        return this.enqueue(async () => {
            if (!this.#birth) throw new Error('cannot publish NDEATH before NBIRTH or will creation claimed bdSeq')
            const payloadDescription = nodeDeathPayload({ timestamp: this.#now(), bdSeq: this.#birth.bdSeq })
            const frame = this.frame('NDEATH', nodeTopic('NDEATH', this), payloadDescription)
            await this.#publish(frame)
            this.#birth = undefined
            this.#bornDevices.clear()
            this.#deviceMetrics.clear()
            return frame
        })
    }

    private frame(type: SparkplugPublishMessageType, topic: string, payloadDescription: SparkplugPayload): SparkplugPublishFrame {
        return {
            topic,
            payload: encodeSparkplugPayload(payloadDescription),
            payloadDescription,
            qos: 0,
            retain: false,
            type
        }
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const pending = this.#publishQueue.then(operation, operation)
        this.#publishQueue = pending.then(
            () => undefined,
            () => undefined
        )
        return pending
    }
}

function metricKey(metric: SparkplugMetric): string {
    if (metric.alias !== undefined) return `alias:${metric.alias}`
    if (metric.name !== undefined) return `name:${metric.name}`
    throw new Error('Sparkplug metrics need a name or alias')
}

function metricMap(metrics: readonly SparkplugMetric[]): Map<string, SparkplugMetric> {
    return new Map(metrics.map((metric) => [metricKey(metric), metric]))
}

function mergeMetricMap(latest: Map<string, SparkplugMetric>, changes: readonly SparkplugMetric[]): Map<string, SparkplugMetric> {
    for (const metric of changes) {
        const key = metricKey(metric)
        const definition = latest.get(key)
        latest.set(
            key,
            definition
                ? {
                      ...definition,
                      ...metric,
                      ...(metric.name === undefined && definition.name !== undefined ? { name: definition.name } : {}),
                      ...(metric.properties === undefined && definition.properties !== undefined ? { properties: definition.properties } : {})
                  }
                : metric
        )
    }
    return latest
}
