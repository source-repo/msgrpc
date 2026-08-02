import test from 'ava'
import { randomUUID } from 'crypto'
import { declareRpcNamespace, exposeMethods, rpc, rpcNamespace, RpcClient, RpcServer } from './index.js'
import { namespaceProblems } from './RPC/Compatibility.js'
import type { NamespaceSchema } from './RPC/Schema.js'

/**
 * The effect classification: what kind of power a method exercises, as opposed to whether it may be
 * repeated. The two are orthogonal, and conflating them was the bug this exists to prevent - a
 * caller permitted to move a setpoint must not thereby be permitted to deploy a program, however
 * idempotent both happen to be.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

interface Introspection {
    describe(): Promise<{ namespaces: { name: string; methods: { name: string; effect?: string; semantics?: string }[] }[] }>
}

@rpcNamespace('cell')
class Cell {
    @rpc({ semantics: 'query' })
    async status() {
        return 'idle'
    }

    // The pair that makes the point: identical semantics, different power.
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    async setSetpoint(value: number) {
        return value
    }

    @rpc({ semantics: 'idempotent-command', effect: 'program' })
    async deployProgram(bundle: string) {
        return bundle.length
    }

    // Declares nothing about effect: a command, so it must default to operate rather than observe.
    @rpc({ semantics: 'idempotent-command' })
    async acknowledge() {
        return 'acknowledged'
    }

    // Neither semantics nor effect. Unclassified is never read as harmless.
    @rpc
    async mystery() {
        return 'who knows'
    }

    @rpc({ effect: 'security-admin' })
    async grant(who: string) {
        return who
    }
}

test('effect is declared, defaulted conservatively, and reported by describe', async (t) => {
    const server = new RpcServer({ name: peer('cell3860'), transports: [{ port: 3860, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Cell())
    await server.ready()

    const client = new RpcClient('http://localhost:3860', { name: peer('asker3860'), defaultTarget: peer('cell3860') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const methods = Object.fromEntries((described.namespaces.find((namespace) => namespace.name === 'cell')?.methods ?? []).map((method) => [method.name, method.effect]))

    t.is(methods.status, 'observe', 'a declared query observes')
    t.is(methods.setSetpoint, 'operate')
    t.is(methods.deployProgram, 'program', 'the same semantics as setSetpoint, and a different power')
    t.is(methods.acknowledge, 'operate', 'a command declaring no effect defaults to operate')
    t.is(methods.mystery, 'operate', 'declaring nothing at all is not a claim to harmlessness')
    t.is(methods.grant, 'security-admin')

    // Always present, so a consumer never has to reimplement the defaulting rule to find out.
    t.true((described.namespaces.find((namespace) => namespace.name === 'cell')?.methods ?? []).every((method) => !!method.effect))

    await client.close()
    await server.close()
})

test('effect survives the decorator-free form, which is where scripts live', async (t) => {
    class StrippedCell {
        async read() {
            return 1
        }
        async deploy(bundle: string) {
            return bundle
        }
    }
    declareRpcNamespace(StrippedCell, 'stripped')
    exposeMethods(StrippedCell, { read: { semantics: 'query' }, deploy: { semantics: 'idempotent-command', effect: 'program' } })

    const server = new RpcServer({ name: peer('cell3861'), transports: [{ port: 3861, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new StrippedCell())
    await server.ready()

    const client = new RpcClient('http://localhost:3861', { name: peer('asker3861'), defaultTarget: peer('cell3861') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const methods = Object.fromEntries((described.namespaces.find((namespace) => namespace.name === 'stripped')?.methods ?? []).map((method) => [method.name, method.effect]))

    t.is(methods.read, 'observe')
    t.is(methods.deploy, 'program', 'a script under type stripping can classify its own power')

    await client.close()
    await server.close()
})

test('a subclass may reclassify what it overrides', async (t) => {
    @rpcNamespace('base')
    class Base {
        @rpc({ semantics: 'idempotent-command', effect: 'operate' })
        async apply(value: string) {
            return value
        }
    }
    // The override does more than the parent did, and has to be able to say so.
    class Stricter extends Base {
        @rpc({ semantics: 'idempotent-command', effect: 'program' })
        override async apply(value: string) {
            return value
        }
    }

    const server = new RpcServer({ name: peer('cell3862'), transports: [{ port: 3862, host: '127.0.0.1' }], exposeIntrospection: true })
    server.exposeClassInstance(new Stricter(), 'base')
    await server.ready()

    const client = new RpcClient('http://localhost:3862', { name: peer('asker3862'), defaultTarget: peer('cell3862') })
    const described = await (await client.proxy<Introspection>('msgrpc')).describe()
    const applied = described.namespaces.find((namespace) => namespace.name === 'base')?.methods.find((method) => method.name === 'apply')
    t.is(applied?.effect, 'program', 'the nearest declaration wins')

    await client.close()
    await server.close()
})

// ------------------------------------------------------------------ compatibility

const withEffect = (effect?: string): NamespaceSchema =>
    ({
        version: '1',
        methods: { act: { params: [], paramNames: [], semantics: 'idempotent-command', ...(effect ? { effect } : {}) } }
    }) as unknown as NamespaceSchema

test('effect may not escalate, and may not quietly vanish', (t) => {
    const escalated = namespaceProblems(withEffect('operate'), withEffect('program'))
    t.is(escalated.length, 1)
    t.regex(escalated[0].reason, /granted the lesser authority is refused/)

    // Down the ladder is not a compatibility break: a caller granted 'program' can still call it.
    t.deepEqual(namespaceProblems(withEffect('program'), withEffect('operate')), [])

    // Dropping the declaration falls back to a weaker default, which is the dangerous direction.
    const dropped = namespaceProblems(withEffect('program'), withEffect(undefined))
    t.is(dropped.length, 1)
    t.regex(dropped[0].reason, /no longer declares effect/)

    // Adopting a declaration where there was none must never be the change that fails a check -
    // saying out loud what a method always did is the behaviour this wants to encourage.
    t.deepEqual(namespaceProblems(withEffect(undefined), withEffect('program')), [])

    t.deepEqual(namespaceProblems(withEffect('operate'), withEffect('operate')), [])
})
