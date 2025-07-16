import test, { TestFn } from 'ava'
import { RpcServer } from './RpcServer.js'
import { RpcClient, RpcProxy } from './RpcClient.js'
//import whyIsNodeRunning from 'why-is-node-running'

class TestRpc {
    async square(n: number) {
        return n * n
    }
}

interface Context {
    rpcServer?: RpcServer
    rpcClient?: RpcClient
    proxy: RpcProxy<TestRpc>
}

const testWithContext = test as TestFn<Context>

testWithContext.before(async (t) => {
    const rpcServer = new RpcServer()

    await rpcServer.ready()
    const testRpc = new TestRpc()
    rpcServer.exposeClassInstance(testRpc, 'testRpc')
    const rpcClient = new RpcClient()
    await rpcClient.ready()
    const proxy = await rpcClient.proxy<TestRpc>('testRpc')
    t.context = { rpcServer, rpcClient, proxy }
})

testWithContext('simple test', async (t) => {
    const ctx = t.context
    const result = await ctx.proxy.remote?.square(3)
    t.is(result, 9)
})

testWithContext.after(async (t) => {
    const ctx = t.context as Context
    await ctx.rpcClient?.close()
    ctx.rpcClient = undefined
    await ctx.rpcServer?.close()
    ctx.rpcServer = undefined
    /*
  setTimeout(() => {
    whyIsNodeRunning()  // This will output information about active handles
  }, 5000)
  */
})
