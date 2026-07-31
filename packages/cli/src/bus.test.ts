import test from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { rpc, rpcNamespace, RpcServer } from '@source-repo/rpc'
import { startBroker } from './broker.js'
import type { TappedFrame } from './bus.js'

/**
 * The tap sees traffic between two other peers, which is the whole point: nothing here calls the
 * broker except to turn it on, and everything it reports is somebody else's conversation.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

@rpcNamespace('boiler')
class Boiler extends EventEmitter {
    @rpc
    async setTemperature(celsius: number) {
        this.emit('changed', celsius)
        return celsius
    }

    @rpc
    async fault() {
        throw new Error('the burner is locked out')
    }
}

interface Bus {
    tap(filter?: unknown): Promise<{ token: string; expires: number }>
    untap(token: string): Promise<{ tapping: boolean; already: boolean }>
    taps(): Promise<{ bus: string; taps: { token: string; frames: number }[]; pending: number }>
    on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
    off(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
}

let port = 8110
/** A broker, a device on it, a caller on it, and a third peer watching them talk. */
const withBus = async (body: (context: { device: string; caller: RpcServer; bus: Bus; frames: TappedFrame[] }) => Promise<void>) => {
    const busPort = port++
    const busName = peer(`bus${busPort}`)
    const broker = await startBroker({ port: busPort, name: busName })
    const url = `http://localhost:${busPort}`

    const device = peer(`boiler${busPort}`)
    const server = new RpcServer({ name: device, transports: [{ connect: url }], exposeIntrospection: true })
    server.exposeClassInstance(new Boiler())
    await server.ready()

    const caller = new RpcServer({ name: peer(`hmi${busPort}`), transports: [{ connect: url }], callTimeout: 5000 })
    await caller.ready()

    const onlooker = new RpcServer({ name: peer(`watcher${busPort}`), transports: [{ connect: url }], callTimeout: 5000 })
    await onlooker.ready()
    await waitFor(() => onlooker.peers.names().includes(busName) && caller.peers.names().includes(device))

    const frames: TappedFrame[] = []
    const bus = (await onlooker.proxy<Bus>('bus', busName))
    await bus.on('frame', (frame: unknown) => void frames.push(frame as TappedFrame))

    try {
        await body({ device, caller, bus, frames })
    } finally {
        await onlooker.close()
        await caller.close()
        await server.close()
        await broker.close()
    }
}

test('a tap started while the broker runs sees a call it was not part of, and pairs the reply', async (t) => {
    await withBus(async ({ device, caller, bus, frames }) => {
        // Nothing is reported before anyone asks: the tap is off until it is turned on.
        const boiler = (await caller.proxy<Boiler>('boiler', device))
        t.is(await boiler.setTemperature(60), 60)
        await new Promise((resolve) => setTimeout(resolve, 300))
        t.deepEqual(frames, [], 'the broker reported traffic before anything tapped')

        const { token } = await bus.tap()
        t.regex(token, /^tap-/)

        t.is(await boiler.setTemperature(90), 90)
        await waitFor(() => frames.some((frame) => frame.kind === 'SUCCESS'))

        const call = frames.find((frame) => frame.kind === 'POST')
        t.truthy(call, `frames: ${JSON.stringify(frames)}`)
        t.is(call!.namespace, 'boiler')
        t.is(call!.method, 'setTemperature')
        t.is(call!.target, device)
        // Off by default, so a bus carrying real values does not hand them to whoever tapped.
        t.is(call!.params, undefined)
        t.deepEqual(call!.taps, [token])

        // The reply carries neither the method nor a duration; both are filled in from the call.
        const reply = frames.find((frame) => frame.kind === 'SUCCESS')!
        t.is(reply.id, call!.id)
        t.is(reply.method, 'setTemperature')
        t.is(reply.namespace, 'boiler')
        t.is(typeof reply.ms, 'number')
        t.true(reply.ms! >= 0 && reply.ms! < 5000)
        t.is(reply.source, device, 'a reply travels back from the device')
    })
})

test('a refused call is reported with its code, and payloads arrive only when asked for', async (t) => {
    await withBus(async ({ device, caller, bus, frames }) => {
        await bus.tap({ payloads: true })
        const boiler = (await caller.proxy<Boiler>('boiler', device))

        await boiler.setTemperature(72)
        await waitFor(() => frames.some((frame) => frame.kind === 'POST'))
        t.deepEqual(frames.find((frame) => frame.kind === 'POST')!.params, [72])

        await t.throwsAsync(boiler.fault())
        await waitFor(() => frames.some((frame) => frame.kind === 'ERROR'))
        const failure = frames.find((frame) => frame.kind === 'ERROR')!
        t.is(failure.code, 'Exception')
        t.regex(String(failure.error), /locked out/)
        t.is(failure.method, 'fault', 'an error should be paired with the call it refuses')
    })
})

test('a filter narrows to one peer, and untap stops the stream', async (t) => {
    await withBus(async ({ device, caller, bus, frames }) => {
        const { token } = await bus.tap({ peer: 'nobody-at-all' })
        const boiler = (await caller.proxy<Boiler>('boiler', device))
        await boiler.setTemperature(50)
        await new Promise((resolve) => setTimeout(resolve, 300))
        t.deepEqual(frames, [], 'a filter for another peer still matched')

        // Now one that does match, in both directions: the device is the target of the call and the
        // source of the reply.
        await bus.untap(token)
        const mine = await bus.tap({ peer: device })
        await boiler.setTemperature(51)
        await waitFor(() => frames.length >= 2)
        t.true(frames.every((frame) => frame.source === device || frame.target === device))

        const counted = await bus.taps()
        t.is(counted.taps.length, 1)
        t.is(counted.taps[0].token, mine.token)
        t.true(counted.taps[0].frames >= 2)

        t.deepEqual(await bus.untap(mine.token), { tapping: false, already: false })
        // Untapping twice is not an error, the way unwatch is not.
        t.deepEqual(await bus.untap(mine.token), { tapping: false, already: true })

        const before = frames.length
        await boiler.setTemperature(52)
        await new Promise((resolve) => setTimeout(resolve, 300))
        t.is(frames.length, before, 'frames arrived after untapping')
        t.is((await bus.taps()).pending, 0, 'the pending calls should be dropped with the last tap')
    })
})

test('an event crossing the broker is reported as one', async (t) => {
    await withBus(async ({ device, caller, bus, frames }) => {
        await bus.tap({ kinds: ['EVENT'], payloads: true })
        const boiler = (await caller.proxy<Boiler & { on: (e: string, h: (...a: unknown[]) => void) => Promise<unknown> }>('boiler', device))
        await boiler.on('changed', () => undefined)
        await boiler.setTemperature(77)

        await waitFor(() => frames.length > 0)
        // The filter admitted only events, so the call and its reply are not here.
        t.true(
            frames.every((frame) => frame.kind === 'EVENT'),
            `frames: ${JSON.stringify(frames)}`
        )
        t.is(frames[0].event, 'changed')
        t.deepEqual(frames[0].params, [77])
        t.is(frames[0].source, device)
    })
})

test('a tap expires on its own, so a console that walks away does not leave one running', async (t) => {
    await withBus(async ({ device, caller, bus, frames }) => {
        await bus.tap({ ttl: 1 })
        const boiler = (await caller.proxy<Boiler>('boiler', device))
        await boiler.setTemperature(30)
        await waitFor(() => frames.length > 0)

        await new Promise((resolve) => setTimeout(resolve, 1100))
        t.deepEqual((await bus.taps()).taps, [])

        const before = frames.length
        await boiler.setTemperature(31)
        await new Promise((resolve) => setTimeout(resolve, 300))
        t.is(frames.length, before, 'an expired tap was still reporting')
    })
})

test('the broker describes itself, so it does not look like a device with introspection off', async (t) => {
    await withBus(async ({ bus }) => {
        const described = await bus.taps()
        t.truthy(described.bus)
    })
    // The describe path is what the console and `source-rpc describe` use.
    const busPort = port++
    const busName = peer(`described${busPort}`)
    const broker = await startBroker({ port: busPort, name: busName })
    const onlooker = new RpcServer({ name: peer(`asks${busPort}`), transports: [{ connect: `http://localhost:${busPort}` }], callTimeout: 5000 })
    await onlooker.ready()
    await waitFor(() => onlooker.peers.names().includes(busName))

    const introspection = await onlooker.proxy<{ describe(): Promise<{ namespaces: { name: string; methods: { name: string; paramNames?: string[] }[] }[] }> }>('msgrpc', busName)
    const description = await introspection.describe()
    const namespace = description.namespaces.find((entry) => entry.name === 'bus')
    t.truthy(namespace, `namespaces: ${JSON.stringify(description.namespaces.map((entry) => entry.name))}`)
    // The contract has to reach a console as argument names, or the form says `tap(…)`.
    t.deepEqual(namespace!.methods.find((method) => method.name === 'tap')?.paramNames, ['filter'])

    await onlooker.close()
    await broker.close()
})

test('an unknown kind in a filter is refused rather than silently matching nothing', async (t) => {
    await withBus(async ({ bus }) => {
        await t.throwsAsync(bus.tap({ kinds: ['NONSENSE'] }), { message: /unknown kind/ })
    })
})
