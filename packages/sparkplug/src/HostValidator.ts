import { decodeSparkplugPayload } from './Protobuf.js'
import { parseSparkplugTopic, type SparkplugMessageType } from './Types.js'
import type { SparkplugPayload } from './Payload.js'

export interface SparkplugHostObservedFrame {
    readonly topic: string
    readonly payload?: Uint8Array
    readonly payloadDescription?: SparkplugPayload
    readonly retain?: boolean
}

export interface SparkplugHostValidationIssue {
    readonly code: string
    readonly message: string
    readonly topic: string
}

interface NodeState {
    born: boolean
    bdSeq?: bigint
    seq?: number
    devices: Set<string>
}

const nodeKey = (groupId: string, edgeNodeId: string) => `${groupId}/${edgeNodeId}`

const bdSeqOf = (payload: SparkplugPayload): bigint | undefined => {
    const metric = payload.metrics.find((candidate) => candidate.name === 'bdSeq')
    if (typeof metric?.value === 'bigint') return metric.value
    if (typeof metric?.value === 'number') return BigInt(metric.value)
    return undefined
}

const nextSeq = (seq: number) => (seq + 1) % 256

type ValidatedSequencedType = Extract<SparkplugMessageType, 'NBIRTH' | 'NDATA' | 'DBIRTH' | 'DDATA' | 'DDEATH'>

const isValidatedSequencedType = (type: SparkplugMessageType | 'STATE'): type is ValidatedSequencedType =>
    type === 'NBIRTH' || type === 'NDATA' || type === 'DBIRTH' || type === 'DDATA' || type === 'DDEATH'

export class SparkplugHostValidator {
    #nodes = new Map<string, NodeState>()

    observe(frame: SparkplugHostObservedFrame): SparkplugHostValidationIssue[] {
        const parsed = parseSparkplugTopic(frame.topic)
        if (!parsed?.groupId || !parsed.edgeNodeId) return []
        if (parsed.type !== 'NDEATH' && !isValidatedSequencedType(parsed.type)) return []
        const payload = frame.payloadDescription ?? (frame.payload ? decodeSparkplugPayload(frame.payload) : undefined)
        if (!payload) return [{ code: 'missing-payload', message: `${parsed.type} needs a Sparkplug payload`, topic: frame.topic }]
        const key = nodeKey(parsed.groupId, parsed.edgeNodeId)
        const issues =
            parsed.type === 'NDEATH'
                ? this.validateNodeDeath(key, frame.topic, payload)
                : this.validateSequencedFrame(parsed.type, key, parsed.deviceId, frame.topic, payload)
        if (frame.retain !== undefined && frame.retain)
            issues.push({ code: 'retained-node-message', message: `${parsed.type} must not be retained`, topic: frame.topic })
        return issues
    }

    private validateSequencedFrame(
        type: ValidatedSequencedType,
        key: string,
        deviceId: string | undefined,
        topic: string,
        payload: SparkplugPayload
    ) {
        const issues: SparkplugHostValidationIssue[] = []
        const state = this.#nodes.get(key) ?? { born: false, devices: new Set<string>() }

        if (payload.seq === undefined) issues.push({ code: 'missing-seq', message: `${type} must carry seq`, topic })
        else if (state.seq !== undefined && payload.seq !== nextSeq(state.seq))
            issues.push({ code: 'seq-not-next', message: `${type} seq must advance the Edge Node sequence by one`, topic })

        if (type === 'NBIRTH') {
            const bdSeq = bdSeqOf(payload)
            if (bdSeq === undefined) issues.push({ code: 'missing-bdseq', message: 'NBIRTH must carry bdSeq', topic })
            if (state.born && bdSeq !== undefined && state.bdSeq !== bdSeq)
                issues.push({ code: 'rebirth-bdseq-changed', message: 'NBIRTH rebirth must keep the live bdSeq', topic })
            this.#nodes.set(key, { born: true, bdSeq, seq: payload.seq, devices: new Set<string>() })
            return issues
        }

        if (!state.born) issues.push({ code: 'data-before-birth', message: `${type} arrived before NBIRTH`, topic })
        if (type === 'DBIRTH' && deviceId) state.devices.add(deviceId)
        if ((type === 'DDATA' || type === 'DDEATH') && deviceId && !state.devices.has(deviceId))
            issues.push({ code: 'device-data-before-birth', message: `${type} arrived before DBIRTH for ${deviceId}`, topic })
        if (type === 'DDEATH' && deviceId) state.devices.delete(deviceId)
        state.seq = payload.seq
        this.#nodes.set(key, state)
        return issues
    }

    private validateNodeDeath(key: string, topic: string, payload: SparkplugPayload) {
        const issues: SparkplugHostValidationIssue[] = []
        const state = this.#nodes.get(key) ?? { born: false, devices: new Set<string>() }
        const bdSeq = bdSeqOf(payload)
        if (bdSeq === undefined) issues.push({ code: 'missing-bdseq', message: 'NDEATH must carry bdSeq', topic })
        if (!state.born) issues.push({ code: 'death-before-birth', message: 'NDEATH arrived before NBIRTH', topic })
        if (state.born && bdSeq !== undefined && state.bdSeq !== bdSeq)
            issues.push({ code: 'death-bdseq-mismatch', message: 'NDEATH bdSeq must match the live NBIRTH', topic })
        this.#nodes.set(key, { born: false, devices: new Set<string>() })
        return issues
    }
}
