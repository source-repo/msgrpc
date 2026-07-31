import { rpc, rpcNamespace, RpcComponent } from '@source-repo/rpc'

export type OvenProps = { unit: string; maximum: number }
export type OvenState = { temperature: number; mode: 'idle' | 'heating' }

@rpcNamespace('oven', { version: '1' })
export class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: 'C', maximum: 200 }, { temperature: 20, mode: 'idle' })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: OvenState['mode']) {
        this.setState({ mode })
        return mode
    }
}

/** One level down: the base chain is walked, not just the first extends clause. */
@rpcNamespace('grill')
export class Grill extends Oven {
    @rpc({ semantics: 'query' })
    async peek() {
        return this.state.temperature
    }
}

/** The dishonest case: generics with no concrete answer must be a diagnostic, never `any`. */
@rpcNamespace('half')
export class Half<T extends Record<string, unknown>> extends RpcComponent<T, T> {
    constructor(value: T) {
        super(value, value)
    }

    @rpc({ semantics: 'query' })
    async peek() {
        return this.state
    }
}
