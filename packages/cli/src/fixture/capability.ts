import { rpc, rpcNamespace, type RpcInvocationHandle } from '@source-repo/rpc'
import type { AdvancedRenderer } from './contracts/index.js'

/** Implements the subinterface: the extract-time closure must emit the parent capability too. */
@rpcNamespace('renderer')
export class FastRenderer implements AdvancedRenderer {
    @rpc({ semantics: 'query' })
    async render(layout: string) {
        return layout
    }

    @rpc({ semantics: 'query' })
    async renderFast(layout: string) {
        return layout
    }

    /** The injected handle never reaches the contract: callers see audit(layout) alone. */
    @rpc({ semantics: 'query', injectInvocation: true })
    async audit(layout: string, invocation: RpcInvocationHandle) {
        return `${layout} audited for ${invocation.context.source}`
    }

    /**
     * The same, after an optional parameter - where the handle has to be optional too, since
     * TypeScript refuses a required parameter following one. `since` must stay optional in the
     * contract: widening it to `number | undefined` is what a caller sending nothing would be
     * refused for.
     */
    @rpc({ semantics: 'query', injectInvocation: true })
    async history(since?: number, invocation?: RpcInvocationHandle) {
        return `${since ?? 0} for ${invocation?.context.source ?? 'nobody'}`
    }
}

/** Declared here, in the same package as the class: precisely what a capability must not be. */
interface HomeGrown {
    spin(): Promise<string>
}

@rpcNamespace('local_spinner')
export class Spinner implements HomeGrown {
    @rpc({ semantics: 'query' })
    async spin() {
        return 'ok'
    }

    /** The half-declared state: a handle parameter nothing will ever inject. A diagnostic. */
    @rpc({ semantics: 'query' })
    async orphaned(value: string, invocation: RpcInvocationHandle) {
        return `${value}${String(invocation)}`
    }

    /** A typo where a grant will be written. Named rather than dropped: another diagnostic. */
    // @ts-expect-error - deliberately misspelled, so the extractor's diagnostic has something to find
    @rpc({ semantics: 'query', effect: 'programme' })
    async misspelled(value: string) {
        return value
    }
}
