import test, { TestFn } from 'ava'
import { io as ioClient } from 'socket.io-client'
import { EventEmitter } from 'events'
import { RpcServer } from './index.js'
import { RpcClient, RpcProxy } from './RpcClient.js'
import { RpcError } from './RPC/RpcClientHandler.js'
import { MessageType, TransportEvent } from './RPC/Core.js'
import { RpcEventPayload, RpcMessageType } from './RPC/Messages.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
//import whyIsNodeRunning from 'why-is-node-running'

/** Deliberately not the default 3000: a test suite should not squat on a port people develop on. */
const SHARED_PORT = 3910

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
    const rpcServer = new RpcServer({ transports: [{ port: SHARED_PORT }] })

    await rpcServer.ready()
    const testRpc = new TestRpc()
    rpcServer.exposeClassInstance(testRpc, 'testRpc')
    rpcServer.exposeClassInstance(new EventingRpc(), 'eventing')
    const rpcClient = new RpcClient(`http://localhost:${SHARED_PORT}`)
    await rpcClient.ready()
    const proxy = await rpcClient.proxy<TestRpc>('testRpc')
    const impatientClient = new RpcClient(`http://localhost:${SHARED_PORT}`, { callTimeout: 300 })
    await impatientClient.ready()
    t.context = { rpcServer, rpcClient, impatientClient, proxy }
})

testWithContext.serial('simple test', async (t) => {
    const ctx = t.context
    const result = await ctx.proxy.square(3)
    t.is(result, 9)
})

testWithContext.serial('a server-side throw rejects the caller promptly with the remote error', async (t) => {
    const started = Date.now()
    const error = await t.throwsAsync(async () => t.context.proxy.boom(), { instanceOf: RpcError })
    const elapsed = Date.now() - started

    t.is(error?.code, 'Exception')
    t.regex(error?.message ?? '', /deliberate server-side failure/)
    // The point of the fix: settled by the error response, not by the call timeout.
    t.true(elapsed < 1000, `expected a prompt rejection, took ${elapsed} ms`)
})

testWithContext.serial('a remote stack is carried back to the caller', async (t) => {
    const error = await t.throwsAsync(async () => t.context.proxy.boom(), { instanceOf: RpcError })
    t.regex(error?.remoteStack ?? '', /deliberate server-side failure/)
})

testWithContext.serial('calling a method that is not exposed rejects with MethodNotFound', async (t) => {
    const untyped = t.context.proxy as unknown as { nope: () => Promise<void> }
    const error = await t.throwsAsync(async () => untyped.nope(), { instanceOf: RpcError })
    t.is(error?.code, 'MethodNotFound')
})

testWithContext.serial('calling into a namespace that is not exposed rejects with ClassNotFound', async (t) => {
    const missing = await t.context.rpcClient!.proxy<TestRpc>('noSuchInstance')
    const error = await t.throwsAsync(async () => missing.square(2), { instanceOf: RpcError })
    t.is(error?.code, 'ClassNotFound')
})

testWithContext.serial('an unanswered call rejects with Timeout after the configured interval', async (t) => {
    const proxy = await t.context.impatientClient!.proxy<TestRpc>('testRpc')
    const started = Date.now()
    const error = await t.throwsAsync(async () => proxy.never(), { instanceOf: RpcError })
    const elapsed = Date.now() - started

    t.is(error?.code, 'Timeout')
    t.true(elapsed < 3000, `expected the 300 ms timeout to apply, took ${elapsed} ms`)
})

testWithContext.serial('a Uint8Array survives a round trip intact', async (t) => {
    const sent = new Uint8Array([0, 1, 2, 250, 255])
    const received = await t.context.proxy.echoBuffer(sent)

    t.true(received instanceof Uint8Array, `expected a Uint8Array, got ${received?.constructor?.name}`)
    t.deepEqual(Array.from(received!), Array.from(sent))
})

testWithContext.serial('a nested Uint8Array survives a round trip intact', async (t) => {
    const sent = { label: 'chunk', bytes: new Uint8Array([9, 8, 7]) }
    const received = (await t.context.proxy.echo(sent)) as typeof sent

    t.true(received.bytes instanceof Uint8Array)
    t.deepEqual(Array.from(received.bytes), [9, 8, 7])
    t.is(received.label, 'chunk')
})

testWithContext.serial('settled calls leave no pending state behind', async (t) => {
    const handler = t.context.rpcClient!.rpcClient!
    await t.context.proxy.square(4)
    await t.throwsAsync(async () => t.context.proxy.boom())

    t.is(handler.responsePromiseMap.size, 0, 'pending response promises leaked')
    t.is(handler.responseTimeoutMap.size, 0, 'pending response timers leaked')
})

testWithContext.serial('a reply reaches only the client that made the call', async (t) => {
    // A bare socket.io connection that never identifies itself. It must see nothing.
    const eavesdropper = ioClient(`http://localhost:${SHARED_PORT}`)
    await new Promise<void>((resolve) => eavesdropper.on('connect', () => resolve()))
    const captured: unknown[] = []
    eavesdropper.on('message', (frame) => captured.push(frame))

    t.is(await t.context.proxy.square(5), 25)
    await new Promise((resolve) => setTimeout(resolve, 300))
    eavesdropper.close()

    t.is(captured.length, 0, 'an unrelated socket received frames addressed to another client')
})

testWithContext.serial('an event reaches only the subscribing client', async (t) => {
    const eavesdropper = ioClient(`http://localhost:${SHARED_PORT}`)
    await new Promise<void>((resolve) => eavesdropper.on('connect', () => resolve()))
    const captured: unknown[] = []
    eavesdropper.on('message', (frame) => captured.push(frame))

    const subscriber = await t.context.rpcClient!.proxy<EventingRpc>('eventing')
    const received: string[] = []
    await subscriber.on('ping', (value: string) => {
        received.push(value)
    })
    await subscriber.fire('hello')
    await new Promise((resolve) => setTimeout(resolve, 300))
    eavesdropper.close()

    t.deepEqual(received, ['hello'], 'the subscriber did not receive its event')
    t.is(captured.length, 0, "an unrelated socket received another client's event")
})

testWithContext.serial('two clients each receive their own replies', async (t) => {
    const second = await t.context.impatientClient!.proxy<TestRpc>('testRpc')
    const [a, b] = await Promise.all([t.context.proxy.square(3), second.square(4)])
    t.is(a, 9)
    t.is(b, 16)
})

testWithContext.serial('repeating a subscription does not stack server-side listeners', async (t) => {
    const { server, client, eventing, dispose } = await isolatedPair(3101)
    const proxy = await client.proxy<EventingRpc>('eventing')

    for (let i = 0; i < 5; i++) await proxy.on('ping', () => {})

    t.is(eventing.listenerCount('ping'), 1, 'each on() stacked another server-side listener')
    t.is(server.rpc.eventProxies.size, 1)
    await dispose()
})

testWithContext.serial('events resume after the link drops and comes back', async (t) => {
    const { server, client, eventing, socket, dispose } = await isolatedPair(3102)
    const proxy = await client.proxy<EventingRpc>('eventing')
    const received: string[] = []
    await proxy.on('ping', (value: string) => received.push(value))

    await proxy.fire('before')
    await waitFor(() => received.length === 1)

    // RpcClient emits connected only once resubscribe() has finished.
    const reconnected = new Promise<void>((resolve) => client.once(TransportEvent.connected, () => resolve()))
    socket().disconnect()
    await waitFor(() => server.rpc.eventProxies.size === 0)
    socket().connect()
    await reconnected

    await proxy.fire('after')
    await waitFor(() => received.length === 2)

    t.deepEqual(received, ['before', 'after'])
    t.is(eventing.listenerCount('ping'), 1, 'the replayed subscription stacked a duplicate listener')
    await dispose()
})

testWithContext.serial('a departing client releases its subscriptions', async (t) => {
    const { server, client, eventing, dispose } = await isolatedPair(3103)
    const proxy = await client.proxy<EventingRpc>('eventing')
    await proxy.on('ping', () => {})
    t.is(server.rpc.eventProxies.size, 1)

    await client.close()

    await waitFor(() => server.rpc.eventProxies.size === 0)
    t.is(eventing.listenerCount('ping'), 0, 'the exposed instance kept a listener for a client that is gone')
    await dispose()
})

testWithContext.serial('an in-flight call fails as soon as the link drops', async (t) => {
    const { client, socket, dispose } = await isolatedPair(3104)
    const proxy = await client.proxy<TestRpc>('testRpc')

    const started = Date.now()
    // The rejection lands synchronously inside disconnect(), so the assertion is attached first.
    const pending = t.throwsAsync(proxy.never(), { instanceOf: RpcError })
    socket().disconnect()
    const error = await pending
    const elapsed = Date.now() - started

    t.is(error?.code, 'TransportError')
    t.true(elapsed < 2000, `expected a prompt failure, took ${elapsed} ms`)
    await dispose()
})

testWithContext.serial('ready() gives up instead of hanging when nothing is listening', async (t) => {
    const client = new RpcClient('http://localhost:3199', { readyTimeout: 500 })
    await t.throwsAsync(client.ready(), { message: /not ready within 500 ms/ })
    await client.close()
})

testWithContext.serial('an event reaches only the namespace it was taken out on', async (t) => {
    // Both instances emit 'ping'. Handlers used to be keyed by event name alone, so each event
    // went to every subscriber of that name whatever instance it came from.
    const server = new RpcServer({ transports: [{ port: 3105 }] })
    await server.ready()
    const plant = new EventingRpc()
    const boiler = new EventingRpc()
    server.exposeClassInstance(plant, 'plant')
    server.exposeClassInstance(boiler, 'boiler')
    const client = new RpcClient('http://localhost:3105')
    await client.ready()

    const fromPlant: string[] = []
    const fromBoiler: string[] = []
    await (await client.proxy<EventingRpc>('plant')).on('ping', (value: string) => fromPlant.push(value))
    await (await client.proxy<EventingRpc>('boiler')).on('ping', (value: string) => fromBoiler.push(value))

    plant.fire('only-plant')
    await waitFor(() => fromPlant.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))

    t.deepEqual(fromPlant, ['only-plant'])
    t.deepEqual(fromBoiler, [], 'an event leaked into another namespace')

    await client.close()
    await server.close()
})

testWithContext.serial('unsubscribing one namespace leaves the other subscribed', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3106 }] })
    await server.ready()
    const plant = new EventingRpc()
    const boiler = new EventingRpc()
    server.exposeClassInstance(plant, 'plant')
    server.exposeClassInstance(boiler, 'boiler')
    const client = new RpcClient('http://localhost:3106')
    await client.ready()

    const fromPlant: string[] = []
    const fromBoiler: string[] = []
    const plantHandler = (value: string) => fromPlant.push(value)
    const plantProxy = await client.proxy<EventingRpc>('plant')
    await plantProxy.on('ping', plantHandler)
    await (await client.proxy<EventingRpc>('boiler')).on('ping', (value: string) => fromBoiler.push(value))

    await plantProxy.off('ping', plantHandler)
    await waitFor(() => server.rpc.eventProxies.size === 1)

    boiler.fire('still-here')
    await waitFor(() => fromBoiler.length === 1)
    plant.fire('should-be-gone')
    await new Promise((resolve) => setTimeout(resolve, 200))

    t.deepEqual(fromBoiler, ['still-here'])
    t.deepEqual(fromPlant, [], 'an unsubscribed namespace still received its event')

    await client.close()
    await server.close()
})

testWithContext.serial('an event that does not name its instance still reaches its subscriber', async (t) => {
    // A peer that omits the emitting instance, which is what an older server sends.
    const server = new RpcServer({ transports: [{ port: 3107 }] })
    await server.ready()
    server.exposeClassInstance(new EventingRpc(), 'eventing')
    const client = new RpcClient('http://localhost:3107')
    await client.ready()
    const got: string[] = []
    await (await client.proxy<EventingRpc>('eventing')).on('ping', (value: string) => got.push(value))

    const unnamed: RpcEventPayload = { type: RpcMessageType.event, event: 'ping', params: ['unnamed'] }
    await client.rpcClient!.receive({ type: MessageType.EventMessage, payload: unnamed }, '*')

    t.deepEqual(got, ['unnamed'], 'an event without a path was dropped')

    await client.close()
    await server.close()
})

testWithContext.serial('a proxy is not a thenable, so awaiting the one proxy() returns settles', async (t) => {
    // `proxy()` is async and returns the proxy itself, so `await` probes it for `then`. If the trap
    // answers with a caller for a remote method named `then`, the runtime adopts the proxy as a
    // promise and the await never settles - every call in the library hangs, and the failure looks
    // like a network timeout rather than a language rule. This is the guard on that.
    const proxy = t.context.proxy as unknown as { then?: unknown }
    t.is(proxy.then, undefined, 'a proxy that reports a `then` will be adopted by await')

    // The same thing end to end: if the above regressed, this call would never return.
    t.is(await t.context.proxy.square(7), 49)

    // Passing one to Promise.resolve is the other way a thenable gets adopted.
    const resolved = await Promise.resolve(t.context.proxy)
    t.is(await resolved.square(8), 64)
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

// ---------------------------------------------------------------- the 4.1 prerequisites

class SlowRpc {
    async slow(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return 'done'
    }
}

test('a per-call timeout overrides the client default, in both directions', async (t) => {
    const { client, dispose } = await isolatedPair(3851)
    const proxy = await client.proxy<TestRpc>('testRpc')

    // Shorter than the 10s default: the call gives up at the per-call number, and says which.
    const started = Date.now()
    const failure = await t.throwsAsync(proxy.$with({ timeoutMs: 150 }).never())
    t.regex(String(failure?.message), /within 150 ms/, `expected the per-call timeout, got: ${failure?.message}`)
    t.true(Date.now() - started < 5000, 'the call waited out the client default instead of the per-call timeout')

    await dispose()
})

test('a per-call timeout can outlast an impatient client default', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3852 }] })
    await server.ready()
    server.exposeClassInstance(new SlowRpc(), 'slowRpc')
    const client = new RpcClient('http://localhost:3852', { callTimeout: 150 })
    await client.ready()
    const proxy = await client.proxy<SlowRpc>('slowRpc')

    // The default is provably too short for this method...
    const failure = await t.throwsAsync(proxy.slow(400))
    t.regex(String(failure?.message), /Timeout/)
    // ...and the per-call override is what lets the same call succeed.
    t.is(await proxy.$with({ timeoutMs: 5000 }).slow(400), 'done')

    await client.close()
    await server.close()
})

test('a zero timeout waits instead of timing out on the next tick', async (t) => {
    // The bug this pins down: callTimeout 0 correctly omitted the wire ttl but still armed
    // setTimeout(..., 0), so "no deadline" meant "no chance" - the timer fired before any reply
    // could possibly arrive.
    const server = new RpcServer({ transports: [{ port: 3853 }] })
    await server.ready()
    server.exposeClassInstance(new SlowRpc(), 'slowRpc')

    const patient = new RpcClient('http://localhost:3853', { callTimeout: 0 })
    await patient.ready()
    const viaDefault = await patient.proxy<SlowRpc>('slowRpc')
    t.is(await viaDefault.slow(300), 'done', 'a disabled client timeout timed the call out anyway')

    const impatient = new RpcClient('http://localhost:3853', { callTimeout: 150 })
    await impatient.ready()
    const viaOption = await impatient.proxy<SlowRpc>('slowRpc')
    t.is(await viaOption.$with({ timeoutMs: 0 }).slow(300), 'done', 'a disabled per-call timeout timed the call out anyway')

    await patient.close()
    await impatient.close()
    await server.close()
})

test('a timeout that is not a finite non-negative integer is refused before anything is sent', async (t) => {
    const { client, dispose } = await isolatedPair(3854)
    const proxy = await client.proxy<TestRpc>('testRpc')

    for (const wrong of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const failure = await t.throwsAsync(proxy.$with({ timeoutMs: wrong }).square(2))
        t.regex(String(failure?.message), /finite non-negative integer/, `timeoutMs ${wrong} was not refused`)
    }

    await dispose()
})

test('removing one event handler does not unsubscribe the others', async (t) => {
    const { server, client, eventing, dispose } = await isolatedPair(3855)
    const proxy = await client.proxy<EventingRpc>('eventing')

    const first: string[] = []
    const second: string[] = []
    const firstHandler = (value: string) => void first.push(value)
    const secondHandler = (value: string) => void second.push(value)
    await proxy.on('ping', firstHandler)
    await proxy.on('ping', secondHandler)

    eventing.fire('a')
    await waitFor(() => first.includes('a') && second.includes('a'))
    t.is(server.rpc.eventProxies.size, 1, 'two local handlers should share one remote subscription')

    // The fix under test: this used to send the remote off, taking the feed away from the handler
    // that was still listening.
    await proxy.off('ping', firstHandler)
    t.is(server.rpc.eventProxies.size, 1, 'the remote subscription left with the first local handler')
    eventing.fire('b')
    await waitFor(() => second.includes('b'))
    t.false(first.includes('b'), 'a removed handler still received the event')

    await proxy.off('ping', secondHandler)
    t.is(server.rpc.eventProxies.size, 0, 'the last local handler leaving should end the remote subscription')
    eventing.fire('c')
    await new Promise((resolve) => setTimeout(resolve, 100))
    t.false(second.includes('c'), 'an unsubscribed handler received an event')

    await dispose()
})

test('a client hears peers arriving and leaving, not just its own link', async (t) => {
    // What separates a stale view of one device from a dead network: peerGone names the device,
    // disconnected names the link. peerDisplaced rides the same forwarding loop.
    const server = new RpcServer({ transports: [{ port: 3856 }] })
    await server.ready()

    const observer = new RpcClient('http://localhost:3856', { name: 'observer-3856' })
    await observer.ready()
    const online: string[] = []
    const gone: string[] = []
    observer.on(TransportEvent.peerOnline, (peer: string) => void online.push(peer))
    observer.on(TransportEvent.peerGone, (peer: string) => void gone.push(peer))

    const visitor = new RpcClient('http://localhost:3856', { name: 'visitor-3856' })
    await visitor.ready()
    await waitFor(() => online.includes('visitor-3856'))
    t.true(online.includes('visitor-3856'))

    await visitor.close()
    await waitFor(() => gone.includes('visitor-3856'))
    t.true(gone.includes('visitor-3856'))

    await observer.close()
    await server.close()
})
