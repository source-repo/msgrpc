# @source-repo/sparkplug

Sparkplug B integration for Source RPC networks.

This package is the open substrate for projecting selected Source RPC components as standard Sparkplug Edge Nodes, Devices and metrics. It starts with the protocol/session machinery the projection needs: the vendored Sparkplug B protobuf definition, topic helpers, birth/death payload builders and the Edge Node session sequence discipline.

The commercial product and tools around this will be named Source Spark. This package stays the open mechanism.

## Status

M1 and read-only M2 implementation. It can encode Sparkplug payloads, publish an Edge Node NBIRTH/NDEATH over MQTT, answer `Node Control/Rebirth` NCMD with a complete Node and Device rebirth sequence, gate Node and Device lifecycle on retained/live Primary Host `STATE`, validate Node and Device lifecycle rules, and project read-only Source RPC component snapshots as Sparkplug Devices.

The component runner publishes a complete `DBIRTH` from the first live snapshot, changed-only `DDATA`, `DDEATH` when the channel becomes stale or closes, and a complete `DBIRTH` when the component returns. Under backpressure it holds one in-flight and one latest pending snapshot per Device, then computes the coalesced diff against the last successfully handed-off state. The committed projection contract supplies the stable Device ID, metric map, datatypes, nullability, units, bounds, deadbands and maximum publish rate. Its compiler normalizes the file, allocates aliases across the entire Edge Node, and hashes the normalized contract together with the Source RPC schema fragments it reads.

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
- strict, versioned `sparkplug.projection.json` validation with a published JSON Schema
- canonical SHA-256 projection hashes including selected Source RPC contract fragments
- deterministic Edge-wide metric aliases, alias-only DATA metrics, per-metric timestamps and birth metadata properties
- bounded latest-wins coalescing with per-Device `maxPublishHz`, accumulated per-metric deadband and retry of a failed latest snapshot
- explicit per-value Sparkplug `Quality` mapping while a live channel still maps to Device lifecycle (`stale` remains `DDEATH`)
- broker-backed sequence-gap/NCMD convergence and Source RPC owner-churn identity coverage
- compile-time DBIRTH/DDATA packet estimates, runtime packet refusal and declared byte bounds for variable-length metrics
- `peerShape`-triggered projection revalidation with canonical-hash-controlled complete rebirth
- reproducible Eclipse Sparkplug TCK 3.0.0 Edge profile runner and committed baseline report

The read-only M2 slice is complete. No ingestion or command mapping exists yet.

## Dual MQTT sessions

Sparkplug and Source RPC cannot safely share one MQTT connection: an MQTT session has one Will, while Sparkplug requires an unretained NDEATH Will and Source RPC requires retained offline presence. `SourceSparkGateway` creates both connections with deterministic, non-overlapping identities and closes both as one runtime:

```ts
const gateway = await SourceSparkGateway.connect({
    url: 'mqtts://broker.example',
    runtimeId: 'source-edge-01',
    groupId: 'plant-a',
    edgeNodeId: 'source-rpc-gateway',
    rpc: { mqtt: { username: 'source-edge-01-rpc', password: rpcPassword } },
    sparkplug: { mqtt: { username: 'source-edge-01-sparkplug', password: sparkplugPassword } }
})

// gateway.rpc is the Source RPC principal; gateway.sparkplug.session is the Edge Node session.
```

This opens `source-edge-01-rpc` for `msgrpc/v2/...` and `source-edge-01-sparkplug` for `spBv1.0/...`. Production deployments should issue separate credentials or client certificates for the two identities. The runtime refuses a conflicting client ID, a non-clean Sparkplug session, or an MQTT option that replaces NDEATH.

[`docs/emqx-acl.conf`](./docs/emqx-acl.conf) is a fail-closed EMQX 5.x policy example for the Edge peer, SCADA Primary Host and an MCP gateway. MQTT ACLs can constrain the MCP gateway to Source RPC topics and target peers, but method-level capability checks still belong at the Source RPC server.

## TCK baseline

The package includes a reproducible development run of the official Eclipse Sparkplug TCK 3.0.0 Edge profile. It verifies the downloaded binary checksum, runs the official extension in a digest-pinned HiveMQ container, and records both the official raw log and a summary under [`tck/reports`](./tck/reports).

```sh
npm run tck:edge -w @source-repo/sparkplug
```

The committed baseline covers Session Establishment, Session Termination, Send Data, Send Complex Data, Receive Command, and Primary Host over MQTT 3.1.1 with zero failed assertions. MQTT 5 alternatives, Multiple Broker, Dataset, Template, and other optional groups are explicitly outside that run. This is engineering evidence, not an Eclipse Foundation compatibility claim or listing; see [`tck/README.md`](./tck/README.md) for prerequisites and pinned inputs.

## Projection contract

The contract is strict: unknown fields, unsafe topic/path segments, duplicate Device IDs or metric names, unsupported datatypes and inconsistent bounds are rejected. `sparkplug.projection.schema.json` is published with the package for editor validation; `compileSparkplugProjectionContract` performs the additional cross-field checks and must still be used before running a projection.

```json
{
    "$schema": "./node_modules/@source-repo/sparkplug/sparkplug.projection.schema.json",
    "schema": 1,
    "groupId": "plant-a",
    "edgeNodeId": "source-rpc-gateway",
    "maxPacketBytes": 1048576,
    "devices": [
        {
            "deviceId": "pump-7",
            "source": { "peer": "pump-controller", "component": "pump" },
            "maxPublishHz": 20,
            "metrics": [
                { "name": "Properties/Tag", "path": "props.tag", "datatype": "String", "maxBytes": 64 },
                {
                    "name": "State/Temperature",
                    "path": "state.temperature",
                    "qualityPath": "state.temperatureQuality",
                    "datatype": "Double",
                    "unit": "degC",
                    "minimum": -40,
                    "maximum": 180,
                    "deadband": 0.1
                }
            ]
        }
    ]
}
```

Compile the loaded JSON with only the extracted Source RPC contract fragments referenced by its metric paths. The editor-only `$schema` field is accepted and excluded from the normalized contract and hash:

```ts
const compiled = compileSparkplugProjectionContract(JSON.parse(await readFile('sparkplug.projection.json', 'utf8')), {
    sourceContractFragments: extractedPumpContract
})
```

`qualityPath`, when present, must resolve to `0` (BAD), `192` (GOOD), or `500` (STALE). A quality-only transition publishes DDATA even when the metric value is unchanged. This is distinct from a Source RPC component channel becoming `stale`: loss of the serving peer publishes `DDEATH` because the whole Device is no longer known live.

`maxPacketBytes` defaults to 1 MiB. `String`, `Text`, `Bytes` and `File` metrics require `maxBytes`; `UUID` defaults to 36 bytes. Compilation encodes worst-case complete DBIRTH and DDATA snapshots and refuses a Device that cannot fit one packet. The session repeats the check on every actual frame before MQTT handoff.

If the local MQTT handoff rejects, the runner keeps the latest failed snapshot without advancing its diff baseline. Call `await projection.retry()` after the transport is available again. A Host that misses a QoS 0 DATA packet detects the global sequence gap and restores complete current Node and Device births through `Node Control/Rebirth`.

## Source RPC component

```ts
import { RpcClient } from '@source-repo/rpc'
import {
    compileSparkplugProjectionContract,
    MqttSparkplugEdgeNodeSession,
    SparkplugComponentProjectionRunner,
    SparkplugSourceRpcProjectionRevalidator,
    sourceRpcComponentStore
} from '@source-repo/sparkplug'

interface Pump {
    readonly props: { tag: string }
    readonly state: { running: boolean; temperature: number; temperatureQuality: 0 | 192 | 500 }
}

const compiled = compileSparkplugProjectionContract(projectionContract, {
    sourceContractFragments: extractedPumpContract
})
const device = compiled.devices[0]!

const client = new RpcClient('mqtt://localhost:1883', { name: 'sparkplug-gateway' })
await client.ready()
const pump = await client.component<Pump>(device.source.component, device.source.peer)
const edge = await MqttSparkplugEdgeNodeSession.connect({
    url: 'mqtt://localhost:1883',
    groupId: compiled.contract.groupId,
    edgeNodeId: compiled.contract.edgeNodeId,
    maxPacketBytes: compiled.maxPacketBytes
})

const projection = new SparkplugComponentProjectionRunner({
    session: edge.session,
    store: sourceRpcComponentStore(pump),
    definition: device
})

await projection.start()

const revalidator = new SparkplugSourceRpcProjectionRevalidator({
    client,
    session: edge.session,
    compiled,
    recompile: async () =>
        compileSparkplugProjectionContract(projectionContract, {
            sourceContractFragments: await loadExtractedPumpContract()
        }),
    onError: reportProjectionError
})
revalidator.start()
```

`peerShape` is only a revalidation signal. If recompilation returns the same canonical hash, nothing is published. A changed hash with the same frozen mapping publishes NBIRTH and complete current DBIRTHs; a changed mapping is refused until the projection runners are restarted.
