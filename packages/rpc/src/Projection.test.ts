import test from 'ava'
import { randomUUID } from 'crypto'
import { rpc, rpcNamespace, rpcComponent, rpcPath, rpcRoot, RpcClient, RpcComponent, RpcServer } from './index.js'

/**
 * Per-subscriber projection: asking for the paths a screen shows instead of the whole state.
 *
 * The channel sends a snapshot whole on every change, which is free for a mode and a health and is
 * the link itself for three hundred tags - a 12 kB snapshot is eighty seconds at 1200 baud, so a
 * panel showing twenty values cannot be drawn at all. What comes back is still a *whole* snapshot,
 * of the projection, so nothing that makes this channel simple is given up: duplicate delivery is
 * still harmless and a reconnect is still one frame rather than a replay.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

type FieldProps = { label: string; tags: number }
type FieldState = { fast: number; sweep: number; zones: { top: { setpoint: number; temperature: number } }; tags: { [tag: string]: number } }

@rpcNamespace('field')
class Field extends RpcComponent<FieldProps, FieldState> {
    constructor() {
        const tags: { [tag: string]: number } = {}
        for (let index = 0; index < 300; index++) tags[`tag.${String(index).padStart(3, '0')}`] = index
        super({ label: 'f', tags: 300 }, { fast: 0, sweep: 0, zones: { top: { setpoint: 20, temperature: 19 } }, tags })
    }

    @rpc({ semantics: 'idempotent-command' })
    async tick() {
        this.setState((previous) => ({ fast: previous.fast + 1 }))
        return this.state.fast
    }
}

const state = rpcRoot<FieldState>()
/** Spelled from the root a path starts at, which is how a projection says props or state. */
const inState = (path: string[]) => ['state', ...path]

test('a projection narrows what arrives, and says so rather than looking like a state that shrank', async (t) => {
    const server = new RpcServer({ name: peer('field3901'), transports: [{ port: 3901, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3901', { name: peer('asker3901'), defaultTarget: peer('field3901') })
    const narrow = await client.component<Field>('field', undefined, {
        paths: [inState(rpcPath(state.fast)), inState(rpcPath(state.zones.top.setpoint)), ['props', 'label']]
    })
    const store = narrow[rpcComponent]

    const view = store.getSnapshot()
    t.deepEqual(view.state, { fast: 0, zones: { top: { setpoint: 20 } } }, 'only the named paths, and the branches they pass through')
    t.deepEqual(view.props, { label: 'f' })
    t.is(Object.keys(view.state.tags ?? {}).length, 0, 'three hundred tags nobody asked for do not travel')

    // The field that makes a partial snapshot readable as one. Without it a narrowed subscription
    // and a component that dropped half its state are the same bytes, and a cache merging them
    // would be inventing.
    t.deepEqual(view.projection, [
        ['state', 'fast'],
        ['state', 'zones', 'top', 'setpoint'],
        ['props', 'label']
    ])

    // Still an ordinary snapshot channel: a commit republishes, narrowed the same way, and the
    // revision moves as it always did.
    await narrow.tick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const moved = store.getSnapshot()
    t.is(moved.state.fast, 1)
    t.true(moved.revision > view.revision)
    t.is(Object.keys(moved.state.tags ?? {}).length, 0, 'and it stays narrow on every frame, not just the first')

    await store.close()
    await client.close()
    await server.close()
})

test('the whole snapshot is still the default, and one peer holds one projection per component', async (t) => {
    const server = new RpcServer({ name: peer('field3902'), transports: [{ port: 3902, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3902', { name: peer('asker3902'), defaultTarget: peer('field3902') })

    // Asking for nothing in particular is what every existing caller does, and must not change.
    const whole = await client.component<Field>('field')
    const view = whole[rpcComponent].getSnapshot()
    t.is(Object.keys(view.state.tags).length, 300)
    t.is(view.projection, undefined, 'a whole snapshot claims no projection, so nothing reads it as partial')

    // The server keys a subscription by (instance, event, peer), so a second view with different
    // paths would be one subscription whose contents depended on who opened first. Refused, naming
    // both, rather than silently serving the other one's paths.
    const conflict = await t.throwsAsync(client.component<Field>('field', undefined, { paths: [inState(['fast'])] }))
    t.regex(String(conflict?.message), /already observed here with a different projection/)
    t.regex(String(conflict?.message), /the whole snapshot against state\.fast/)

    // The same projection is the same subscription, which is what keeps two panes on one component
    // costing one of them.
    const again = await client.component<Field>('field')
    t.is(again[rpcComponent].getSnapshot().revision, view.revision)

    await whole[rpcComponent].close()
    await again[rpcComponent].close()
    await client.close()
    await server.close()
})

test('a projection that names nothing is refused, rather than subscribing to silence', async (t) => {
    const server = new RpcServer({ name: peer('field3903'), transports: [{ port: 3903, host: '127.0.0.1' }] })
    server.exposeClassInstance(new Field())
    await server.ready()

    const client = new RpcClient('http://localhost:3903', { name: peer('asker3903'), defaultTarget: peer('field3903') })

    // An empty list is a caller that built its paths wrongly, and an empty snapshot forever looks
    // exactly like a component that has gone quiet - which is the wrong thing to spend a night on.
    const empty = await t.throwsAsync(client.component<Field>('field', undefined, { paths: [] }))
    t.regex(String(empty?.message), /subscribe to nothing/)

    // A path into nothing is simply absent, not an error: state is data, and a tag that has not
    // appeared yet is a legitimate thing to watch for.
    const missing = await client.component<Field>('field', undefined, { paths: [inState(['tags', 'tag.999'])] })
    t.deepEqual(missing[rpcComponent].getSnapshot().state, {}, 'nothing there yet, and the subscription still stands')

    await missing[rpcComponent].close()
    await client.close()
    await server.close()
})
