import { rpc, rpcNamespace } from '@source-repo/msgrpc'

export interface Limits {
    max: number
    min?: number
}

/** Recursive on purpose: the extractor must turn it into a named reference. */
export interface Node {
    label: string
    child?: Node
}

@rpcNamespace('plant', { version: '2' })
export class Plant {
    declare rpcEvents: { alarm: [message: string, severity: number] }

    @rpc
    async writeSetpoint(value: number, mode?: 'auto' | 'manual') {
        return value
    }
    @rpc
    async configure(limits: Limits) {
        return limits.max
    }
    @rpc
    async tree(): Promise<Node> {
        return { label: 'root' }
    }
    @rpc
    async blob(data: Uint8Array, ...tags: string[]) {
        return { at: new Date(), size: data.length, tags }
    }
    /** Unmarked, so it must not appear in the contract. */
    async internalOnly() {
        return 'secret'
    }
}
