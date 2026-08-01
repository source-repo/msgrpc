import test from 'ava'
import { randomUUID } from 'crypto'
import EventEmitter from 'events'
import { rpc, rpcNamespace, RpcClient, RpcServer } from './index.js'

/**
 * Event cursors: the emission counter that lets "saw nothing" become "saw nothing and missed
 * nothing". The counter runs whether or not anyone is subscribed - that is its whole point - and
 * the epoch bounds the promise honestly: a sequence orders within one server incarnation and says
 * nothing across a restart.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

interface Cursor {
    epoch: string
    seq: number | null
    since?: number
}
interface Introspection {
    eventCursor(namespace: string, event: string): Promise<Cursor>
}

const schema = {
    schema: 1,
    namespaces: {
        alarm: {
            version: '1.0.0',
            methods: { ping: { params: [], paramNames: [] } },
            events: { raised: { params: [{ kind: 'number' }] } }
        }
    }
} as never

@rpcNamespace('alarm')
class AlarmPanel extends EventEmitter {
    @rpc({ semantics: 'query' })
    async ping() {
        return 'ok'
    }
    raise(level: number) {
        this.emit('raised', level)
    }
}

test('a declared event is counted from expose, with nobody subscribed at all', async (t) => {
    const panel = new AlarmPanel()
    const server = new RpcServer({ name: peer('panel3854'), transports: [{ port: 3854, host: '127.0.0.1' }], exposeIntrospection: true, schema })
    server.exposeClassInstance(panel)
    await server.ready()

    // Three alarms into the void: no subscriber anywhere, and that is the case that matters -
    // a counter that only ran while someone watched could never say what happened in between.
    panel.raise(1)
    panel.raise(2)
    panel.raise(3)

    const client = new RpcClient('http://localhost:3854', { name: peer('asker3854'), defaultTarget: peer('panel3854') })
    const msgrpc = await client.proxy<Introspection>('msgrpc')
    const cursor = await msgrpc.eventCursor('alarm', 'raised')
    t.is(cursor.seq, 3, 'every unwatched emission counted')
    t.truthy(cursor.epoch)
    t.truthy(cursor.since, 'the count says when it started counting')

    // An event nothing can track answers null, plainly, rather than a zero that reads as quiet.
    t.is((await msgrpc.eventCursor('alarm', 'nonesuch')).seq, 0, 'an ad-hoc event on an emitter starts counting at the ask')
    t.is((await msgrpc.eventCursor('nowhere', 'raised')).seq, null, 'an unknown namespace cannot be counted, and says so')

    await client.close()
    await server.close()
})

test('deliveries are stamped with the sequence, readable during the handler', async (t) => {
    const panel = new AlarmPanel()
    const server = new RpcServer({ name: peer('panel3855'), transports: [{ port: 3855, host: '127.0.0.1' }], exposeIntrospection: true, schema })
    server.exposeClassInstance(panel)
    await server.ready()

    panel.raise(7) // fired before anyone subscribed: counted, never delivered

    const client = new RpcClient('http://localhost:3855', { name: peer('hearer3855'), defaultTarget: peer('panel3855') })
    const proxy = await client.proxy<{ on(event: string, handler: (...args: unknown[]) => void): Promise<unknown> }>('alarm')
    const stamps: (number | undefined)[] = []
    await proxy.on('raised', () => stamps.push(client.rpcClient?.lastDeliveredStamp?.seq))
    panel.raise(8)
    panel.raise(9)
    await waitFor(() => stamps.length === 2)

    t.deepEqual(stamps, [2, 3], 'the stamp is the emission count, so the missed first alarm shows as the gap before 2')

    await client.close()
    await server.close()
})

test('a restart is a new epoch, so a held cursor reports unknowable rather than guessing', async (t) => {
    const first = new RpcServer({ name: peer('panel3856'), transports: [{ port: 3856, host: '127.0.0.1' }], exposeIntrospection: true, schema })
    first.exposeClassInstance(new AlarmPanel())
    await first.ready()

    const client1 = new RpcClient('http://localhost:3856', { name: peer('asker3856a'), defaultTarget: peer('panel3856') })
    const before = await (await client1.proxy<Introspection>('msgrpc')).eventCursor('alarm', 'raised')
    await client1.close()
    await first.close()

    const second = new RpcServer({ name: peer('panel3856'), transports: [{ port: 3856, host: '127.0.0.1' }], exposeIntrospection: true, schema })
    second.exposeClassInstance(new AlarmPanel())
    await second.ready()

    const client2 = new RpcClient('http://localhost:3856', { name: peer('asker3856b'), defaultTarget: peer('panel3856') })
    const after = await (await client2.proxy<Introspection>('msgrpc')).eventCursor('alarm', 'raised')

    t.not(after.epoch, before.epoch, 'a fresh incarnation does not continue the old count')
    t.is(after.seq, 0)

    await client2.close()
    await second.close()
})
