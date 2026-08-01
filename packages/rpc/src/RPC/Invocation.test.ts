import test from 'ava'
import { randomUUID } from 'crypto'
import { createTokenAuthenticator, RpcClient, RpcServer, rpc, rpcNamespace } from '../index.js'
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
