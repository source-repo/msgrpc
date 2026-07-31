import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, SCHEMA_VERSION, rpc, rpcNamespace, type RpcSchema } from '../index.js'
import { RpcComponent, componentHost } from './Component.js'
import { rpcComponent } from './ComponentClient.js'
import type { SocketIoClientTransport } from '../Transports/SocketIoClientTransport.js'
import { TransportEvent } from './Core.js'

/**
 * The observable component: cached reads, one shared channel, and a status that tells the truth.
 * Ordering is proven with held state and counters, not timing, wherever the transport allows it.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

type OvenProps = { unit: string; maximum: number }
type OvenState = { temperature: number; mode: string }

@rpcNamespace('oven')
class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: '°C', maximum: 200 }, { temperature: 20, mode: 'idle' })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }

    /** Several commits in one turn, so coalescing has something to coalesce. */
    @rpc({ semantics: 'idempotent-command' })
    async warm(steps: number) {
        for (let step = 0; step < steps; step++) this.setState((previous) => ({ temperature: previous.temperature + 1 }))
        return this.state.temperature
    }

    @rpc({ semantics: 'query' })
    async ping() {
        return 'pong'
    }

    /** Unmarked, so never exposed: the bug under test is local server code, not a caller. */
    corrupt() {
        this.setState({ temperature: 'boiling' as unknown as number })
    }
}

class Ordinary {
    async ping() {
        return 'pong'
    }
}

const pair = async (port: number) => {
    const server = new RpcServer({ name: peer(`host${port}`), transports: [{ port }] })
    await server.ready()
    const oven = new Oven()
    server.exposeClassInstance(oven)
    server.exposeClassInstance(new Ordinary(), 'ordinary')
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`watcher${port}`), defaultTarget: peer(`host${port}`) })
    await client.ready()
    return {
        server,
        oven,
        client,
        socket: () => (client.options.transport as SocketIoClientTransport).socket!,
        dispose: async () => {
            await client.close()
            await server.close()
        }
    }
}

test('component() resolves with a readable snapshot, and commits flow to the cache', async (t) => {
    const { oven, client, dispose } = await pair(3861)
    const remote = await client.component<Oven>('oven')

    // Synchronous reads, no network hop, from the first line that can execute.
    t.is(remote.props.unit, '°C')
    t.is(remote.state.mode, 'idle')

    t.is(await remote.setMode('heating'), 'heating')
    await waitFor(() => remote.state.mode === 'heating')
    t.is(oven.state.mode, 'heating', 'the server-side view should agree')

    const store = remote[rpcComponent]
    t.is(store.getSnapshot().status, 'live')
    await store.close()
    await dispose()
})

test('same-turn commits publish once, and local state never lags', async (t) => {
    const { client, dispose } = await pair(3862)
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]

    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)

    t.is(await remote.warm(5), 25, 'the server saw every commit immediately')
    await waitFor(() => remote.state.temperature === 25)
    // Five commits, one microtask window, one snapshot on the wire. The revision may skip - it
    // must only never move backwards - so the count of notifications is what proves coalescing.
    t.is(notifications, 1, `five same-turn commits published ${notifications} snapshots`)

    unsubscribe()
    await store.close()
    await dispose()
})

test('the host replaces props and every watcher learns it', async (t) => {
    const { oven, client, dispose } = await pair(3863)
    const remote = await client.component<Oven>('oven')

    const host = componentHost(oven)
    host.replaceProps((props) => ({ ...props, maximum: 250 }))
    await waitFor(() => remote.props.maximum === 250)
    t.is(remote.props.unit, '°C', 'replacement is whole-snapshot, not a lossy patch')

    await remote[rpcComponent].close()
    await dispose()
})

test('a dropped link marks the view stale, keeps it readable, and reconnect heals it', async (t) => {
    const { oven, client, socket, dispose } = await pair(3864)
    const remote = await client.component<Oven>('oven')
    const store = remote[rpcComponent]
    await remote.setMode('heating')
    await waitFor(() => remote.state.mode === 'heating')

    const reconnected = new Promise<void>((resolve) => client.once(TransportEvent.connected, () => resolve()))
    socket().disconnect()
    await waitFor(() => store.getSnapshot().status === 'stale')
    // Last known beats undefined: the number is still there, with its age on it.
    t.is(remote.state.mode, 'heating')
    t.true((store.getSnapshot().staleSince ?? 0) > 0)

    // A commit made while unreachable is exactly what the resubscription snapshot must repair -
    // one frame carrying current state, not a replay of everything missed.
    await oven.setMode('cooling')
    socket().connect()
    await reconnected
    await waitFor(() => store.getSnapshot().status === 'live')
    t.is(remote.state.mode, 'cooling', 'the reconnect snapshot should carry what changed while away')

    await store.close()
    await dispose()
})

test('two watchers share one subscription, and one leaving does not blind the other', async (t) => {
    const { server, client, dispose } = await pair(3865)
    const first = await client.component<Oven>('oven')
    const second = await client.component<Oven>('oven')

    t.is(server.rpc.eventProxies.size, 1, 'two component() calls should share one remote subscription')

    await first[rpcComponent].close()
    t.is(server.rpc.eventProxies.size, 1, 'the first watcher leaving should not unsubscribe the second')
    await second.setMode('heating')
    await waitFor(() => second.state.mode === 'heating')

    await second[rpcComponent].close()
    await waitFor(() => server.rpc.eventProxies.size === 0)
    t.is(second[rpcComponent].getSnapshot().status, 'closed')

    await dispose()
})

test('$with keeps the component surface, and assignment is refused', async (t) => {
    const { client, dispose } = await pair(3866)
    const remote = await client.component<Oven>('oven')

    const optioned = remote.$with({ timeoutMs: 5000 })
    t.is(await optioned.setMode('manual'), 'manual')
    await waitFor(() => optioned.state.mode === 'manual')
    t.is(optioned.props.unit, '°C', '$with dropped the cached snapshot surface')

    t.throws(() => void ((remote as { state: unknown }).state = {}), { instanceOf: TypeError })
    t.throws(() => void ((remote as { props: unknown }).props = {}), { instanceOf: TypeError })

    await remote[rpcComponent].close()
    await dispose()
})

test('the protected helpers are not remotely callable, and ordinary instances are not components', async (t) => {
    const { client, dispose } = await pair(3867)

    const bare = await client.proxy<Oven>('oven')
    // The allow-list is the guarantee: setState is unmarked, so it is not on the method map.
    const refusal = await t.throwsAsync((bare as unknown as { setState: (u: unknown) => Promise<unknown> }).setState({ mode: 'hacked' }))
    t.regex(String(refusal?.message), /MethodNotFound/)

    // And an ordinary instance refuses component() with a name, not a hang.
    const wrong = await t.throwsAsync(client.component('ordinary'))
    t.regex(String(wrong?.message), /not an observable component/)

    await dispose()
})

test('a restarted component is a new epoch, and the fresh snapshot replaces the old world', async (t) => {
    const { server, client, dispose } = await pair(3868)
    const remote = await client.component<Oven>('oven')
    const firstEpoch = remote[rpcComponent].getSnapshot().epoch

    // A real restart: the server dies and a new process takes its name and port. The client's
    // transport reconnects on its own, resubscription replays the snapshot subscription, and the
    // answering snapshot carries a new epoch - which must win over everything the old world sent.
    await server.close()
    const revived = new RpcServer({ name: peer('host3868'), transports: [{ port: 3868 }] })
    const rebuilt = new Oven()
    await rebuilt.setMode('recovered')
    revived.exposeClassInstance(rebuilt)
    await revived.ready()

    await waitFor(() => remote.state.mode === 'recovered', 10000)
    t.not(remote[rpcComponent].getSnapshot().epoch, firstEpoch)
    t.is(remote[rpcComponent].getSnapshot().status, 'live')

    await remote[rpcComponent].close()
    await client.close()
    await revived.close()
    // The first server is already closed; dispose would close the client again, harmlessly.
    await dispose().catch(() => undefined)
})

test('an invalid snapshot commit is refused before it becomes current', async (t) => {
    const schema: RpcSchema = {
        schema: SCHEMA_VERSION,
        namespaces: {
            oven: {
                methods: {},
                component: {
                    snapshot: 1,
                    props: { kind: 'object', fields: { unit: { type: { kind: 'string' } }, maximum: { type: { kind: 'number' } } } },
                    state: { kind: 'object', fields: { temperature: { type: { kind: 'number' } }, mode: { type: { kind: 'string' } } } }
                }
            }
        }
    }
    const server = new RpcServer({ name: peer('checked'), transports: [{ port: 3869 }], schema, validateComponentSnapshots: true, validation: 'off' })
    await server.ready()
    const oven = new Oven()
    server.exposeClassInstance(oven)

    // The bad commit throws at the setState call site - where the bug is - and changes nothing.
    const failure = t.throws(() => oven.corrupt())
    t.regex(String(failure?.message), /snapshot rejected/)
    t.is(oven.state.temperature, 20, 'the previous snapshot should remain current')

    // A valid commit still flows, so the validator gates rather than jams.
    await oven.setMode('heating')
    t.is(oven.state.mode, 'heating')

    await server.close()
})

test('a server observes a component over its own dialled link, like a console page does', async (t) => {
    const host = new RpcServer({ name: peer('host3870'), transports: [{ port: 3870 }] })
    await host.ready()
    const oven = new Oven()
    host.exposeClassInstance(oven)

    // The observer is itself a server that dials out - the browser console's exact shape, which is
    // the peer this surface exists for: it serves chat and observes components over one link.
    const page = new RpcServer({ name: peer('page3870'), transports: [{ connect: 'http://localhost:3870' }] })
    const remote = await page.component<Oven>('oven', peer('host3870'))

    t.is(remote.props.unit, '°C')
    t.is(await remote.setMode('heating'), 'heating')
    await waitFor(() => remote.state.mode === 'heating')

    const store = remote[rpcComponent]
    t.is(store.getSnapshot().status, 'live')

    // The host going away must read as staleness, not as a number that stopped moving.
    await host.close()
    await waitFor(() => store.getSnapshot().status === 'stale')
    t.is(remote.state.mode, 'heating', 'last known stays readable while stale')

    await page.close()
    t.is(store.getSnapshot().status, 'closed', 'closing the observer tells its stores')
})
