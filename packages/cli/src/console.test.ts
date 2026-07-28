import anyTest, { TestFn } from 'ava'
import { EventEmitter } from 'events'
import { connectAsync } from 'mqtt'
import { rpc, rpcNamespace, RpcSchema, RpcServer } from '@source-repo/msgrpc'
import { startConsole } from './console.js'

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

/** Polls an endpoint until it answers what the test is waiting for, then returns whatever it last saw. */
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

test('the console discovers a peer, describes it, calls it and streams its events', async (t) => {
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
    const get = async (path: string) => (await fetch(`${running.url}${path}`)).json() as Promise<Record<string, unknown>>
    const post = async (path: string, body: unknown) =>
        (await fetch(`${running.url}${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>

    // Discovery comes from retained presence, so nothing probes and nothing is configured.
    const peers = await pollUntil(
        async () => ((await get('/api/peers')).peers as string[]) ?? [],
        (found) => found.includes('boilerServer')
    )
    t.true(peers.includes('boilerServer'), `discovered peers: ${JSON.stringify(peers)}`)

    // Describe reports what the server exposes, with types from the schema.
    const described = (await get('/api/describe?peer=boilerServer')) as unknown as {
        namespaces: { name: string; methods: { name: string; params?: unknown[] }[]; events: { name: string }[] }[]
    }
    const boiler = described.namespaces.find((namespace) => namespace.name === 'boiler')
    t.truthy(boiler, `namespaces: ${JSON.stringify(described.namespaces?.map((n) => n.name))}`)
    t.deepEqual(
        boiler!.methods.map((method) => method.name),
        ['setTemperature']
    )
    t.deepEqual(boiler!.methods[0].params, [{ kind: 'number', max: 120 }])

    // Subscribe before calling, so the event the call emits is streamed.
    const streamed: unknown[] = []
    const stream = await fetch(`${running.url}/api/events`)
    const reader = stream.body!.getReader()
    void (async () => {
        const decoder = new TextDecoder()
        for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            const text = decoder.decode(value)
            if (text.includes('event: event')) streamed.push(text)
        }
    })()
    t.deepEqual(await post('/api/watch', { peer: 'boilerServer', namespace: 'boiler', event: 'changed' }), { already: false })

    const called = await post('/api/call', { peer: 'boilerServer', namespace: 'boiler', method: 'setTemperature', args: [90] })
    t.is(called.result, 90)
    t.is(typeof called.ms, 'number')

    await waitFor(() => streamed.length > 0)
    t.regex(String(streamed[0]), /"event":"changed"/)
    t.regex(String(streamed[0]), /\[90\]/)

    // A refused call comes back with its code rather than as a transport failure.
    const refused = await post('/api/call', { peer: 'boilerServer', namespace: 'boiler', method: 'setTemperature', args: [500] })
    t.is(refused.code, 'InvalidParams')
    t.regex(String(refused.error), /above the maximum 120/)

    await reader.cancel().catch(() => {})
    await running.close()
    await server.close()
})

test('the console page is served and needs no network to render', async (t) => {
    if (t.context.skipped) {
        t.pass('no broker - skipped')
        return
    }
    const running = await startConsole({ broker: BROKER_URL, prefix: 'msgrpc/console-page', port: 7392, host: '127.0.0.1', name: 'console-page', callTimeout: 2000 })
    const html = await (await fetch(running.url)).text()

    t.regex(html, /<title>msgrpc console<\/title>/)
    // Self-contained: nothing to fetch from a CDN on a plant network with no route to the internet.
    t.false(/src="http/.test(html), 'the page should not load anything remote')
    t.false(/href="http/.test(html), 'the page should not load anything remote')

    await running.close()
})
