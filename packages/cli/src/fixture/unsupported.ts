import { rpc, rpcNamespace } from '@source-repo/rpc'

@rpcNamespace('bad')
export class Bad {
    /** Generic: no runtime type exists to check. */
    @rpc
    async fetch<T>(id: string): Promise<T> {
        return id as unknown as T
    }
    /** A callback cannot be checked on the wire. */
    @rpc
    async subscribe(handler: (value: number) => void) {
        handler(1)
    }
    /** MsgPack does not carry a Map. */
    @rpc
    async lookup(): Promise<Map<string, number>> {
        return new Map()
    }
    /** Part dictionary, part declared shape: describing either half alone would check neither. */
    @rpc
    async mixed(): Promise<{ name: string; [tag: string]: unknown }> {
        return { name: '' }
    }
}

const NAMESPACE = 'computed'

/**
 * A namespace named by a constant. Legal TypeScript, and unreadable here: extraction reads the
 * source rather than running it, so this used to be skipped and the contract came out empty.
 */
@rpcNamespace(NAMESPACE)
export class Computed {
    @rpc
    async read() {
        return 1
    }
}
