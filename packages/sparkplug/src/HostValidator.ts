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
}

const nodeKey = (groupId: string, edgeNodeId: string) => `${groupId}/${edgeNodeId}`

const bdSeqOf = (payload: SparkplugPayload): bigint | undefined => {
    const metric = payload.metrics.find((candidate) => candidate.name === 'bdSeq')
    if (typeof metric?.value === 'bigint') return metric.value
    if (typeof metric?.value === 'number') return BigInt(metric.value)
    return undefined
}

const nextSeq = (seq: number) => (seq + 1) % 256

export class SparkplugHostValidator {
    #nodes = new Map<string, NodeState>()

    observe(frame: SparkplugHostObservedFrame): SparkplugHostValidationIssue[] {
        const parsed = parseSparkplugTopic(frame.topic)
        if (!parsed?.groupId || !parsed.edgeNodeId) return []
        if (parsed.type !== 'NBIRTH' && parsed.type !== 'NDEATH') return []
        const payload = frame.payloadDescription ?? (frame.payload ? decodeSparkplugPayload(frame.payload) : undefined)
        if (!payload) return [{ code: 'missing-payload', message: `${parsed.type} needs a Sparkplug payload`, topic: frame.topic }]
        const issues = this.validateNodeFrame(parsed.type, nodeKey(parsed.groupId, parsed.edgeNodeId), frame.topic, payload)
        if (frame.retain !== undefined && frame.retain)
            issues.push({ code: 'retained-node-message', message: `${parsed.type} must not be retained`, topic: frame.topic })
        return issues
    }

    private validateNodeFrame(type: Extract<SparkplugMessageType, 'NBIRTH' | 'NDEATH'>, key: string, topic: string, payload: SparkplugPayload) {
        const issues: SparkplugHostValidationIssue[] = []
        const state = this.#nodes.get(key) ?? { born: false }
        const bdSeq = bdSeqOf(payload)
        if (bdSeq === undefined) issues.push({ code: 'missing-bdseq', message: `${type} must carry bdSeq`, topic })

        if (type === 'NBIRTH') {
            if (payload.seq === undefined) issues.push({ code: 'missing-seq', message: 'NBIRTH must carry seq', topic })
            if (state.born && bdSeq !== undefined && state.bdSeq !== bdSeq)
                issues.push({ code: 'rebirth-bdseq-changed', message: 'NBIRTH rebirth must keep the live bdSeq', topic })
            if (state.born && payload.seq !== undefined && state.seq !== undefined && payload.seq !== nextSeq(state.seq))
                issues.push({ code: 'seq-not-next', message: 'NBIRTH rebirth seq must advance by one', topic })
            this.#nodes.set(key, { born: true, bdSeq, seq: payload.seq })
            return issues
        }

        if (!state.born) issues.push({ code: 'death-before-birth', message: 'NDEATH arrived before NBIRTH', topic })
        if (state.born && bdSeq !== undefined && state.bdSeq !== bdSeq)
            issues.push({ code: 'death-bdseq-mismatch', message: 'NDEATH bdSeq must match the live NBIRTH', topic })
        this.#nodes.set(key, { born: false })
        return issues
    }
}
