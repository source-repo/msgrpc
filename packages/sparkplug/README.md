# @source-repo/sparkplug

Sparkplug B integration for Source RPC networks.

This package is the open substrate for projecting selected Source RPC components as standard Sparkplug Edge Nodes, Devices and metrics. It starts with the protocol/session machinery the projection needs: the vendored Sparkplug B protobuf definition, topic helpers, birth/death payload builders and the Edge Node session sequence discipline.

The commercial product and tools around this will be named Source Spark. This package stays the open mechanism.

## Status

Early M1/M2 implementation. It can encode Sparkplug payloads, publish an Edge Node NBIRTH/NDEATH over MQTT, answer `Node Control/Rebirth` NCMD with a complete Node and Device rebirth sequence, observe retained/live Primary Host `STATE`, validate Node and Device lifecycle rules, and project read-only Source RPC component snapshots as Sparkplug Devices.

The component runner publishes a complete `DBIRTH` from the first live snapshot, one changed-only `DDATA` for each projected snapshot commit, `DDEATH` when the channel becomes stale or closes, and a complete `DBIRTH` when the component returns. The Device ID is supplied explicitly and is therefore independent of Source RPC owner reassignment.

## First milestone

- vendored `sparkplug_b.proto`
- committed generated TypeScript protobuf descriptors
- protobuf encode/decode helpers for the M1 metric types
- TypeScript substrate for topics, sequence numbers and birth/death payloads
- MQTT Edge Node session shell with clean session, NDEATH Will, NBIRTH publish, NCMD rebirth handling, Primary Host `STATE` observation and graceful NDEATH close
- tests for topic validation, `seq` wrap, `bdSeq` reuse, broker-backed NBIRTH/NDEATH delivery, broker-backed `Node Control/Rebirth`, retained/live Host `STATE`, graceful reconnect `bdSeq` advance and ungraceful Will delivery
- first Host-side validator for NBIRTH/NDEATH ordering, `bdSeq`, rebirth `seq` and retained lifecycle message checks
- read-only Node and Device metric projection helpers with explicit paths and publish-state diffing
- Device lifecycle projection for Source RPC-style snapshots (`props`, `state`, `status`, `epoch`, `revision`)
- a direct adapter from an `RpcComponentProxy` to the projection store
- one global queued `seq` stream across NBIRTH, DBIRTH, NDATA, DDATA and DDEATH
- Host-side validation of shared sequence order and Device birth/data/death ordering

No ingestion or command mapping exists yet. The next M2 step is the committed `sparkplug.projection.json` contract format with validation, canonical hashing, deterministic aliases, units and bounds.

## Source RPC component

```ts
import { RpcClient } from '@source-repo/rpc'
import { MqttSparkplugEdgeNodeSession, SparkplugComponentProjectionRunner, sourceRpcComponentStore } from '@source-repo/sparkplug'

interface Pump {
    readonly props: { tag: string }
    readonly state: { running: boolean; temperature: number }
}

const client = new RpcClient('mqtt://localhost:1883', { name: 'sparkplug-gateway' })
await client.ready()
const pump = await client.component<Pump>('pump', 'pump-controller')
const edge = await MqttSparkplugEdgeNodeSession.connect({
    url: 'mqtt://localhost:1883',
    groupId: 'plant-a',
    edgeNodeId: 'source-rpc-gateway'
})

const projection = new SparkplugComponentProjectionRunner({
    session: edge.session,
    deviceId: 'pump-7',
    store: sourceRpcComponentStore(pump),
    mappings: [
        { path: 'props.tag', name: 'Properties/Tag' },
        { path: 'state.running', name: 'State/Running' },
        { path: 'state.temperature', name: 'State/Temperature' }
    ]
})

await projection.start()
```
