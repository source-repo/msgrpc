import test from 'ava'
import { randomUUID } from 'crypto'
import { createTokenAuthenticator, declaredNamespace, declareRpcNamespace, exposeMethods, RpcClient, RpcServer, rpc, rpcNamespace } from '../index.js'
import type { RpcInvocationHandle } from './Invocation.js'

/**
 * The invocation handle: who is actually calling, delivered to methods that opt in - and the end
 * of `from`-style parameters as the path of least resistance, which is what the first field trial
 * demonstrated the spoof against.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

@rpcNamespace('desk')
class FrontDesk {
    /** The field-trial shape: a claimed `from` beside the vouched truth. Truth files the message. */
    @rpc({ injectInvocation: true })
    async say(from: string, text: string, invocation: RpcInvocationHandle) {
        return { claimed: from, actual: invocation.context.identity?.name ?? invocation.context.source, text }
    }

    @rpc({ injectInvocation: true })
    async whoCalls(invocation: RpcInvocationHandle) {
        return { source: invocation.context.source, requestId: invocation.context.requestId, roles: invocation.context.identity?.roles }
    }

    /** Optional wire arguments must not shift the handle into an argument's seat. */
    @rpc({ injectInvocation: true })
    async padded(first?: string, second?: string, invocation?: RpcInvocationHandle) {
        return { first: first ?? null, second: second ?? null, sawHandle: !!invocation?.context.requestId }
    }

    @rpc
    async plain(value: string) {
        return value
    }
}

test('the handle names the routed caller, and a claimed from no longer decides anything', async (t) => {
    const server = new RpcServer({ name: peer('desk3846'), transports: [{ port: 3846 }] })
    await server.ready()
    server.exposeClassInstance(new FrontDesk())

    const client = new RpcClient('http://localhost:3846', { name: peer('honest3846'), defaultTarget: peer('desk3846') })
    await client.ready()
    const desk = await client.proxy<FrontDesk>('desk')

    // The spoof from the field trial: claim to be someone else. The claim survives as data; the
    // filing is by who the frame was routed from.
    const answer = await desk.say('somebody-important', 'still there?')
    t.is(answer.claimed, 'somebody-important')
    t.is(answer.actual, peer('honest3846'), 'the routed source decides, not the parameter')

    const who = await desk.whoCalls()
    t.is(who.source, peer('honest3846'))
    t.truthy(who.requestId)
    t.is(who.roles, undefined, 'no transport vouched, so there is no identity to embellish with')

    await client.close()
    await server.close()
})

test('an authenticated transport pins the identity into the handle', async (t) => {
    const token = `secret-${run}`
    const server = new RpcServer({
        name: peer('desk3847'),
        transports: [{ port: 3847 }],
        authenticate: createTokenAuthenticator({ [token]: { name: peer('operator3847'), roles: ['engineer'] } })
    })
    await server.ready()
    server.exposeClassInstance(new FrontDesk())

    const client = new RpcClient('http://localhost:3847', { name: peer('operator3847'), defaultTarget: peer('desk3847'), credentials: { token } })
    await client.ready()
    const desk = await client.proxy<FrontDesk>('desk')

    const who = await desk.whoCalls()
    t.is(who.source, peer('operator3847'))
    t.deepEqual(who.roles, ['engineer'], 'the vouched identity rides the handle, roles and all')

    await client.close()
    await server.close()
})

test('optional arguments left out do not shift the handle, and undeclared methods get no handle', async (t) => {
    const server = new RpcServer({ name: peer('desk3848'), transports: [{ port: 3848 }] })
    await server.ready()
    server.exposeClassInstance(new FrontDesk())

    const client = new RpcClient('http://localhost:3848', { name: peer('caller3848'), defaultTarget: peer('desk3848') })
    await client.ready()
    const desk = await client.proxy<FrontDesk>('desk')

    const padded = await desk.padded('only-one')
    t.deepEqual(padded, { first: 'only-one', second: null, sawHandle: true }, 'the handle arrives in its own seat, padded past the absent optionals')

    t.is(await desk.plain('untouched'), 'untouched', 'a method that did not opt in sees exactly its wire arguments')

    await client.close()
    await server.close()
})

// Deliberately no decorators anywhere in this class: this is the form a script under Node's type
// stripping can actually write, and it must be able to say everything @rpc can - the field trial's
// spoof was against a script, and the fix cannot be a privilege of code with a compile step.
class StrippedDesk {
    async say(from: string, text: string, invocation?: RpcInvocationHandle) {
        return { claimed: from, actual: invocation?.context.identity?.name ?? invocation?.context.source, text }
    }
    async plain(value: string) {
        return value
    }
}
declareRpcNamespace(StrippedDesk, 'desk', { version: '2.0.0' })
exposeMethods(StrippedDesk, { say: { injectInvocation: true, semantics: 'query' }, plain: {} })

test('exposeMethods can say what @rpc says, so a decorator-free class gets the handle too', async (t) => {
    const server = new RpcServer({ name: peer('desk3857'), transports: [{ port: 3857, host: '127.0.0.1' }], exposeIntrospection: true })
    await server.ready()
    // No name passed: declareRpcNamespace supplied it, exactly as @rpcNamespace would have.
    server.exposeClassInstance(new StrippedDesk())

    const client = new RpcClient('http://localhost:3857', { name: peer('caller3857'), defaultTarget: peer('desk3857') })
    await client.ready()
    const desk = await client.proxy<StrippedDesk>('desk')

    const answer = await desk.say('somebody-important', 'still there?')
    t.is(answer.claimed, 'somebody-important')
    t.is(answer.actual, peer('caller3857'), 'the routed source decides, marked without a single decorator')

    t.is(await desk.plain('untouched'), 'untouched', 'a method marked with empty options sees exactly its wire arguments')

    // The declaration went where the decorator's would have: the runtime records carry the
    // version, and describe() reports the query semantics from the same marks. (A version in
    // describe() itself comes from an extracted schema, which a runtime-marked class deliberately
    // does not have - scripts run without a build step, and that is the point of this form.)
    t.is(declaredNamespace(new StrippedDesk())?.version, '2.0.0')
    const described = await (await client.proxy<{ describe(): Promise<{ namespaces: { name: string; methods: { name: string; semantics?: string }[] }[] }> }>('msgrpc')).describe()
    const desk2 = described.namespaces.find((namespace) => namespace.name === 'desk')
    t.is(desk2?.methods.find((method) => method.name === 'say')?.semantics, 'query')

    await client.close()
    await server.close()
})
