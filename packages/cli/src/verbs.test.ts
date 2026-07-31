import test from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { rpc, rpcNamespace, RpcSchema, RpcServer } from '@source-repo/rpc'
import { coerceArgument, runCall, runDescribe, runFind, runPeers, runWatch, signatureOf, type VerbOptions } from './verbs.js'

/** Nothing here touches MQTT: a socket.io hub exercises the same verbs and runs everywhere. */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

@rpcNamespace('boiler', { version: '1' })
class Boiler extends EventEmitter {
    @rpc
    async setTemperature(celsius: number, mode?: 'auto' | 'manual') {
        this.emit('changed', celsius, mode ?? 'auto')
        return { celsius, mode: mode ?? 'auto' }
    }

    @rpc
    async fault() {
        throw new Error('the burner is locked out')
    }
}

const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        boiler: {
            version: '1',
            methods: {
                setTemperature: {
                    params: [
                        { kind: 'number', max: 120 },
                        { kind: 'union', options: [{ kind: 'literal', value: 'auto' }, { kind: 'literal', value: 'manual' }, { kind: 'literal', value: null }] }
                    ],
                    paramNames: ['celsius', 'mode'],
                    returns: { kind: 'object', fields: { celsius: { type: { kind: 'number' } }, mode: { type: { kind: 'string' } } } }
                },
                fault: { params: [] }
            },
            events: { changed: { params: [{ kind: 'number' }, { kind: 'string' }] } },
            // As extract writes them: the subinterface implemented, its parent closed in.
            capabilities: ['@fixture/contracts/AdvancedRenderer', '@fixture/contracts/Renderer']
        }
    }
}

/** Collects what a verb printed, so a test can assert on the output a person or `jq` would see. */
const collect = () => {
    const out: string[] = []
    const err: string[] = []
    return { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text), stdout: () => out.join(''), stderr: () => err.join('') }
}

let port = 3960
const withHub = async (body: (options: (extra?: Partial<VerbOptions>) => VerbOptions, device: string) => Promise<void>) => {
    const hubPort = port++
    const hub = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await hub.ready()
    const device = peer(`boiler${hubPort}`)
    const server = new RpcServer({ name: device, transports: [{ connect: `http://localhost:${hubPort}` }], schema, exposeIntrospection: true })
    server.exposeClassInstance(new Boiler())
    await server.ready()
    try {
        await body(
            (extra) => ({ hub: `http://localhost:${hubPort}`, name: peer(`cli${hubPort}-${Math.random().toString(36).slice(2, 6)}`), callTimeout: 5000, json: true, wait: 6000, ...extra }),
            device
        )
    } finally {
        await server.close()
        await hub.close()
    }
}

test('peers lists what is on the network, and describe reports argument names and types', async (t) => {
    await withHub(async (options, device) => {
        const listed = collect()
        t.is(await runPeers(options(), listed), 0)
        t.true((JSON.parse(listed.stdout()) as { peers: string[] }).peers.includes(device))

        const described = collect()
        t.is(await runDescribe(device, options(), described), 0)
        const boiler = (JSON.parse(described.stdout()) as { namespaces: { name: string; methods: { name: string; paramNames?: string[] }[] }[] }).namespaces.find(
            (namespace) => namespace.name === 'boiler'
        )
        t.deepEqual(boiler?.methods.find((method) => method.name === 'setTemperature')?.paramNames, ['celsius', 'mode'])

        // The human rendering is the one a person reads, so it has to carry the same information.
        const readable = collect()
        t.is(await runDescribe(device, options({ json: false }), readable), 0)
        t.regex(readable.stdout(), /setTemperature\(celsius: number\(\.\.120\), mode\?: "auto" \| "manual"\)/)
        t.regex(readable.stdout(), /event changed\(number, string\)/)
    })
})

test('call coerces its words against the contract, so a shell can send a number', async (t) => {
    await withHub(async (options, device) => {
        const called = collect()
        // Both arguments arrive as strings from a shell. Without the contract the first is "90".
        t.is(await runCall(device, 'boiler.setTemperature', ['90', 'manual'], options(), called), 0)
        t.deepEqual(JSON.parse(called.stdout()) as { result: unknown }, { result: { celsius: 90, mode: 'manual' }, ms: JSON.parse(called.stdout()).ms })

        // An optional argument left off is simply not sent.
        const brief = collect()
        t.is(await runCall(device, 'boiler.setTemperature', ['70'], options(), brief), 0)
        t.deepEqual((JSON.parse(brief.stdout()) as { result: { mode: string } }).result.mode, 'auto')

        // --args is the escape hatch, and it goes through untouched.
        const raw = collect()
        t.is(await runCall(device, 'boiler.setTemperature', [], options({ rawArgs: '[65, "manual"]' } as Partial<VerbOptions>), raw), 0)
        t.is((JSON.parse(raw.stdout()) as { result: { celsius: number } }).result.celsius, 65)
    })
})

test('a refused call exits 1, which is what makes this usable in CI', async (t) => {
    await withHub(async (options, device) => {
        // Refused by the schema: 500 is over the declared maximum.
        const refused = collect()
        t.is(await runCall(device, 'boiler.setTemperature', ['500'], options(), refused), 1)
        t.is((JSON.parse(refused.stdout()) as { code: string }).code, 'InvalidParams')

        // Refused by the method itself.
        const thrown = collect()
        t.is(await runCall(device, 'boiler.fault', [], options({ json: false }), thrown), 1)
        t.regex(thrown.stderr(), /locked out/)

        // A word that cannot be the number the contract asks for is caught before anything is sent,
        // and the argument is named rather than numbered.
        const wrong = collect()
        t.is(await runCall(device, 'boiler.setTemperature', ['warm'], options({ json: false }), wrong), 1)
        t.regex(wrong.stderr(), /argument 0 \(celsius\): expected a number/)

        // A peer nobody has announced is a failure with a sentence, not a timeout.
        const absent = collect()
        t.is(await runCall('no-such-peer', 'boiler.setTemperature', ['90'], options({ wait: 300, json: false }), absent), 1)
        t.regex(absent.stderr(), /did not appear within 300 ms/)

        // A target that is not namespace.method is caught before the network is touched.
        const malformed = collect()
        t.is(await runCall(device, 'setTemperature', ['90'], options({ json: false }), malformed), 1)
        t.regex(malformed.stderr(), /should be <namespace>\.<method>/)
    })
})

test('watch streams jsonl and drops the subscription when it stops', async (t) => {
    await withHub(async (options, device) => {
        const streamed = collect()
        let stop = () => {}
        const until = new Promise<void>((resolve) => (stop = resolve))
        const watching = runWatch(device, 'boiler.changed', options(), streamed, until)

        // The subscription has to be in place before the call that emits, or there is nothing to see.
        await new Promise((resolve) => setTimeout(resolve, 400))
        t.is(await runCall(device, 'boiler.setTemperature', ['88'], options(), collect()), 0)
        const deadline = Date.now() + 5000
        while (!streamed.stdout() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))

        const lines = streamed.stdout().trim().split('\n').filter(Boolean)
        t.is(lines.length, 1, `streamed: ${streamed.stdout()}`)
        const event = JSON.parse(lines[0]) as { peer: string; namespace: string; event: string; args: unknown[] }
        t.is(event.peer, device)
        t.is(event.namespace, 'boiler')
        t.is(event.event, 'changed')
        t.deepEqual(event.args, [88, 'auto'])

        stop()
        t.is(await watching, 0)
    })
})

test('a verb with nothing to join says so rather than hanging', async (t) => {
    const nothing = collect()
    t.is(await runPeers({ name: peer('cli-nowhere'), callTimeout: 1000, json: false, wait: 500 }, nothing), 1)
    t.regex(nothing.stderr(), /broker, a hub, or both/)
})

test('an argument is converted by what the contract says it is', (t) => {
    t.is(coerceArgument('1200', { kind: 'number' }, undefined), 1200)
    // A string parameter keeps the text, even when the text looks like something else.
    t.is(coerceArgument('1200', { kind: 'string' }, undefined), '1200')
    t.is(coerceArgument('true', { kind: 'boolean' }, undefined), true)
    t.deepEqual(coerceArgument('{"a":1}', { kind: 'object', fields: { a: { type: { kind: 'number' } } } }, undefined), { a: 1 })
    t.deepEqual(coerceArgument('0x0a1b', { kind: 'bytes' }, undefined), Uint8Array.from([0x0a, 0x1b]))
    t.is((coerceArgument('2024-03-01T10:00:00Z', { kind: 'date' }, undefined) as Date).toISOString(), '2024-03-01T10:00:00.000Z')
    // A named type is followed to what it stands for.
    t.deepEqual(coerceArgument('7', { kind: 'ref', name: 'Celsius' }, { Celsius: { kind: 'number' } }), 7)

    // With no contract: JSON if it parses, the literal text otherwise.
    t.is(coerceArgument('42', undefined, undefined), 42)
    t.is(coerceArgument('hello', undefined, undefined), 'hello')

    t.throws(() => coerceArgument('warm', { kind: 'number' }, undefined), { message: /expected a number/ })
    t.throws(() => coerceArgument('{bad', { kind: 'object', fields: {} }, undefined), { message: /as JSON/ })
})

test('a signature reads the way the source declares it', (t) => {
    t.is(
        signatureOf({
            name: 'setTemperature',
            params: [{ kind: 'number', max: 120 }, { kind: 'union', options: [{ kind: 'literal', value: 'auto' }, { kind: 'literal', value: null }] }],
            paramNames: ['celsius', 'mode'],
            returns: { kind: 'boolean' }
        }),
        'setTemperature(celsius: number(..120), mode?: "auto"): boolean'
    )
    // No schema at all is said plainly rather than guessed at.
    t.is(signatureOf({ name: 'say' }), 'say(…)')
})

test('find answers with who implements a capability, the parent via the closure, and empty honestly', async (t) => {
    await withHub(async (options, device) => {
        // The search is for the *parent* interface; the peer implements the child. The extract-time
        // closure put both names in the schema, so the flat match finds it.
        const io = collect()
        t.is(await runFind('@fixture/contracts/Renderer', options(), io), 0)
        const answer = JSON.parse(io.stdout()) as { matches: { peer: string; namespace: string; version?: string }[] }
        t.is(answer.matches.length, 1)
        t.like(answer.matches[0], { peer: device, namespace: 'boiler', version: '1' })

        // A capability nobody implements - hallucinated or merely absent - is an empty answer,
        // exit 0: absent looks like empty, and an error would teach a caller to retry.
        const nothing = collect()
        t.is(await runFind('@imagined/contracts/Telepathy', options(), nothing), 0)
        t.deepEqual((JSON.parse(nothing.stdout()) as { matches: unknown[] }).matches, [])
    })
})
