import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { connectAsync } from 'mqtt'
import { rpc, rpcNamespace, RpcClient, RpcSchema, RpcServer, type ServerDescription, type TypeNode } from '@source-repo/rpc'
import { consoleIdentityPath, startConsole, type ConsoleService } from './console.js'

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

/**
 * Test peers get a short session expiry. Names are unique per run, so the broker's hour-long default
 * would leave a fresh session behind on every run until it refused new connections.
 */
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

/**
 * Unique per run: a peer name is the MQTT client id, so a second run sharing one has the broker
 * resume the first run's session and hand it whatever that session still had queued. Prefixes go
 * the same way, since presence under them is retained.
 */
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
    const { name } = (await (await fetch(`${url}${consoleIdentityPath}`)).json()) as { name: string }
    const client = new RpcClient(url, { defaultTarget: name, callTimeout: 8000, readyTimeout: 8000 })
    const proxy = await client.proxy<ConsoleService & { on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown> }>('console')
    return { client, remote: proxy.remote }
}

test('the console discovers a peer, describes it, calls it and streams its events over Source RPC', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }
    const prefix = prefixFor('console-test')
    const server = new RpcServer({
        name: peer('boilerServer'),
        transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }],
        schema,
        exposeIntrospection: true
    })
    server.exposeClassInstance(new Boiler())
    await server.ready()

    const running = await startConsole({ broker: BROKER_URL, prefix, port: 7391, host: '127.0.0.1', name: peer('console-test'), callTimeout: 5000 })
    const { client, remote } = await browserClient(running.url)

    // Discovery comes from retained presence, so nothing probes and nothing is configured.
    const peers = await pollUntil(
        async () => (await remote.peers()).peers,
        (found) => found.includes(peer('boilerServer'))
    )
    t.true(peers.includes(peer('boilerServer')), `discovered peers: ${JSON.stringify(peers)}`)

    // Describe reports what the server exposes, with types from the schema.
    const described = (await remote.describe(peer('boilerServer'))) as {
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
    t.deepEqual(await remote.watch(peer('boilerServer'), 'boiler', 'changed'), { watching: true, already: false })

    const called = await remote.call(peer('boilerServer'), 'boiler', 'setTemperature', [90])
    t.is(called.result, 90)
    t.is(typeof called.ms, 'number')

    await waitFor(() => streamed.length > 0)
    t.is(streamed[0].event, 'changed')
    t.deepEqual(streamed[0].args, [90])
    t.is(streamed[0].peer, peer('boilerServer'))

    // A refused call comes back with its code rather than as a transport failure.
    const refused = await remote.call(peer('boilerServer'), 'boiler', 'setTemperature', [500])
    t.is(refused.code, 'InvalidParams')
    t.regex(String(refused.error), /above the maximum 120/)

    // Unwatching has to stop the events, not merely change a label.
    t.deepEqual(await remote.unwatch(peer('boilerServer'), 'boiler', 'changed'), { watching: false, already: false })
    t.deepEqual((await remote.peers()).watching, [])
    // The server drops its side too, rather than emitting into a listener nobody reads.
    t.is(server.rpc.eventProxies.size, 0, 'the server kept a subscription after unwatch')

    const before = streamed.length
    await remote.call(peer('boilerServer'), 'boiler', 'setTemperature', [70])
    await new Promise((resolve) => setTimeout(resolve, 500))
    t.is(streamed.length, before, 'an event arrived after unwatching')

    // Unwatching twice is not an error, and watching again works.
    t.deepEqual(await remote.unwatch(peer('boilerServer'), 'boiler', 'changed'), { watching: false, already: true })
    t.deepEqual(await remote.watch(peer('boilerServer'), 'boiler', 'changed'), { watching: true, already: false })
    await remote.call(peer('boilerServer'), 'boiler', 'setTemperature', [80])
    await waitFor(() => streamed.length > before)
    t.deepEqual(streamed[streamed.length - 1].args, [80])

    await client.close()
    await running.close()
    await server.close()
})

test('the console watches a socket.io network, with no broker anywhere', async (t) => {
    // Nothing here touches MQTT, so it runs whether or not a broker is up.
    const hub = new RpcServer({ name: peer('hub'), transports: [{ port: 3990 }] })
    await hub.ready()

    // A peer that can only dial out - what a server hosted in a browser page has to do.
    const panel = new RpcServer({ name: peer('cellPanel'), transports: [{ connect: 'http://localhost:3990' }], exposeIntrospection: true })
    panel.exposeClassInstance(new Boiler())
    await panel.ready()

    const running = await startConsole({ hub: 'http://localhost:3990', port: 7393, host: '127.0.0.1', name: peer('console-hub'), callTimeout: 5000 })
    const { client, remote } = await browserClient(running.url)

    const peers = await pollUntil(
        async () => (await remote.peers()).peers,
        (found) => found.includes(peer('cellPanel'))
    )
    t.true(peers.includes(peer('cellPanel')), `discovered: ${JSON.stringify(peers)}`)

    const described = (await remote.describe(peer('cellPanel'))) as { namespaces: { name: string }[] }
    t.true(described.namespaces.some((namespace) => namespace.name === 'boiler'))

    const streamed: { event: string; args: unknown[] }[] = []
    await remote.on('event', (event: unknown) => void streamed.push(event as (typeof streamed)[number]))
    t.deepEqual(await remote.watch(peer('cellPanel'), 'boiler', 'changed'), { watching: true, already: false })
    t.is((await remote.call(peer('cellPanel'), 'boiler', 'setTemperature', [64])).result, 64)
    await waitFor(() => streamed.length > 0)
    t.deepEqual(streamed[0].args, [64])

    await client.close()
    await running.close()
    await panel.close()
    await hub.close()
})

test('the console describes its own service with argument types', async (t) => {
    // The console's contract is the one the type language could not describe until `record` existed:
    // describe() returns a ServerDescription, which is built out of dictionaries of TypeNode. This
    // is the whole chain - extract wrote the file, the server loaded it, a peer reads it back.
    const hub = new RpcServer({ name: peer('hub-self'), transports: [{ port: 3991 }] })
    await hub.ready()
    const running = await startConsole({ hub: 'http://localhost:3991', port: 7395, host: '127.0.0.1', name: peer('console-self'), callTimeout: 5000 })

    const onlooker = new RpcServer({ name: peer('onlooker'), transports: [{ connect: 'http://localhost:3991' }] })
    await onlooker.ready()
    // ready() means the link is up, not that presence has arrived. Addressing a peer the registry
    // has not heard of yet is what made this the flakiest test in the suite.
    await waitFor(() => onlooker.peers.names().includes(peer('console-self')))
    const introspection = await onlooker.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', peer('console-self'))
    const description = await introspection.remote.describe()

    const service = description.namespaces.find((namespace) => namespace.name === 'console')
    t.true(description.validating, 'the console should be checking its own arguments')
    const call = service?.methods.find((method) => method.name === 'call')
    t.deepEqual(call?.paramNames, ['peer', 'namespace', 'method', 'args'], 'a form needs labels, not "argument 0"')
    t.deepEqual(call?.params?.[0], { kind: 'string' })

    // The dictionary that blocked all of this: ServerDescription.types is { [name]: TypeNode }.
    const describe = service?.methods.find((method) => method.name === 'describe')
    const returned = describe?.returns
    const described = returned?.kind === 'union' ? returned.options.find((option) => option.kind === 'ref') : returned
    t.is(described?.kind === 'ref' ? described.name : undefined, 'ServerDescription')
    t.deepEqual((description.types?.ServerDescription as { kind: 'object'; fields: { [name: string]: { type: TypeNode } } }).fields.types.type, {
        kind: 'record',
        values: { kind: 'ref', name: 'TypeNode' }
    })

    await onlooker.close()
    await running.close()
    await hub.close()
})

test('the console refuses to start with nothing to watch', async (t) => {
    await t.throwsAsync(startConsole({ port: 7394, host: '127.0.0.1', name: peer('console-nothing'), callTimeout: 1000 }), {
        message: /broker, a hub, or both/
    })
})

test('the console app is served and needs no network to render', async (t) => {
    if (t.context.skipped) {
        t.pass('no broker - skipped')
        return
    }
    const running = await startConsole({ broker: BROKER_URL, prefix: prefixFor('console-page'), port: 7392, host: '127.0.0.1', name: peer('console-page'), callTimeout: 2000 })
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
