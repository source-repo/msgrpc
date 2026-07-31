# Topology: parent, owner, place

Every host answers for where its components sit, on two axes that answer different questions: `parent` is **physical** location — the cabinet, the cell, the building — and `owner` is **logical** scope — the batch, the line, the maintenance job. Identity depends on neither: a ref is `{ peer, instance }`, stable across reparenting, and paths are derived display data — never wire addresses, never foreign keys. Ids address; labels display.

```typescript
const server = new RpcServer({
    name: 'machineHost',
    topology: { place: ['site-7', 'building-b'], label: 'Building B' }
})
await server.ready()

await server.topology.declare('oven', {
    parent: { peer: 'machineHost', instance: 'cell-3' },
    owner: { peer: 'mes', instance: 'batch-4711' },
    label: 'Ugn 3 (våning 2)'
})
```

`place` is declared at deployment beside the name — never in a class contract, since the same class is bolted into every building. `label` is free Unicode, exactly what the drawings say, never required unique. Every host has one *effective* root: a synthetic, durable `$host`, which carries the one permitted cross-host physical edge — root to root:

```typescript
await edge.topology.updateHost(
    { parent: { peer: 'plantHost', instance: '$host' } },
    { expectedVersion: edge.topology.get('$host')!.version }
)
```

## Federated, with the invariants where they can be afforded

There is no plant-wide authority: each host is the sole writer of its own components' outgoing edges, held with a version and per-link epochs under compare-and-set. Local physical invariants are *refused at commit* — local parents only, no self-links, no local cycle — because a single writer over local records can police them. Owner cycles, which cross hosts, are *detected at derivation* as invalid topology with the ring's path named, and anything authorization-shaped fails closed on them.

Every committed owner patch rotates `ownerEpoch` — A to B and back to A is two new generations. Epochs are durable where the store is:

```typescript
import { JsonFileTopologyStore } from '@source-repo/rpc'

new RpcServer({ topology: { store: new JsonFileTopologyStore('/var/lib/plant/topology.json') } })
```

A restart never rotates an epoch — a reboot that re-fenced every standing owner would be the fence failing at exactly the wrong moment. The volatile default advertises itself: `describe()` carries an `RpcTopologyCapabilities` record (`durability: 'volatile' | 'durable'`, cycles `detected`, authority scope `host`), so no deployment silently claims strength it lacks.

`physicalPath()` derives the display path, rooted at the declared place or the host id; `ownerChain()` walks the logical chain as far as this host can see it and hands over with `continuesAt` at the host boundary. The console draws both trees from what `describe()` carries.

## The owner fence

A call can choose to be fenced on the owner generation its caller observed:

```typescript
const record = server.topology.get('oven')!
await remote.$with({ ownerEpoch: record.ownerEpoch }).setMode('manual')
```

If the owner was reassigned while the command was in flight, queued, or retried, the target answers `OwnershipChanged`: certainly not run, and not to be blindly retried — the caller re-reads the topology and decides again under the new generation. A fence naming an instance the host keeps no record for fails closed. Checked at the door and again after any queue wait.

## Remote mutation is opt-in

Topology is normally declared by the code that stands nodes up. A host that wants to accept restructuring over the network opts in:

```typescript
new RpcServer({ topology: { allowRemoteMutation: true }, authorize })
```

`msgrpc.topology()` (behind the introspection gate) serves the records whole; `msgrpc.updateTopology(instance, patch, { expectedVersion })` mutates under mandatory CAS — no blind write, and a retry after an uncertain outcome fails the version check instead of applying twice. Every mutation passes `authorize()` with the instance and patch visible, which is where a plant names who may restructure it. Without the opt-in there is no mutation surface at all.
