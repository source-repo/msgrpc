import { rpc, rpcNamespace } from '@source-repo/rpc'

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
    /** Repeating this is free, and a caller may retry it as often as it likes. */
    @rpc({ semantics: 'query' })
    async readSetpoint() {
        return 1200
    }
    /** Assigns rather than accumulates, so arriving twice leaves the same state as arriving once. */
    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: 'auto' | 'manual') {
        return mode
    }
    /** Each call moves the batch on by one, so a repeat is a second batch. */
    @rpc({ semantics: 'non-repeatable-command' })
    async advanceBatch() {
        return 'advanced'
    }
    /**
     * The same semantics as setMode above and a different kind of power: repeating it leaves the
     * same recipe loaded, and loading a recipe is not adjusting a setpoint. The pair is here so the
     * extractor is tested against the case the effect classification exists for.
     */
    @rpc({ semantics: 'idempotent-command', effect: 'program' })
    async loadRecipe(recipe: string) {
        return recipe
    }
    /** Unmarked, so it must not appear in the contract. */
    async internalOnly() {
        return 'secret'
    }
}
