import anyTest, { TestFn } from 'ava'
import { EventEmitter } from 'events'
import { connectAsync } from 'mqtt'
import { rpc, rpcNamespace, RpcClient, RpcSchema, RpcServer } from '@source-repo/msgrpc'
import { consolePeer, startConsole, type ConsoleService } from './console.js'

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

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
    t.context = { skipped: !(await brokerAvailable()) }
})

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

/** Polls a call until it answers what the test is waiting for, then returns whatever it last saw. */
const pollUntil = async <T>(fetcher: () => Promise<T>, satisfied: (value: T) => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    for (;;) {
        const value = await fetcher()
        if (satisfied(value) || Date.now() > deadline) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

@rpcNamespace('boiler', { version: '1' })
class Boiler extends EventEmitter {
    @rpc
    async setTemperature(celsius: number) {
        this.emit('changed', celsius)
        return celsius
    }
}

const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        boiler: { version: '1', methods: { setTemperature: { params: [{ kind: 'number', max: 120 }], returns: { kind: 'number' } } }, events: { changed: { params: [{ kind: 'number' }] } } }
    }
}

/** Connects the way the app does: an ordinary msgrpc client over the origin that served the page. */
const browserClient = async (url: string) => {
    const client = new RpcClient(url, { defaultTarget: consolePeer, callTimeout: 8000, readyTimeout: 8000 })
    const proxy = await client.proxy<ConsoleService & { on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown> }>('console')
    return { client, remote: proxy.remote! }
}

test('the console discovers a peer, describes it, calls it and streams its events over msgrpc', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }
    const prefix = 'msgrpc/console-test'
    const server = new RpcServer({
        name: 'boilerServer',
        transports: [{ brokerurl: BROKER_URL, prefix }],
        schema,
        exposeIntrospection: true
    })
    server.exposeClassInstance(new Boiler())
    await server.ready()

    const running = await startConsole({ broker: BROKER_URL, prefix, port: 7391, host: '127.0.0.1', name: 'console-test', callTimeout: 5000 })
    const { client, remote } = await browserClient(running.url)

    // Discovery comes from retained presence, so nothing probes and nothing is configured.
    const peers = await pollUntil(
        async () => (await remote.peers()).peers,
        (found) => found.includes('boilerServer')
    )
    t.true(peers.includes('boilerServer'), `discovered peers: ${JSON.stringify(peers)}`)

    // Describe reports what the server exposes, with types from the schema.
    const described = (await remote.describe('boilerServer')) as {
        namespaces: { name: string; methods: { name: string; params?: unknown[]; paramNames?: string[] }[] }[]
    }
    const boiler = described.namespaces.find((namespace) => namespace.name === 'boiler')
    t.truthy(boiler, `namespaces: ${JSON.stringify(described.namespaces?.map((n) => n.name))}`)
    t.deepEqual(
        boiler!.methods.map((method) => method.name),
        ['setTemperature']
    )
    t.deepEqual(boiler!.methods[0].params, [{ kind: 'number', max: 120 }])

    // Subscribe before calling, so the event the call emits reaches the browser.
    const streamed: { peer: string; namespace: string; event: string; args: unknown[] }[] = []
    await remote.on('event', (event: unknown) => void streamed.push(event as (typeof streamed)[number]))
    t.deepEqual(await remote.watch('boilerServer', 'boiler', 'changed'), { watching: true, already: false })

    const called = await remote.call('boilerServer', 'boiler', 'setTemperature', [90])
    t.is(called.result, 90)
    t.is(typeof called.ms, 'number')

    await waitFor(() => streamed.length > 0)
    t.is(streamed[0].event, 'changed')
    t.deepEqual(streamed[0].args, [90])
    t.is(streamed[0].peer, 'boilerServer')

    // A refused call comes back with its code rather than as a transport failure.
    const refused = await remote.call('boilerServer', 'boiler', 'setTemperature', [500])
    t.is(refused.code, 'InvalidParams')
    t.regex(String(refused.error), /above the maximum 120/)

    // Unwatching has to stop the events, not merely change a label.
    t.deepEqual(await remote.unwatch('boilerServer', 'boiler', 'changed'), { watching: false, already: false })
    t.deepEqual((await remote.peers()).watching, [])
    // The server drops its side too, rather than emitting into a listener nobody reads.
    t.is(server.rpc.eventProxies.size, 0, 'the server kept a subscription after unwatch')

    const before = streamed.length
    await remote.call('boilerServer', 'boiler', 'setTemperature', [70])
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.is(streamed.length, before, 'an event arrived after unwatching')

    // Unwatching twice is not an error, and watching again works.
    t.deepEqual(await remote.unwatch('boilerServer', 'boiler', 'changed'), { watching: false, already: true })
    t.deepEqual(await remote.watch('boilerServer', 'boiler', 'changed'), { watching: true, already: false })
    await remote.call('boilerServer', 'boiler', 'setTemperature', [80])
    await waitFor(() => streamed.length > before)
    t.deepEqual(streamed[streamed.length - 1].args, [80])

    await client.close()
    await running.close()
    await server.close()
})

test('the console app is served and needs no network to render', async (t) => {
    if (t.context.skipped) {
        t.pass('no broker - skipped')
        return
    }
    const running = await startConsole({ broker: BROKER_URL, prefix: 'msgrpc/console-page', port: 7392, host: '127.0.0.1', name: 'console-page', callTimeout: 2000 })
    const html = await (await fetch(running.url)).text()

    t.regex(html, /<title>msgrpc console<\/title>/)
    // Self-contained: nothing to fetch from a CDN on a plant network with no route to the internet.
    t.false(/(src|href)="(https?:)?\/\//.test(html), 'the page should not load anything remote')

    // The script and stylesheet it names are served from the same place, so the page actually runs.
    for (const asset of [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1])) {
        const response = await fetch(`${running.url}/${asset}`)
        t.is(response.status, 200, `${asset} was not served`)
    }

    // An unknown path is a client-side route, not a 404, and it must not escape the asset directory.
    t.is((await fetch(`${running.url}/peers/boilerServer`)).status, 200)
    const traversal = await fetch(`${running.url}/..%2f..%2fpackage.json`)
    t.regex(await traversal.text(), /<title>msgrpc console<\/title>/, 'a traversal served a file from outside the app')

    await running.close()
})
