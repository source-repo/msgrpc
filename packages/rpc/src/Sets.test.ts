import test from 'ava'
import { randomUUID } from 'crypto'
import { declareRpcNamespace, exposeMethods, rpc, rpcNamespace, RpcClient, RpcComponent, RpcServer } from './index.js'

/**
 * What a method declares it sets.
 *
 * The declaration exists to replace a guess. A consumer can find the method that sets a field by
 * looking for a one-argument `set<Field>`, and that is right almost always - the residue being
 * methods like `setMode`, which may begin a transition with an interlock behind it rather than
 * assign `state.mode`, or `setPressure` sitting beside a measured `state.pressure`. A wrong guess
 * is wrong silently and in the direction of commanding a plant, so the claim is the author's: a
 * method that says nothing offers nothing, however it is named.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

interface Introspection {
    describe(): Promise<{ namespaces: { name: string; methods: { name: string; sets?: string; semantics?: string }[] }[] }>
}

type OvenProps = { unit: string; maximum: number }
type OvenState = { temperature: number; mode: 'idle' | 'heating'; zones: { top: { setpoint: number; temperature: number } } }

@rpcNamespace('oven')
class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: 'C', maximum: 300 }, { temperature: 20, mode: 'idle', zones: { top: { setpoint: 20, temperature: 20 } } })
    }

    @rpc({ semantics: 'idempotent-command', sets: 'mode' })
    async setMode(mode: OvenState['mode']) {
        this.setState({ mode })
        return mode
    }

    /** The nested path, which no rule reading the method's name could ever have found. */
    @rpc({ semantics: 'idempotent-command', sets: 'zones.top.setpoint' })
    async setTopSetpoint(celsius: number) {
        this.setState((previous) => ({ zones: { top: { ...previous.zones.top, setpoint: celsius } } }))
        return celsius
    }

    /**
     * Named exactly as the old guess would want, and claiming nothing - because it does not assign
     * `state.temperature`, which is measured. This is the method the declaration exists for.
     */
    @rpc({ semantics: 'idempotent-command' })
    async setTemperatureAlarm(limit: number) {
        return limit
    }
}

test('what a method sets is declared, reaches describe, and is absent where nothing claims it', async (t) => {
    const server = new RpcServer({ name: peer('oven3895'), transports: [{ port: 3895, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Oven())
    await server.ready()

    const client = new RpcClient('http://localhost:3895', { name: peer('asker3895'), defaultTarget: peer('oven3895') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const methods = Object.fromEntries((described.namespaces.find((namespace) => namespace.name === 'oven')?.methods ?? []).map((method) => [method.name, method.sets]))

    t.is(methods.setMode, 'mode')
    t.is(methods.setTopSetpoint, 'zones.top.setpoint', 'a path, so nesting is expressible at all')
    // The assertion the whole feature is for: a method named like a setter, that sets nothing.
    t.is(methods.setTemperatureAlarm, undefined, 'a name is not a claim, and must not become one')

    await client.close()
    await server.close()
})

test('sets survives the decorator-free form, which is where scripts live', async (t) => {
    class StrippedOven extends RpcComponent<{ unit: string }, { mode: string }> {
        constructor() {
            super({ unit: 'C' }, { mode: 'idle' })
        }
        async setMode(mode: string) {
            this.setState({ mode })
            return mode
        }
    }
    declareRpcNamespace(StrippedOven, 'stripped')
    exposeMethods(StrippedOven, { setMode: { semantics: 'idempotent-command', sets: 'mode' } })

    const server = new RpcServer({ name: peer('oven3896'), transports: [{ port: 3896, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new StrippedOven())
    await server.ready()

    const client = new RpcClient('http://localhost:3896', { name: peer('asker3896'), defaultTarget: peer('oven3896') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const methods = described.namespaces.find((namespace) => namespace.name === 'stripped')?.methods ?? []

    t.is(methods.find((method) => method.name === 'setMode')?.sets, 'mode', 'a script under type stripping can say what it sets')

    await client.close()
    await server.close()
})

test('a subclass inherits what it does not redeclare, and may move what it overrides', async (t) => {
    class Rebuilt extends Oven {
        // The same field commanded by a different route: the override has to be able to say so.
        @rpc({ semantics: 'idempotent-command', sets: 'zones.top.temperature' })
        override async setTopSetpoint(celsius: number) {
            this.setState((previous) => ({ zones: { top: { ...previous.zones.top, temperature: celsius } } }))
            return celsius
        }
    }

    const server = new RpcServer({ name: peer('oven3897'), transports: [{ port: 3897, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Rebuilt(), 'oven')
    await server.ready()

    const client = new RpcClient('http://localhost:3897', { name: peer('asker3897'), defaultTarget: peer('oven3897') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const methods = Object.fromEntries((described.namespaces.find((namespace) => namespace.name === 'oven')?.methods ?? []).map((method) => [method.name, method.sets]))

    t.is(methods.setMode, 'mode', 'inherited, so a subclass need not re-declare what it did not change')
    t.is(methods.setTopSetpoint, 'zones.top.temperature', 'the nearest declaration wins')

    await client.close()
    await server.close()
})

type TagState = { tags: { [tag: string]: number } }

@rpcNamespace('field')
class Field extends RpcComponent<{ label: string }, TagState> {
    constructor() {
        super({ label: 'f' }, { tags: { a: 1, b: 2 } })
    }

    /** Concrete, because a contract has to describe it; callers reach for RpcPathWriter. */
    @rpc({ semantics: 'idempotent-command', sets: '*' })
    async set(path: string[], value: unknown) {
        const [root, tag] = path
        // Which paths are open is decided here and nowhere else - that is the whole reason the
        // library supplies the marker and not the writer.
        if (root !== 'tags' || path.length !== 2 || typeof value !== 'number') throw new Error(`${path.join('.')} is not writable`)
        this.setState((previous) => ({ tags: { ...previous.tags, [tag]: value } }))
        return value
    }
}

test('a generic setter is refused wholesale unless the host opted in', async (t) => {
    const server = new RpcServer({ name: peer('field3899'), transports: [{ port: 3899, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3899', { name: peer('asker3899'), defaultTarget: peer('field3899') })

    // Refused, and the refusal names the flag - a developer meeting this needs to know which
    // decision was never taken, not merely that they may not.
    const writer = await client.proxy<{ set(path: string[], value: unknown): Promise<unknown> }>('field')
    const refused = await t.throwsAsync(writer.set(['tags', 'a'], 5))
    t.regex(String(refused?.message), /allowStatePathWrites/)

    // And it is not advertised either: a claim the next call would refuse is not a claim, so a
    // console draws no editor from it and a model is offered no tool.
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const set = described.namespaces.find((namespace) => namespace.name === 'field')?.methods.find((method) => method.name === 'set')
    t.truthy(set, 'the method is still exposed - it is the path writing that is refused, not the method existing')
    t.is(set?.sets, undefined, 'a gate that is shut publishes no claim')

    await client.close()
    await server.close()
})

test('opting in honours the generic setter, and the method body still decides what it takes', async (t) => {
    const server = new RpcServer({
        name: peer('field3900'),
        transports: [{ port: 3900, host: '127.0.0.1' }],
        exposeIntrospection: true,
        allowStatePathWrites: true
    })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3900', { name: peer('asker3900'), defaultTarget: peer('field3900') })
    const writer = await client.proxy<{ set(path: string[], value: unknown): Promise<unknown> }>('field')

    t.is(await writer.set(['tags', 'a'], 5), 5)
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    t.is(described.namespaces.find((namespace) => namespace.name === 'field')?.methods.find((method) => method.name === 'set')?.sets, '*')

    // Opting in is not opening the state: the marker says a method *can* set paths, and which ones
    // it will accept stays the author's, inside the body.
    await t.throwsAsync(writer.set(['label'], 'renamed'), { message: /is not writable/ })
    await t.throwsAsync(writer.set(['tags', 'a'], 'hot'), { message: /is not writable/ })

    await client.close()
    await server.close()
})

test('a path that reaches nothing is refused where it is written', (t) => {
    t.throws(
        () => {
            class Bad {
                async set(value: number) {
                    return value
                }
            }
            exposeMethods(Bad, { set: { semantics: 'idempotent-command', sets: 'zones..setpoint' } })
        },
        { message: /not a usable sets path/ },
        'an empty segment reaches nothing, and an editor drawn from it writes nowhere'
    )
})

test('sets is refused on a class with no state to name, and on a query', async (t) => {
    class NotAComponent {
        async setMode(mode: string) {
            return mode
        }
    }
    declareRpcNamespace(NotAComponent, 'plain')
    exposeMethods(NotAComponent, { setMode: { semantics: 'idempotent-command', sets: 'mode' } })

    const server = new RpcServer({ name: peer('oven3898'), transports: [{ port: 3898, host: '127.0.0.1' }] })
    // A path names something in `state`, so a class without any has nothing for one to reach.
    // Refused loudly rather than published as a claim about a state that does not exist.
    t.throws(() => server.exposeClassInstance(new NotAComponent()), { message: /is not an RpcComponent/ })

    class Contradictory extends RpcComponent<{ unit: string }, { mode: string }> {
        constructor() {
            super({ unit: 'C' }, { mode: 'idle' })
        }
        async peek() {
            return this.state.mode
        }
    }
    declareRpcNamespace(Contradictory, 'contradictory')
    exposeMethods(Contradictory, { peek: { semantics: 'query', sets: 'mode' } })

    // Two declarations that cannot both be true. Which one is wrong is the author's to decide,
    // so neither is quietly preferred.
    t.throws(() => server.exposeClassInstance(new Contradictory()), { message: /is not a query/ })

    await server.close()
})
