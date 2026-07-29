import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { connectAsync } from 'mqtt'
import { rpc, rpcNamespace, RpcClient, RpcServer } from '@source-repo/rpc'
import { consoleIdentityPath, startConsole } from './console.js'
import type { TappedFrame } from './bus.js'

/**
 * The MQTT half of the tap. There is no broker of ours on an MQTT network to hook, so the console
 * subscribes to every peer's topic itself - and this is the test that it sees a conversation it is
 * not part of, on a second connection that never delivers anything.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
const TEST_SESSION_EXPIRY = 10

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>
test.before(async (t) => {
    const available = await brokerAvailable()
    // Skipping is right on a laptop with no broker and wrong everywhere it matters: a suite that
    // reports itself green having quietly run none of its MQTT tests is worse than one that fails,
    // because it is the version somebody trusts. CI sets this, so the skip cannot happen unnoticed.
    if (!available && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
    t.context = { skipped: !available }
})

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const prefixFor = (name: string) => `msgrpc/${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

@rpcNamespace('boiler')
class Boiler extends EventEmitter {
    calls = 0
    @rpc
    async setTemperature(celsius: number) {
        this.calls++
        return celsius
    }
}

interface ConsoleTapService {
    tap(filter?: unknown): Promise<{ token: string; sources: string[] }>
    untap(token: string): Promise<{ tapping: boolean; already: boolean }>
    taps(): Promise<{ taps: { token: string; sources: string[] }[]; sources: string[] }>
    peers(): Promise<{ peers: string[] }>
    on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
}

test('the console taps an MQTT network and sees a call between two other peers', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }
    const prefix = prefixFor('tap-test')
    const device = peer('boilerServer')
    const boiler = new Boiler()
    const server = new RpcServer({
        name: device,
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }],
        exposeIntrospection: true
    })
    server.exposeClassInstance(boiler)
    await server.ready()

    const hmi = new RpcServer({ name: peer('hmi'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }], callTimeout: 6000 })
    await hmi.ready()

    const running = await startConsole({ broker: BROKER_URL, prefix, port: 7396, host: '127.0.0.1', name: peer('console-tap'), callTimeout: 6000 })
    const { name } = (await (await fetch(`${running.url}${consoleIdentityPath}`)).json()) as { name: string }
    const page = new RpcClient(running.url, { defaultTarget: name, callTimeout: 8000, readyTimeout: 8000 })
    const console_ = (await page.proxy<ConsoleTapService>('console')).remote!

    const frames: TappedFrame[] = []
    await console_.on('frame', (frame: unknown) => void frames.push(frame as TappedFrame))

    const plant = (await hmi.proxy<Boiler>('boiler', device)).remote!
    // Nothing is subscribed before anyone asks, so this conversation goes unseen.
    t.is(await plant.setTemperature(40), 40)
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.deepEqual(frames, [], 'traffic was reported before anything tapped')

    const started = await console_.tap({ payloads: true })
    t.deepEqual(started.sources, ['this console'], 'an MQTT console taps itself, having no broker to ask')
    // The tap opens a second broker connection; give it a moment to subscribe.
    await new Promise((resolve) => setTimeout(resolve, 600))

    t.is(await plant.setTemperature(95), 95)
    await waitFor(() => frames.some((frame) => frame.kind === 'POST' && frame.namespace === 'boiler') && frames.some((frame) => frame.kind === 'SUCCESS'))

    const call = frames.find((frame) => frame.kind === 'POST' && frame.namespace === 'boiler')
    t.truthy(call, `frames: ${JSON.stringify(frames)}`)
    t.is(call!.namespace, 'boiler')
    t.is(call!.method, 'setTemperature')
    t.is(call!.source, peer('hmi'))
    t.is(call!.target, device)
    t.deepEqual(call!.params, [95])

    const reply = frames.find((frame) => frame.kind === 'SUCCESS' && frame.id === call!.id)!
    t.is(reply.id, call!.id)
    t.is(reply.method, 'setTemperature', 'a reply carries no method; it comes from the paired call')
    t.is(typeof reply.ms, 'number')

    // The whole reason the tap gets its own connection: a wildcard subscription added to the
    // console's own would overlap, and a broker may deliver once per matching subscription - which
    // for a request means running the method twice.
    t.is(boiler.calls, 2, 'the device ran a method more than once per call')

    // Untapping closes the second connection, and the traffic goes unseen again.
    t.deepEqual(await console_.untap(started.token), { tapping: false, already: false })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = frames.length
    await plant.setTemperature(41)
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.is(frames.length, before, 'frames arrived after untapping')
    t.is(boiler.calls, 3)

    await page.close()
    await running.close()
    await hmi.close()
    await server.close()
})

test('a filter on an MQTT tap narrows to one peer', async (t) => {
    if (t.context.skipped) {
        t.pass('no broker - skipped')
        return
    }
    const prefix = prefixFor('tap-filter')
    const device = peer('kiln')
    const server = new RpcServer({ name: device, transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    server.exposeClassInstance(new Boiler())
    await server.ready()

    const hmi = new RpcServer({ name: peer('panel'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }], callTimeout: 6000 })
    await hmi.ready()

    const running = await startConsole({ broker: BROKER_URL, prefix, port: 7397, host: '127.0.0.1', name: peer('console-filter'), callTimeout: 6000 })
    const { name } = (await (await fetch(`${running.url}${consoleIdentityPath}`)).json()) as { name: string }
    const page = new RpcClient(running.url, { defaultTarget: name, callTimeout: 8000, readyTimeout: 8000 })
    const console_ = (await page.proxy<ConsoleTapService>('console')).remote!

    const frames: TappedFrame[] = []
    await console_.on('frame', (frame: unknown) => void frames.push(frame as TappedFrame))

    await console_.tap({ peer: 'somebody-else' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const plant = (await hmi.proxy<Boiler>('boiler', device)).remote!
    await plant.setTemperature(20)
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.deepEqual(frames, [], 'a filter for another peer still matched')

    // taps() reports where this console can watch, which on MQTT is itself.
    t.deepEqual((await console_.taps()).sources, ['this console'])

    await page.close()
    await running.close()
    await hmi.close()
    await server.close()
})
