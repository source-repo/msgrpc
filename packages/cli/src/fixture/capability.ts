import { rpc, rpcNamespace } from '@source-repo/rpc'
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
}
