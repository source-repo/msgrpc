import { SparkplugBirthDeathSequence, SparkplugSequence, type SparkplugBirthDeathClaim } from './Sequence.js'
import { isNodeRebirthCommand, nodeBirthPayload, nodeDataPayload, nodeDeathPayload, type SparkplugMetric, type SparkplugPayload } from './Payload.js'
import { encodeSparkplugPayload } from './Protobuf.js'
import { nodeTopic, type SparkplugNodeAddress, type SparkplugNodeMessageType } from './Types.js'

export interface SparkplugPublishFrame {
    readonly topic: string
    readonly payload: Uint8Array
    readonly payloadDescription: SparkplugPayload
    readonly qos: 0 | 1
    readonly retain: false
    readonly type: SparkplugNodeMessageType
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
        const birth = this.#birth ?? this.#bdSeq.claimBirth()
        this.#birth = birth
        this.#birthMetrics = metrics
        const payloadDescription = nodeBirthPayload({ timestamp: this.#now(), seq: this.#seq.next(), bdSeq: birth.bdSeq, metrics })
        const frame: SparkplugPublishFrame = {
            topic: nodeTopic('NBIRTH', this),
            payload: encodeSparkplugPayload(payloadDescription),
            payloadDescription,
            qos: 0,
            retain: false,
            type: 'NBIRTH'
        }
        await this.#publish(frame)
        return frame
    }

    async rebirth(metrics: readonly SparkplugMetric[] = []): Promise<SparkplugPublishFrame> {
        if (!this.#birth) throw new Error('cannot publish NBIRTH rebirth before the Edge Node is born')
        return this.birth(metrics.length ? metrics : this.#birthMetrics)
    }

    async handleNodeCommand(payload: SparkplugPayload): Promise<SparkplugPublishFrame | undefined> {
        if (!isNodeRebirthCommand(payload)) return undefined
        return this.rebirth()
    }

    async data(metrics: readonly SparkplugMetric[]): Promise<SparkplugPublishFrame | undefined> {
        if (!this.#birth) throw new Error('cannot publish NDATA before NBIRTH')
        if (metrics.length === 0) return undefined
        const payloadDescription = nodeDataPayload({ timestamp: this.#now(), seq: this.#seq.next(), metrics })
        const frame: SparkplugPublishFrame = {
            topic: nodeTopic('NDATA', this),
            payload: encodeSparkplugPayload(payloadDescription),
            payloadDescription,
            qos: 0,
            retain: false,
            type: 'NDATA'
        }
        await this.#publish(frame)
        return frame
    }

    async death(): Promise<SparkplugPublishFrame> {
        if (!this.#birth) throw new Error('cannot publish NDEATH before NBIRTH or will creation claimed bdSeq')
        const payloadDescription = nodeDeathPayload({ timestamp: this.#now(), bdSeq: this.#birth.bdSeq })
        const frame: SparkplugPublishFrame = {
            topic: nodeTopic('NDEATH', this),
            payload: encodeSparkplugPayload(payloadDescription),
            payloadDescription,
            qos: 0,
            retain: false,
            type: 'NDEATH'
        }
        await this.#publish(frame)
        this.#birth = undefined
        return frame
    }
}
