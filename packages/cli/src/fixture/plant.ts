import { rpc, rpcNamespace } from '@source-repo/msgrpc'

export interface Limits {
    max: number
    min?: number
}

export interface Reading {
    value: number
    at: Date
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
    /** A dictionary keyed by tag, which is how plant data usually arrives. */
    @rpc
    async readings(): Promise<{ [tag: string]: Reading }> {
        return {}
    }
    /** A numeric index: still a string key on the wire, so it becomes a constrained one. */
    @rpc
    async byId(): Promise<{ [id: number]: string }> {
        return {}
    }
    /** Two instantiations of one generic alias, which must not collapse into a single named type. */
    @rpc
    async counts(): Promise<Record<string, number>> {
        return {}
    }
    @rpc
    async labels(): Promise<Record<string, string>> {
        return {}
    }
    /** Unmarked, so it must not appear in the contract. */
    async internalOnly() {
        return 'secret'
    }
}
