import test, { TestFn } from 'ava'
import { io as ioClient } from 'socket.io-client'
import { EventEmitter } from 'events'
import { RpcServer } from './RpcServer.js'
import { RpcClient, RpcProxy } from './RpcClient.js'
import { RpcError } from './RPC/RpcClientHandler.js'
import { defaultWebSocketPort } from './RPC/Rpc.js'
import { TransportEvent } from './RPC/Core.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
//import whyIsNodeRunning from 'why-is-node-running'

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

/** An isolated server/client pair on its own port, so a test can drop the link freely. */
const isolatedPair = async (port: number) => {
    const server = new RpcServer({ transports: [{ port }] })
    await server.ready()
    const eventing = new EventingRpc()
    server.exposeClassInstance(eventing, 'eventing')
    server.exposeClassInstance(new TestRpc(), 'testRpc')

    const client = new RpcClient(`http://localhost:${port}`)
    await client.ready()
    const socket = () => (client.options.transport as SocketIoClientTransport).socket!
    const dispose = async () => {
        await client.close()
        await server.close()
    }
    return { server, client, eventing, socket, dispose }
}

class EventingRpc extends EventEmitter {
    fire(value: string) {
        this.emit('ping', value)
    }
}

class TestRpc {
    async square(n: number) {
        return n * n
    }
    async boom(): Promise<never> {
        throw new Error('deliberate server-side failure')
    }
    async echoBuffer(b: Uint8Array) {
        return b
    }
    async echo(value: unknown) {
        return value
    }
    async never() {
        return new Promise<never>(() => {})
    }
}

interface Context {
    rpcServer?: RpcServer
    rpcClient?: RpcClient
    impatientClient?: RpcClient
    proxy: RpcProxy<TestRpc>
}

const testWithContext = test as TestFn<Context>

testWithContext.before(async (t) => {
    const rpcServer = new RpcServer()

    await rpcServer.ready()
    const testRpc = new TestRpc()
    rpcServer.exposeClassInstance(testRpc, 'testRpc')
    rpcServer.exposeClassInstance(new EventingRpc(), 'eventing')
    const rpcClient = new RpcClient()
    await rpcClient.ready()
    const proxy = await rpcClient.proxy<TestRpc>('testRpc')
    const impatientClient = new RpcClient(undefined, { callTimeout: 300 })
    await impatientClient.ready()
    t.context = { rpcServer, rpcClient, impatientClient, proxy }
})

testWithContext('simple test', async (t) => {
    const ctx = t.context
    const result = await ctx.proxy.remote?.square(3)
    t.is(result, 9)
})

testWithContext('a server-side throw rejects the caller promptly with the remote error', async (t) => {
    const started = Date.now()
    const error = await t.throwsAsync(async () => t.context.proxy.remote?.boom(), { instanceOf: RpcError })
    const elapsed = Date.now() - started

    t.is(error?.code, 'Exception')
    t.regex(error?.message ?? '', /deliberate server-side failure/)
    // The point of the fix: settled by the error response, not by the call timeout.
    t.true(elapsed < 1000, `expected a prompt rejection, took ${elapsed} ms`)
})

testWithContext('a remote stack is carried back to the caller', async (t) => {
    const error = await t.throwsAsync(async () => t.context.proxy.remote?.boom(), { instanceOf: RpcError })
    t.regex(error?.remoteStack ?? '', /deliberate server-side failure/)
})

testWithContext('calling a method that is not exposed rejects with MethodNotFound', async (t) => {
    const untyped = t.context.proxy.remote as unknown as { nope: () => Promise<void> }
    const error = await t.throwsAsync(async () => untyped.nope(), { instanceOf: RpcError })
    t.is(error?.code, 'MethodNotFound')
})

testWithContext('calling into a namespace that is not exposed rejects with ClassNotFound', async (t) => {
    const missing = await t.context.rpcClient!.proxy<TestRpc>('noSuchInstance')
    const error = await t.throwsAsync(async () => missing.remote?.square(2), { instanceOf: RpcError })
    t.is(error?.code, 'ClassNotFound')
})

testWithContext('an unanswered call rejects with Timeout after the configured interval', async (t) => {
    const proxy = await t.context.impatientClient!.proxy<TestRpc>('testRpc')
    const started = Date.now()
    const error = await t.throwsAsync(async () => proxy.remote?.never(), { instanceOf: RpcError })
    const elapsed = Date.now() - started

    t.is(error?.code, 'Timeout')
    t.true(elapsed < 3000, `expected the 300 ms timeout to apply, took ${elapsed} ms`)
})

testWithContext('a Uint8Array survives a round trip intact', async (t) => {
    const sent = new Uint8Array([0, 1, 2, 250, 255])
    const received = await t.context.proxy.remote?.echoBuffer(sent)

    t.true(received instanceof Uint8Array, `expected a Uint8Array, got ${received?.constructor?.name}`)
    t.deepEqual(Array.from(received!), Array.from(sent))
})

testWithContext('a nested Uint8Array survives a round trip intact', async (t) => {
    const sent = { label: 'chunk', bytes: new Uint8Array([9, 8, 7]) }
    const received = (await t.context.proxy.remote?.echo(sent)) as typeof sent

    t.true(received.bytes instanceof Uint8Array)
    t.deepEqual(Array.from(received.bytes), [9, 8, 7])
    t.is(received.label, 'chunk')
})

testWithContext('settled calls leave no pending state behind', async (t) => {
    const handler = t.context.rpcClient!.rpcClient!
    await t.context.proxy.remote?.square(4)
    await t.throwsAsync(async () => t.context.proxy.remote?.boom())

    t.is(handler.responsePromiseMap.size, 0, 'pending response promises leaked')
    t.is(handler.responseTimeoutMap.size, 0, 'pending response timers leaked')
})

testWithContext('a reply reaches only the client that made the call', async (t) => {
    // A bare socket.io connection that never identifies itself. It must see nothing.
    const eavesdropper = ioClient(`http://localhost:${defaultWebSocketPort}`)
    await new Promise<void>((resolve) => eavesdropper.on('connect', () => resolve()))
    const captured: unknown[] = []
    eavesdropper.on('message', (frame) => captured.push(frame))

    t.is(await t.context.proxy.remote?.square(5), 25)
    await new Promise((resolve) => setTimeout(resolve, 300))
    eavesdropper.close()

    t.is(captured.length, 0, 'an unrelated socket received frames addressed to another client')
})

testWithContext('an event reaches only the subscribing client', async (t) => {
    const eavesdropper = ioClient(`http://localhost:${defaultWebSocketPort}`)
    await new Promise<void>((resolve) => eavesdropper.on('connect', () => resolve()))
    const captured: unknown[] = []
    eavesdropper.on('message', (frame) => captured.push(frame))

    const subscriber = await t.context.rpcClient!.proxy<EventingRpc>('eventing')
    const received: string[] = []
    await subscriber.remote?.on('ping', (value: string) => {
        received.push(value)
    })
    await subscriber.remote?.fire('hello')
    await new Promise((resolve) => setTimeout(resolve, 300))
    eavesdropper.close()

    t.deepEqual(received, ['hello'], 'the subscriber did not receive its event')
    t.is(captured.length, 0, "an unrelated socket received another client's event")
})

testWithContext('two clients each receive their own replies', async (t) => {
    const second = await t.context.impatientClient!.proxy<TestRpc>('testRpc')
    const [a, b] = await Promise.all([t.context.proxy.remote!.square(3), second.remote!.square(4)])
    t.is(a, 9)
    t.is(b, 16)
})

testWithContext('repeating a subscription does not stack server-side listeners', async (t) => {
    const { server, client, eventing, dispose } = await isolatedPair(3101)
    const proxy = await client.proxy<EventingRpc>('eventing')

    for (let i = 0; i < 5; i++) await proxy.remote?.on('ping', () => {})

    t.is(eventing.listenerCount('ping'), 1, 'each on() stacked another server-side listener')
    t.is(server.rpc.eventProxies.size, 1)
    await dispose()
})

testWithContext('events resume after the link drops and comes back', async (t) => {
    const { server, client, eventing, socket, dispose } = await isolatedPair(3102)
    const proxy = await client.proxy<EventingRpc>('eventing')
    const received: string[] = []
    await proxy.remote?.on('ping', (value: string) => received.push(value))

    await proxy.remote?.fire('before')
    await waitFor(() => received.length === 1)

    // RpcClient emits connected only once resubscribe() has finished.
    const reconnected = new Promise<void>((resolve) => client.once(TransportEvent.connected, () => resolve()))
    socket().disconnect()
    await waitFor(() => server.rpc.eventProxies.size === 0)
    socket().connect()
    await reconnected

    await proxy.remote?.fire('after')
    await waitFor(() => received.length === 2)

    t.deepEqual(received, ['before', 'after'])
    t.is(eventing.listenerCount('ping'), 1, 'the replayed subscription stacked a duplicate listener')
    await dispose()
})

testWithContext('a departing client releases its subscriptions', async (t) => {
    const { server, client, eventing, dispose } = await isolatedPair(3103)
    const proxy = await client.proxy<EventingRpc>('eventing')
    await proxy.remote?.on('ping', () => {})
    t.is(server.rpc.eventProxies.size, 1)

    await client.close()

    await waitFor(() => server.rpc.eventProxies.size === 0)
    t.is(eventing.listenerCount('ping'), 0, 'the exposed instance kept a listener for a client that is gone')
    await dispose()
})

testWithContext('an in-flight call fails as soon as the link drops', async (t) => {
    const { client, socket, dispose } = await isolatedPair(3104)
    const proxy = await client.proxy<TestRpc>('testRpc')

    const started = Date.now()
    // The rejection lands synchronously inside disconnect(), so the assertion is attached first.
    const pending = t.throwsAsync(proxy.remote!.never(), { instanceOf: RpcError })
    socket().disconnect()
    const error = await pending
    const elapsed = Date.now() - started

    t.is(error?.code, 'TransportError')
    t.true(elapsed < 2000, `expected a prompt failure, took ${elapsed} ms`)
    await dispose()
})

testWithContext('ready() gives up instead of hanging when nothing is listening', async (t) => {
    const client = new RpcClient('http://localhost:3199', { readyTimeout: 500 })
    await t.throwsAsync(client.ready(), { message: /not ready within 500 ms/ })
    await client.close()
})

testWithContext.after(async (t) => {
    const ctx = t.context as Context
    await ctx.rpcClient?.close()
    ctx.rpcClient = undefined
    await ctx.impatientClient?.close()
    ctx.impatientClient = undefined
    await ctx.rpcServer?.close()
    ctx.rpcServer = undefined
    /*
  setTimeout(() => {
    whyIsNodeRunning()  // This will output information about active handles
  }, 5000)
  */
})
