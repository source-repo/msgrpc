import test from 'ava'
import { rpcComponent, type RpcComponentProxy } from '@source-repo/rpc'
import { sourceRpcComponentStore } from './SourceRpc.js'
import type { SparkplugComponentProjectionStore } from './Projection.js'

interface Pump {
    readonly props: { tag: string }
    readonly state: { temperature: number }
}

test('Source RPC component proxies expose the store used by the projection runner', (t) => {
    const store: SparkplugComponentProjectionStore = {
        getSnapshot: () => ({ epoch: 'e1', revision: 0, props: { tag: 'pump-7' }, state: { temperature: 21.5 }, status: 'live' }),
        subscribe: () => () => undefined,
        close: async () => undefined
    }
    const component = { [rpcComponent]: store } as unknown as RpcComponentProxy<Pump>

    t.is(sourceRpcComponentStore(component), store)
})
