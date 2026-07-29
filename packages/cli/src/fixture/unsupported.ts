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
