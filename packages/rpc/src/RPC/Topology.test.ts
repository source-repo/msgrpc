import test from 'ava'
import { randomUUID } from 'crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { RpcClient, RpcServer } from '../index.js'
import { HOST_ROOT, HostTopology, type RpcTopologyRecord } from './Topology.js'
import { JsonFileTopologyStore } from './TopologyFileStore.js'
import type { ServerDescription } from './Introspection.js'

/**
 * The federated topology core: host-authoritative records, CAS mutations, epochs that rotate on
 * mutation and never on restart, local physical invariants enforced at commit, and cycles on the
 * axis no host can police alone detected at derivation with their path named.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const loaded = async (name: string, options?: ConstructorParameters<typeof HostTopology>[1]) => {
    const topology = new HostTopology(name, options)
    await topology.init()
    return topology
}

test('a declared component gets edges, epochs and a version; the root is synthesized', async (t) => {
    const topology = await loaded('plant-a', { place: ['site-7', 'building-b'], label: 'Building B' })

    const root = topology.get(HOST_ROOT)!
    t.deepEqual(root.ref, { peer: 'plant-a', instance: HOST_ROOT })
    t.is(root.label, 'Building B')

    const oven = await topology.declare('oven', { label: 'Ugn 3 (våning 2)' })
    t.deepEqual(oven.parent, { peer: 'plant-a', instance: HOST_ROOT }, 'the synthetic root is the default parent')
    t.is(oven.owner, null, 'a missing owner never falls back to the physical parent')
    t.is(oven.version.revision, 0)
    t.truthy(oven.parentEpoch)
    t.truthy(oven.ownerEpoch)
})

test('mutation is compare-and-set, and every committed owner patch is a new generation', async (t) => {
    const topology = await loaded('plant-b')
    const declared = await topology.declare('pump')

    const wrong = await t.throwsAsync(topology.update('pump', { owner: { peer: 'plant-b', instance: 'line' } }, { expectedVersion: { epoch: declared.version.epoch, revision: 7 } }))
    t.regex(String(wrong?.message), /read it again/)

    const toLine = await topology.update('pump', { owner: { peer: 'plant-b', instance: 'line' } }, { expectedVersion: declared.version })
    t.is(toLine.version.revision, 1)
    t.not(toLine.ownerEpoch, declared.ownerEpoch)
    t.is(toLine.parentEpoch, declared.parentEpoch, 'the unpatched link keeps its epoch')

    // A to B and back to A: the fence must treat the second A as a new grant, so a command
    // delayed since the first A-era finds a different generation and stays dead.
    const toMaintenance = await topology.update('pump', { owner: { peer: 'other', instance: 'job-1' } }, { expectedVersion: toLine.version })
    const backToLine = await topology.update('pump', { owner: { peer: 'plant-b', instance: 'line' } }, { expectedVersion: toMaintenance.version })
    t.not(backToLine.ownerEpoch, toLine.ownerEpoch, 'the same owner again is not the same generation again')
})

test('the physical invariants hold at commit: local parents, no self, no local cycle', async (t) => {
    const topology = await loaded('plant-c')
    await topology.declare('cell')
    await topology.declare('oven', { parent: { peer: 'plant-c', instance: 'cell' } })

    await t.throwsAsync(topology.declare('rogue', { parent: { peer: 'elsewhere', instance: 'cell' } }), { message: /remote physical parent/ })
    await t.throwsAsync(topology.declare('narcissus', { parent: { peer: 'plant-c', instance: 'narcissus' } }), { message: /own parent/ })
    await t.throwsAsync(topology.declare('owner-of-self', { owner: { peer: 'plant-c', instance: 'owner-of-self' } }), { message: /own itself/ })

    const cell = topology.get('cell')!
    await t.throwsAsync(topology.update('cell', { parent: { peer: 'plant-c', instance: 'oven' } }, { expectedVersion: cell.version }), { message: /closes a physical cycle/ })
})

test('the host root carries the one cross-host edge, root to root only', async (t) => {
    const topology = await loaded('edge-box')
    const root = topology.get(HOST_ROOT)!

    await t.throwsAsync(topology.updateHost({ parent: { peer: 'plant-central', instance: 'area-2' } }, { expectedVersion: root.version }), { message: /another host root/ })

    const attached = await topology.updateHost({ parent: { peer: 'plant-central', instance: HOST_ROOT } }, { expectedVersion: root.version })
    t.deepEqual(attached.parent, { peer: 'plant-central', instance: HOST_ROOT })

    const again = topology.get(HOST_ROOT)!
    await t.throwsAsync(topology.updateHost({ parent: { peer: 'edge-box', instance: HOST_ROOT } }, { expectedVersion: again.version }), { message: /another host's root/ })
})

test('an owner cycle is detected invalid topology with its path, never quietly resolved', async (t) => {
    const topology = await loaded('plant-d')
    const a = await topology.declare('a', { owner: { peer: 'plant-d', instance: 'b' } })
    await topology.declare('b', { owner: { peer: 'plant-d', instance: 'c' } })
    const c = await topology.declare('c')
    await topology.update('c', { owner: { peer: 'plant-d', instance: 'a' } }, { expectedVersion: c.version })

    const walked = topology.ownerChain('a')
    t.is(walked.validity.status, 'cycle')
    t.deepEqual(
        (walked.validity.status === 'cycle' ? walked.validity.path : []).map((ref) => ref.instance),
        ['a', 'b', 'c'],
        'the cycle is named with its path, which is what an operator can act on'
    )
    t.truthy(a, 'declaring into a future cycle was legal - only the walk can see the whole ring')
})

test('paths are derived, rooted at the declared place, and honest about what is missing', async (t) => {
    const topology = await loaded('plant-e', { place: ['site-7', 'building-b'] })
    await topology.declare('cell')
    await topology.declare('oven', { parent: { peer: 'plant-e', instance: 'cell' } })

    t.deepEqual(topology.physicalPath('oven'), { segments: ['site-7', 'building-b', 'cell', 'oven'], validity: { status: 'valid' } })

    const bare = await loaded('plant-bare')
    await bare.declare('oven')
    t.deepEqual(bare.physicalPath('oven').segments, ['plant-bare', 'oven'], 'no declared place, so the host id is the root segment')

    // A parent that was never declared is an unresolved path, not a silent shorter one.
    await topology.declare('sensor', { parent: { peer: 'plant-e', instance: 'cabinet' } })
    const dangling = topology.physicalPath('sensor')
    t.deepEqual(dangling.validity, { status: 'unresolved', at: { peer: 'plant-e', instance: 'cabinet' } })
})

test('the owner chain walks locally and hands over at the host boundary', async (t) => {
    const topology = await loaded('plant-f')
    await topology.declare('machine', { owner: { peer: 'plant-f', instance: 'line' } })
    await topology.declare('line', { owner: { peer: 'mes-server', instance: 'batch-4711' } })

    const walked = topology.ownerChain('machine')
    t.deepEqual(
        walked.chain.map((ref) => ref.instance),
        ['machine', 'line']
    )
    t.deepEqual(walked.continuesAt, { peer: 'mes-server', instance: 'batch-4711' }, 'the continuation is a ref for whoever holds that host')
    t.is(walked.validity.status, 'valid')
})

test('ids refuse control characters at the boundary; labels stay free Unicode', async (t) => {
    await t.throwsAsync(loaded('plant-g', { place: ['site\u00007'] }), { message: /control character/ })
    const topology = await loaded('plant-g')
    await t.throwsAsync(topology.declare('oven\u0000cell'), { message: /control character/ })
    await t.throwsAsync(topology.declare('oven', { label: 'bad\u001blabel' }), { message: /control character/ })

    // The label the drawings actually use, dots and slashes and all - never an address, so free.
    const labelled = await topology.declare('gt11', { label: 'AS01-GT11/2.5, Tilluft (våning 3)' })
    t.is(labelled.label, 'AS01-GT11/2.5, Tilluft (våning 3)')
})

test('mutating before load is refused, because durable epochs must be read before they are trusted', async (t) => {
    const topology = new HostTopology('plant-h')
    await t.throwsAsync(topology.declare('early'), { message: /not loaded yet/ })
})

test('a durable store keeps epochs across a restart; the volatile default rotates and says so', async (t) => {
    const path = join(tmpdir(), `msgrpc-topology-${run}.json`)
    try {
        const first = await loaded('plant-i', { store: new JsonFileTopologyStore(path) })
        const oven = await first.declare('oven', { owner: { peer: 'mes', instance: 'batch-1' } })
        t.is(first.capabilities().durability, 'durable')

        // The restart: a new process reads the same store. Every epoch must be exactly what was
        // committed - a restart that rotated epochs would fence out every standing owner.
        const revived = await loaded('plant-i', { store: new JsonFileTopologyStore(path) })
        const reloaded = revived.get('oven')!
        t.is(reloaded.ownerEpoch, oven.ownerEpoch)
        t.is(reloaded.parentEpoch, oven.parentEpoch)
        t.deepEqual(reloaded.version, oven.version)

        const volatileHost = await loaded('plant-i')
        t.is(volatileHost.capabilities().durability, 'volatile')
        t.is(volatileHost.get('oven'), undefined, 'nothing survived, and the capabilities record already said it would not')
    } finally {
        await rm(path, { force: true })
    }
})

test('the external store notifies on commit and holds a stable snapshot between them', async (t) => {
    const topology = await loaded('plant-j')
    const declared = await topology.declare('pump')
    const store = topology.externalStore('pump')

    const first = store.getSnapshot()
    t.is(store.getSnapshot(), first, 'reference-stable between commits, which is what useSyncExternalStore needs')

    let notified = 0
    const unsubscribe = store.subscribe(() => notified++)
    await topology.update('pump', { owner: { peer: 'plant-j', instance: 'line' } }, { expectedVersion: declared.version })
    t.is(notified, 1)
    t.not(store.getSnapshot(), first, 'a commit replaces the snapshot whole')

    unsubscribe()
    await topology.update('pump', { owner: null }, { expectedVersion: store.getSnapshot()!.version })
    t.is(notified, 1, 'an unsubscribed listener hears nothing')
})

test('describe() carries the records and the capabilities, so a console can derive the trees', async (t) => {
    const server = new RpcServer({
        name: peer('host3877'),
        transports: [{ port: 3877 }],
        exposeIntrospection: true,
        topology: { place: ['site-7', 'building-b'], label: 'Building B' }
    })
    await server.ready()
    await server.topology.declare('oven', { label: 'Ugn 3', owner: { peer: 'mes', instance: 'batch-1' } })
    server.exposeClassInstance({ ping: async () => 'pong' }, 'oven')

    const client = new RpcClient('http://localhost:3877', { name: peer('viewer3877'), defaultTarget: peer('host3877') })
    await client.ready()
    const described = await (await client.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc')).describe()

    t.deepEqual(described.host?.root, { peer: peer('host3877'), instance: HOST_ROOT })
    t.deepEqual(described.host?.place, ['site-7', 'building-b'])
    t.is(described.host?.label, 'Building B')
    t.is(described.host?.capabilities.authorityScope, 'host')
    t.is(described.host?.capabilities.durability, 'volatile', 'no store was given, and the description says so rather than implying more')

    const oven = described.namespaces.find((namespace) => namespace.name === 'oven')
    t.deepEqual(oven?.topology?.owner, { peer: 'mes', instance: 'batch-1' })
    t.is(oven?.topology?.label, 'Ugn 3')
    t.truthy(oven?.topology?.ownerEpoch)

    await client.close()
    await server.close()
})

test('a deep chain is depth-exceeded, distinguishable from a cycle', async (t) => {
    const topology = await loaded('plant-k')
    let previous: RpcTopologyRecord | undefined
    for (let level = 0; level < 140; level++) {
        previous = await topology.declare(`level-${level}`, level === 0 ? {} : { parent: { peer: 'plant-k', instance: `level-${level - 1}` } })
    }
    const walked = topology.physicalPath(previous!.ref.instance)
    t.is(walked.validity.status, 'depth-exceeded', 'a guard, not a verdict: the resource bound is named as itself')
})

test('an owner fence refuses the previous generation, and fails closed where nothing is recorded', async (t) => {
    const server = new RpcServer({ name: peer('host3878'), transports: [{ port: 3878 }] })
    await server.ready()
    await server.topology.declare('oven', { owner: { peer: 'mes', instance: 'batch-1' } })
    class Oven {
        async setMode(mode: string) {
            return mode
        }
    }
    class Pinger {
        async ping() {
            return 'pong'
        }
    }
    server.exposeClassInstance(new Oven(), 'oven')
    server.exposeClassInstance(new Pinger(), 'undeclared')

    const client = new RpcClient('http://localhost:3878', { name: peer('caller3878'), defaultTarget: peer('host3878') })
    await client.ready()
    const observed = server.topology.get('oven')!

    // The fence holds while the generation the caller observed is the generation that rules.
    const oven = await client.proxy<{ setMode(mode: string): Promise<string>; $with(o: { ownerEpoch: string }): { setMode(mode: string): Promise<string> } }>('oven')
    t.is(await oven.$with({ ownerEpoch: observed.ownerEpoch }).setMode('auto'), 'auto')

    // The owner is reassigned - a maintenance job takes the unit - and the old world's fence
    // finds a new generation: refused, with re-reading the topology as the named way forward.
    await server.topology.update('oven', { owner: { peer: 'mes', instance: 'job-9' } }, { expectedVersion: observed.version })
    const stale = await t.throwsAsync(oven.$with({ ownerEpoch: observed.ownerEpoch }).setMode('manual'))
    t.regex(String(stale?.message), /OwnershipChanged/)
    t.is(await oven.$with({ ownerEpoch: server.topology.get('oven')!.ownerEpoch }).setMode('manual'), 'manual', 'the new generation commands freely')

    // A fence against an instance nobody recorded fails closed: asserting a generation that
    // cannot be verified must not become running anyway.
    const bare = await client.proxy<{ ping(): Promise<string>; $with(o: { ownerEpoch: string }): { ping(): Promise<string> } }>('undeclared')
    const unverifiable = await t.throwsAsync(bare.$with({ ownerEpoch: 'e-imagined' }).ping())
    t.regex(String(unverifiable?.message), /no topology record/)
    t.is(await bare.ping(), 'pong', 'an unfenced call is the ordinary case and stays one')

    await client.close()
    await server.close()
})

test('remote topology mutation is refused by default, and gated by authorize when enabled', async (t) => {
    const admin = peer('admin3879')
    const bystander = peer('bystander3879')
    const server = new RpcServer({
        name: peer('host3879'),
        transports: [{ port: 3879 }],
        exposeIntrospection: true,
        topology: { allowRemoteMutation: true },
        // The authorization is the ordinary authorize, and restructuring is its own grant.
        authorize: (context) => context.method !== 'updateTopology' || context.source === admin
    })
    await server.ready()
    await server.topology.declare('oven')

    const adminClient = new RpcClient('http://localhost:3879', { name: admin, defaultTarget: peer('host3879') })
    const otherClient = new RpcClient('http://localhost:3879', { name: bystander, defaultTarget: peer('host3879') })
    await adminClient.ready()
    await otherClient.ready()
    type TopologyApi = {
        topology(): Promise<{ records: RpcTopologyRecord[] } | undefined>
        updateTopology(instance: string, patch: object, mutation: object): Promise<RpcTopologyRecord>
    }
    const asAdmin = await adminClient.proxy<TopologyApi>('msgrpc')
    const asOther = await otherClient.proxy<TopologyApi>('msgrpc')

    // Reading rides the introspection gate; the trees a console draws come from here.
    const read = await asOther.topology()
    t.true((read?.records ?? []).some((record) => record.ref.instance === 'oven'))

    const refused = await t.throwsAsync(asOther.updateTopology('oven', { owner: { peer: 'mes', instance: 'batch-2' } }, { expectedVersion: server.topology.get('oven')!.version }))
    t.regex(String(refused?.message), /Forbidden/)

    const committed = await asAdmin.updateTopology('oven', { owner: { peer: 'mes', instance: 'batch-2' } }, { expectedVersion: server.topology.get('oven')!.version })
    t.deepEqual(committed.owner, { peer: 'mes', instance: 'batch-2' })

    // And with the opt-in absent, there is no surface at all, whoever asks.
    const closed = new RpcServer({ name: peer('shut3879'), transports: [{ port: 3880 }], exposeIntrospection: true })
    await closed.ready()
    await closed.topology.declare('oven')
    const viewer = new RpcClient('http://localhost:3880', { name: peer('viewer3879'), defaultTarget: peer('shut3879') })
    await viewer.ready()
    const shut = await t.throwsAsync((await viewer.proxy<TopologyApi>('msgrpc')).updateTopology('oven', {}, { expectedVersion: closed.topology.get('oven')!.version }))
    t.regex(String(shut?.message), /does not accept remote topology mutation/)

    await adminClient.close()
    await otherClient.close()
    await viewer.close()
    await server.close()
    await closed.close()
})
