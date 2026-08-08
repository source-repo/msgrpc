import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer } from '../index.js'
import { defineRpcContext } from './Context.js'
import { HOST_ROOT } from './Topology.js'

/**
 * The context-resolution conformance suite of the adopted spec's §23.2, over local chains and
 * socket.io. Nearest and collect, no cross-axis fallback, staleness with values kept, the atomic
 * remount, dedup, coalescing, the named cycle, and capture's bounds - each as its own test,
 * because each is its own promise.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

const plantToken = () =>
    defineRpcContext<{ plantId: string; pressureUnit: string }>({ id: `acme.plant.${run}`, schemaVersion: '1', axis: 'physical', capture: 'explicit' })
const workOrderToken = () => defineRpcContext<{ workOrder: string }>({ id: `acme.work-order.${run}`, schemaVersion: '1', axis: 'logical', capture: 'explicit' })

test('a token is namespaced, and control characters are refused where every id refuses them', (t) => {
    t.throws(() => defineRpcContext({ id: 'bare', schemaVersion: '1', axis: 'physical' }), { message: /no namespace/ })
    t.throws(() => defineRpcContext({ id: 'acme.bad\u0000id', schemaVersion: '1', axis: 'physical' }), { message: /not a usable token id/ })
})

test('the local provider wins, nearest stops there, and collect gathers the chain in order', async (t) => {
    const server = new RpcServer({ name: peer('local3884'), transports: [{ port: 3884 }], topology: { place: ['site-7'] } })
    await server.ready()
    await server.topology.declare('cell')
    await server.topology.declare('oven', { parent: { peer: peer('local3884'), instance: 'cell' } })

    const nearest = plantToken()
    server.provideContext(HOST_ROOT, nearest, { plantId: 'root-says', pressureUnit: 'bar' })
    server.provideContext('cell', nearest, { plantId: 'cell-says', pressureUnit: 'bar' })

    const store = server.contextOf('oven', nearest)
    await waitFor(() => store.getSnapshot().status === 'live')
    t.is((store.getSnapshot().entry?.value as { plantId: string }).plantId, 'cell-says', 'the nearest provider is the answer')

    const gathering = defineRpcContext({ id: `acme.collect.${run}`, schemaVersion: '1', axis: 'physical', resolution: 'collect' })
    server.provideContext(HOST_ROOT, gathering, 'far')
    server.provideContext('cell', gathering, 'near')
    const collected = server.contextOf('oven', gathering)
    await waitFor(() => collected.getSnapshot().status === 'live')
    t.deepEqual(
        collected.getSnapshot().entries?.map((entry) => entry.value),
        ['near', 'far'],
        'collect is nearest to farthest, and nothing merges anything'
    )

    store.close()
    collected.close()
    await server.close()
})

test('a complete chain with no provider is missing, and the other axis is never consulted', async (t) => {
    const server = new RpcServer({ name: peer('axis3885'), transports: [{ port: 3885 }] })
    await server.ready()
    // The pump's *owner* provides a physical-axis token. The pump's physical chain never passes
    // through its owner, so the value must not be found - there is no logical-then-physical.
    await server.topology.declare('line')
    await server.topology.declare('pump', { owner: { peer: peer('axis3885'), instance: 'line' } })
    const physical = plantToken()
    server.provideContext('line', physical, { plantId: 'wrong-axis', pressureUnit: 'bar' })

    const store = server.contextOf('pump', physical)
    await waitFor(() => store.getSnapshot().status === 'missing')
    t.is(store.getSnapshot().status, 'missing', 'missing is the honest answer; borrowing across axes would be a guess')

    store.close()
    await server.close()
})

test.serial('context inherits across hosts: physically root to root, logically through a remote owner', async (t) => {
    const plantName = peer('plant3886')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3886 }], topology: { place: ['site-7'] } })
    await plant.ready()
    await plant.topology.declare('line')
    const physical = plantToken()
    const logical = workOrderToken()
    plant.provideContext(HOST_ROOT, physical, { plantId: 'site-7', pressureUnit: 'bar' })
    plant.provideContext('line', logical, { workOrder: 'WO-17' })

    const edge = new RpcServer({ name: peer('edge3886'), transports: [{ connect: 'http://localhost:3886' }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })
    await edge.topology.declare('machine', { owner: { peer: plantName, instance: 'line' } })

    const inherited = edge.contextOf('machine', physical)
    const ordered = edge.contextOf('machine', logical)
    await waitFor(() => inherited.getSnapshot().status === 'live' && ordered.getSnapshot().status === 'live')
    t.is((inherited.getSnapshot().entry?.value as { plantId: string }).plantId, 'site-7', 'the physical chain crossed root to root')
    t.is((ordered.getSnapshot().entry?.value as { workOrder: string }).workOrder, 'WO-17', 'the logical chain followed the remote owner')
    t.deepEqual(inherited.getSnapshot().entry?.provider, { peer: plantName, instance: HOST_ROOT }, 'provenance names the provider, not just the value')

    // A provider update flows: the plant changes the work order and the edge sees it move.
    const handle = plant.provideContext('line', defineRpcContext({ id: `acme.second.${run}`, schemaVersion: '1', axis: 'logical' }), 'first')
    const second = edge.contextOf('machine', defineRpcContext({ id: `acme.second.${run}`, schemaVersion: '1', axis: 'logical' }))
    await waitFor(() => second.getSnapshot().status === 'live')
    handle.set('second')
    await waitFor(() => second.getSnapshot().entry?.value === 'second')
    t.pass()

    inherited.close()
    ordered.close()
    second.close()
    await edge.close()
    await plant.close()
})

test.serial('losing the providing host is stale with the value kept; its return is live with a new provider epoch', async (t) => {
    const plantName = peer('plant3887')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3887 }] })
    await plant.ready()
    const physical = plantToken()
    plant.provideContext(HOST_ROOT, physical, { plantId: 'before', pressureUnit: 'bar' })

    const edge = new RpcServer({ name: peer('edge3887'), transports: [{ connect: 'http://localhost:3887' }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })
    const store = edge.contextOf(HOST_ROOT, physical)
    await waitFor(() => store.getSnapshot().status === 'live')
    const firstEpoch = store.getSnapshot().entry?.providerVersion.epoch

    await plant.close()
    await waitFor(() => store.getSnapshot().status === 'stale', 15_000)
    t.is((store.getSnapshot().entry?.value as { plantId: string }).plantId, 'before', 'last known stays readable, with its age on it')
    t.truthy(store.getSnapshot().staleSince)

    // The plant returns - a new process under the old name - and provides again. The edge's
    // subscription replays, and the fresh registration is a fresh provider epoch: the new world
    // must never look like a continuation of the old one's revision count.
    const revived = new RpcServer({ name: plantName, transports: [{ port: 3887 }] })
    await revived.ready()
    revived.provideContext(HOST_ROOT, physical, { plantId: 'after', pressureUnit: 'bar' })
    await waitFor(() => store.getSnapshot().status === 'live', 20_000)
    t.is((store.getSnapshot().entry?.value as { plantId: string }).plantId, 'after')
    t.not(store.getSnapshot().entry?.providerVersion.epoch, firstEpoch, 'a restarted provider is a new epoch')

    store.close()
    await edge.close()
    await revived.close()
})

test.serial('an owner change is an atomic remount: never a mixture, the old world only as previous', async (t) => {
    const plantName = peer('plant3888')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3888 }] })
    await plant.ready()
    await plant.topology.declare('line')
    await plant.topology.declare('maintenance')
    const logical = workOrderToken()
    plant.provideContext('line', logical, { workOrder: 'production-batch' })
    plant.provideContext('maintenance', logical, { workOrder: 'bearing-replacement' })

    const edge = new RpcServer({ name: peer('edge3888'), transports: [{ connect: 'http://localhost:3888' }] })
    await edge.ready()
    await edge.topology.declare('machine', { owner: { peer: plantName, instance: 'line' } })

    const store = edge.contextOf('machine', logical)
    await waitFor(() => store.getSnapshot().status === 'live')
    const mounted = store.getSnapshot().mountEpoch

    // Every snapshot the store ever serves is recorded, so mixture is checkable afterwards.
    const observed: { status: string; value?: string; mountEpoch: string }[] = []
    store.subscribe(() => {
        const view = store.getSnapshot()
        observed.push({ status: view.status, value: (view.entry?.value as { workOrder: string } | undefined)?.workOrder, mountEpoch: view.mountEpoch })
    })

    const machine = edge.topology.get('machine')!
    await edge.topology.update('machine', { owner: { peer: plantName, instance: 'maintenance' } }, { expectedVersion: machine.version })
    await waitFor(() => (store.getSnapshot().entry?.value as { workOrder: string } | undefined)?.workOrder === 'bearing-replacement')

    const finalView = store.getSnapshot()
    t.not(finalView.mountEpoch, mounted, 'a reassigned owner is a new mount')
    t.is(finalView.transitionReason, 'owner-remount')
    for (const step of observed) {
        // The one thing that must never happen: the old scope's value presented as current under
        // the new mount. It may appear only as `previous`, which require() never returns.
        if (step.mountEpoch !== mounted && step.value === 'production-batch') t.fail(`the old owner's value leaked into the new mount: ${JSON.stringify(step)}`)
    }
    t.deepEqual(store.getSnapshot().previous, { value: { workOrder: 'production-batch' }, provider: { peer: plantName, instance: 'line' }, providerVersion: store.getSnapshot().previous && (store.getSnapshot().previous as { providerVersion: { epoch: string; revision: number } }).providerVersion }, 'the old world is diagnostics, not data')

    store.close()
    await edge.close()
    await plant.close()
})

test.serial('tokens on one axis share one upstream subscription, and so do two stores of one token', async (t) => {
    const plantName = peer('plant3889')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3889 }] })
    await plant.ready()
    const one = defineRpcContext({ id: `acme.one.${run}`, schemaVersion: '1', axis: 'physical' })
    const two = defineRpcContext({ id: `acme.two.${run}`, schemaVersion: '1', axis: 'physical' })
    plant.provideContext(HOST_ROOT, one, 1)
    plant.provideContext(HOST_ROOT, two, 2)

    const edge = new RpcServer({ name: peer('edge3889'), transports: [{ connect: 'http://localhost:3889' }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })

    const first = edge.contextOf(HOST_ROOT, one)
    const again = edge.contextOf(HOST_ROOT, one)
    const other = edge.contextOf(HOST_ROOT, two)
    await waitFor(() => first.getSnapshot().status === 'live' && other.getSnapshot().status === 'live')
    t.is(plant.context.subscriptionCount, 1, 'one chain, one hop, one subscription - twenty tokens would still be one')

    first.close()
    await waitFor(() => again.getSnapshot().status === 'live')
    t.is(again.getSnapshot().status, 'live', 'one store leaving does not blind the other')

    again.close()
    other.close()
    await edge.close()
    await plant.close()
})

test.serial('a burst of provider updates coalesces to few pushes, and the last value always lands', async (t) => {
    const plantName = peer('plant3890')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3890 }] })
    await plant.ready()
    const token = defineRpcContext({ id: `acme.burst.${run}`, schemaVersion: '1', axis: 'physical' })
    const handle = plant.provideContext(HOST_ROOT, token, 0)

    const edge = new RpcServer({ name: peer('edge3890'), transports: [{ connect: 'http://localhost:3890' }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })
    const store = edge.contextOf(HOST_ROOT, token)
    await waitFor(() => store.getSnapshot().status === 'live')

    let notifications = 0
    store.subscribe(() => notifications++)
    // Fifty same-turn commits: the subscription's snapshot is computed at fire time, so a slow
    // subscriber holds at most one pending frame and hears the newest world, not the history.
    for (let value = 1; value <= 50; value++) handle.set(value)
    await waitFor(() => store.getSnapshot().entry?.value === 50)
    t.true(notifications < 10, `fifty commits reached the store as ${notifications} notifications - context is state, not a stream`)

    store.close()
    await edge.close()
    await plant.close()
})

test.serial('an owner ring across two hosts is invalid with its path, and require fails closed on it', async (t) => {
    const aName = peer('plant3891')
    const bName = peer('edge3891')
    const a = new RpcServer({ name: aName, transports: [{ port: 3891 }] })
    await a.ready()
    const b = new RpcServer({ name: bName, transports: [{ connect: 'http://localhost:3891' }] })
    await b.ready()
    await a.topology.declare('x', { owner: { peer: bName, instance: 'y' } })
    await b.topology.declare('y', { owner: { peer: aName, instance: 'x' } })

    const token = workOrderToken()
    const store = a.contextOf('x', token)
    await waitFor(() => store.getSnapshot().status === 'invalid', 15_000)
    t.is(store.getSnapshot().invalidReason, 'cycle')
    t.deepEqual(
        store.getSnapshot().invalidPath?.map((ref) => `${ref.peer}/${ref.instance}`),
        [`${aName}/x`, `${bName}/y`],
        'the ring is named with its path - what an operator can actually act on'
    )
    t.throws(() => a.requireContext('x', token), { message: /fail closed/ })

    store.close()
    await b.close()
    await a.close()
})

test('capture is explicit-only, local values never leave, and the bound is checked before acceptance', async (t) => {
    const server = new RpcServer({ name: peer('capture3892'), transports: [{ port: 3892 }] })
    await server.ready()
    const capturable = plantToken()
    const secretive = defineRpcContext({ id: `acme.secret.${run}`, schemaVersion: '1', axis: 'physical', exposure: 'local', capture: 'explicit' })
    const homebody = defineRpcContext({ id: `acme.homebody.${run}`, schemaVersion: '1', axis: 'physical' })
    server.provideContext(HOST_ROOT, capturable, { plantId: 'site-7', pressureUnit: 'bar' })
    server.provideContext(HOST_ROOT, secretive, 'the broker password, which must never ride a payload')
    server.provideContext(HOST_ROOT, homebody, 'stays')
    await waitFor(() => server.contextOf(HOST_ROOT, capturable).getSnapshot().status === 'live')

    const captured = server.captureContext(HOST_ROOT, [capturable])
    t.is(captured.entries.length, 1)
    t.deepEqual(captured.entries[0].value, { plantId: 'site-7', pressureUnit: 'bar' })
    t.truthy(captured.entries[0].mountEpoch, 'a capture names the mount it saw, which is what makes it evidence')

    t.throws(() => server.captureContext(HOST_ROOT, [homebody]), { message: /stays on its chain/ })
    t.throws(() => server.captureContext(HOST_ROOT, [secretive]), { message: /leaving the host/ })

    // The aggregate bound, before anything accepts the capture into a payload.
    const bulky = defineRpcContext({ id: `acme.bulky.${run}`, schemaVersion: '1', axis: 'physical', capture: 'explicit', maxSerializedBytes: 128 * 1024 })
    server.provideContext(HOST_ROOT, bulky, 'x'.repeat(70 * 1024))
    await waitFor(() => server.contextOf(HOST_ROOT, bulky).getSnapshot().status === 'live')
    t.throws(() => server.captureContext(HOST_ROOT, [bulky]), { message: /exceeds the/ })

    await server.close()
})

test.serial('a local-only value is filtered from remote answers silently - absence, not refusal', async (t) => {
    const plantName = peer('plant3893')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3893 }] })
    await plant.ready()
    const secret = defineRpcContext({ id: `acme.dburl.${run}`, schemaVersion: '1', axis: 'physical', exposure: 'local' })
    plant.provideContext(HOST_ROOT, secret, 'postgres://secret')

    // Locally it resolves - the host's own code reads its own secret.
    const local = plant.contextOf(HOST_ROOT, secret)
    await waitFor(() => local.getSnapshot().status === 'live')

    // Remotely the same chain answers missing: the wire snapshot simply does not contain it,
    // because a named refusal would confirm the secret exists.
    const client = new RpcClient('http://localhost:3893', { name: peer('nosy3893'), defaultTarget: plantName })
    await client.ready()
    const answer = await client.readContext(plantName, HOST_ROOT, [secret.id])
    t.deepEqual(answer.tokens[0], { tokenId: secret.id, entries: [] })

    local.close()
    await client.close()
    await plant.close()
})

test.serial('contextAt watches what another peer\'s node sees, following the chain past that host', async (t) => {
    // Three peers: a plant that provides, an edge whose node inherits across both axes, and an
    // observer that owns neither and grafts itself onto neither.
    const plantName = peer('plant3894')
    const edgeName = peer('edge3894')
    const plant = new RpcServer({ name: plantName, transports: [{ port: 3894 }], topology: { place: ['site-7'] } })
    await plant.ready()
    await plant.topology.declare('line')

    const site = plantToken()
    const work = workOrderToken()
    plant.provideContext(HOST_ROOT, site, { plantId: 'site-7', pressureUnit: 'bar' })
    plant.provideContext('line', work, { workOrder: 'WO-17' })

    const edge = new RpcServer({ name: edgeName, transports: [{ connect: 'http://localhost:3894' }] })
    await edge.ready()
    await edge.topology.updateHost({ parent: { peer: plantName, instance: HOST_ROOT } }, { expectedVersion: edge.topology.get(HOST_ROOT)!.version })
    // Nothing is provided on the edge at all: everything its line sees is inherited, which is
    // what makes this a test of the chain rather than of one hop.
    await edge.topology.declare('line', { owner: { peer: plantName, instance: 'line' } })

    const observer = new RpcServer({ name: peer('console3894'), transports: [{ connect: 'http://localhost:3894' }] })
    await observer.ready()

    const physical = observer.contextAt({ peer: edgeName, instance: 'line' }, site)
    const logical = observer.contextAt({ peer: edgeName, instance: 'line' }, work)
    await waitFor(() => physical.getSnapshot().status === 'live' && logical.getSnapshot().status === 'live')

    t.is((physical.getSnapshot().entry?.value as { plantId: string }).plantId, 'site-7', 'the physical chain was followed edge root to plant root')
    t.is((logical.getSnapshot().entry?.value as { workOrder: string }).workOrder, 'WO-17', 'the logical chain was followed through the remote owner')
    t.deepEqual(physical.getSnapshot().entry?.provider, { peer: plantName, instance: HOST_ROOT }, 'provenance names the provider, not the peer that was asked')

    // Live, not a snapshot taken once: a provider two hosts away moves and the observer sees it.
    const second = plant.provideContext('line', defineRpcContext({ id: `acme.moves.${run}`, schemaVersion: '1', axis: 'logical' }), 'first')
    const moving = observer.contextAt({ peer: edgeName, instance: 'line' }, defineRpcContext({ id: `acme.moves.${run}`, schemaVersion: '1', axis: 'logical' }))
    await waitFor(() => moving.getSnapshot().status === 'live')
    second.set('second')
    await waitFor(() => moving.getSnapshot().entry?.value === 'second')

    // A ref on this host is the ordinary local chain, not a hop out and back.
    observer.provideContext(HOST_ROOT, site, { plantId: 'here', pressureUnit: 'psi' })
    const mine = observer.contextAt({ peer: observer.options.name, instance: HOST_ROOT }, site)
    await waitFor(() => mine.getSnapshot().status === 'live')
    t.is((mine.getSnapshot().entry?.value as { plantId: string }).plantId, 'here')

    physical.close()
    logical.close()
    moving.close()
    mine.close()
    await observer.close()
    await edge.close()
    await plant.close()
})
