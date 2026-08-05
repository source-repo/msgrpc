import { rpcComponent, type RpcComponentLike, type RpcComponentProxy } from '@source-repo/rpc'
import type { SparkplugComponentProjectionStore } from './Projection.js'

export function sourceRpcComponentStore<T extends RpcComponentLike>(component: RpcComponentProxy<T>): SparkplugComponentProjectionStore {
    return component[rpcComponent]
}
