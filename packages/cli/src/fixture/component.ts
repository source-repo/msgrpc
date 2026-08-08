import { rpc, rpcNamespace, RpcComponent } from '@source-repo/rpc'

export type OvenProps = { unit: string; maximum: number }
export type OvenState = { temperature: number; mode: 'idle' | 'heating'; zones: { top: { setpoint: number; temperature: number } } }

@rpcNamespace('oven', { version: '1' })
export class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: 'C', maximum: 200 }, { temperature: 20, mode: 'idle', zones: { top: { setpoint: 20, temperature: 20 } } })
    }

    @rpc({ semantics: 'idempotent-command', sets: 'mode' })
    async setMode(mode: OvenState['mode']) {
        this.setState({ mode })
        return mode
    }

    /** The nested case: a path nothing could infer from the method's name. */
    @rpc({ semantics: 'idempotent-command', sets: 'zones.top.setpoint' })
    async setTopSetpoint(celsius: number) {
        this.setState((previous) => ({ zones: { top: { ...previous.zones.top, setpoint: celsius } } }))
        return celsius
    }

    /** Measured, and claimed by nothing - which is how a consumer knows not to offer to write it. */
    @rpc({ semantics: 'query' })
    async readTemperature() {
        return this.state.temperature
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
