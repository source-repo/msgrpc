# MQTT Sparkplug B Industrial Standard

## Prompt:
8/1/2026, 3:03:40 PM

Can we encapsulate Source RPC in Sparkplug B?

## Response:
8/1/2026, 3:03:41 PM

# Yes-but as a Sparkplug façade, not merely as a hidden tunnel

A Source RPC message can technically be encapsulated inside Sparkplug B. Sparkplug B’s payload includes an optional `uuid` identifying a custom schema and a `body` containing arbitrary binary data; Sparkplug also defines a `Bytes` metric type. That is enough to carry a complete Source RPC frame. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

But there are two very different products hiding behind the word “encapsulate”:

1. **Opaque tunnelling:** Sparkplug carries a private Source RPC byte frame that only Daritas understands.
2. **Native projection:** Source Edge components appear to ordinary Sparkplug hosts as Edge Nodes, Devices, metrics, state and commands.

The second is considerably more valuable commercially.

> **Recommended architecture: Sparkplug outside; Source RPC inside.**

```text
SCADA / MES / historian / standard MQTT tools
                    │
                 Sparkplug B
                    │
        ┌───────────────────────────┐
        │ Sparkplug projection and │
        │ command-policy gateway    │
        └───────────────────────────┘
                    │
                 Source RPC
                    │
     Source Edge components, MCP, queues,
     browser peers, PLC and runtime adapters
```

Source RPC remains the rich executable component network. Sparkplug becomes the standard industrial interoperability surface.

## Why the models fit surprisingly well

Sparkplug defines a fixed topic structure:

```text
spBv1.0/<group>/<message-type>/<edge-node>/<device>
```

with `NBIRTH`, `DBIRTH`, `NDATA`, `DDATA`, `NCMD`, `DCMD`, death certificates and host state. Its purpose is discovery, metric exchange, connection-state awareness and commands between Host Applications, Edge Nodes and Devices. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

The Source RPC component model has already moved in a compatible direction:

- synchronous reads from cached `props` and `state`;
- explicit asynchronous typed methods for changes;
- observable full state snapshots;
- stable component identities;
- clear lifecycle state.

That separation was introduced precisely because raw remote properties have no command intent, metadata or asynchronous failure boundary. `Extending Soure RPC.pdf`

A natural mapping is:

| Source Edge / Source RPC | Sparkplug B representation |
|---|---|
| One Source Edge runtime or gateway | Sparkplug Edge Node |
| Selected externally meaningful component | Sparkplug Device |
| Component class or profile | Sparkplug Template, where useful |
| Stable, read-only `props` | DBIRTH/NBIRTH metadata, properties or read-only metrics |
| Initial component state | DBIRTH/NBIRTH metric values |
| Later state changes | DDATA/NDATA metric updates |
| Idempotent setter-like method | Writable metric through DCMD/NCMD |
| Component online/offline lifecycle | BIRTH/DEATH lifecycle |
| Low-rate transient event | Transient DDATA/NDATA metric |
| Queue state | Queue depth, saturation and worker-health metrics |
| Source RPC parent/owner refs | Read-only metadata metrics or properties |

Sparkplug Templates are especially relevant for repeated component types such as pumps, valves or identical C modules: a Template Definition can describe the metric members and Template Instances can represent the individual units. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

## Do not expose every Source RPC component as a Sparkplug Device

Sparkplug has a comparatively shallow structural model:

```text
Group
└─ Edge Node
   └─ Device
```

Source RPC now has richer physical and logical graphs, arbitrary owners and stable identities independent of location. Trying to force that entire model into Sparkplug topics would lose information and cause unnecessary BIRTH/DEATH churn.

Instead:

- project only components useful to external plant systems;
- retain a stable Sparkplug Device ID;
- expose physical parent, logical owner and owner epoch as metadata when useful;
- never change a Device ID merely because its logical owner changed;
- leave the complete graph in Source Assess and Source RPC.

This is also a good security boundary. An internal helper component, queue worker or MCP service should not automatically become visible to the plant SCADA system.

# Native command mapping

Sparkplug commands are not general RPC. An `NCMD` or `DCMD` writes a metric. The usual sequence is:

```text
Host writes desired metric through DCMD
        ↓
Edge Node invokes native operation
        ↓
Device or component changes
        ↓
Edge Node reports resulting value through DDATA
```

Sparkplug permits custom command endpoints to be declared in BIRTH, but their meaning is application-specific. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

This maps well to a method such as:

```ts
@rpc({
  semantics: 'idempotent-command',
})
async setSetpoint(bar: number): Promise<void>;
```

A proposed adapter API might look like:

```ts
const projection = new SparkplugProjection({
  groupId: 'plant-a',
  edgeNodeId: 'source-edge-01',
  rpc,
});

projection.exposeDevice(pumpRef, {
  deviceId: 'pump-7',

  metrics: {
    'Pressure/ActualBar': metric.double({
      read: state => state.actualPressureBar,
    }),

    Running: metric.boolean({
      read: state => state.running,
    }),

    'Setpoint/Bar': metric.writableDouble({
      read: state => state.setpointBar,

      write: async (pump, value) => {
        await pump.setSetpoint(value);
      },
    }),
  },
});
```

The `write` mapping must be an explicit allowlist. It must never be generated automatically from every public Source RPC method.

### Methods that map well

- setpoints;
- modes;
- resettable flags;
- acknowledged alarms;
- idempotent configuration changes;
- reboot or rebirth commands;
- simple bounded actions with clear reported state.

### Methods that should normally remain Source RPC

- parameterized queries;
- methods returning complex results;
- long-running workflows;
- methods with typed application errors;
- calls requiring deadlines or cancellation;
- non-repeatable commands;
- commands requiring durable idempotency;
- calls where `UnknownOutcome` matters;
- arbitrary peer-to-peer calls.

Source RPC explicitly distinguishes queries, idempotent commands and non-repeatable commands, and distinguishes a definite transport failure from losing the answer after a command may have executed. Sparkplug has no standard equivalent for those RPC result semantics. ([GitHub](https://github.com/source-repo/rpc))

For native Sparkplug commands, successful completion should normally be confirmed by the resulting state update. A Daritas-specific profile could additionally publish:

```text
Command/Last/RequestId
Command/Last/Status
Command/Last/Error
Command/Last/CompletedAt
```

but these would be Daritas conventions, not generic Sparkplug RPC.

# Why a complete transparent tunnel is imperfect

## 1. Sparkplug is asymmetric; Source RPC is symmetric

Sparkplug primarily models Host Applications commanding Edge Nodes and Devices, while Edge Nodes publish state to hosts. Source RPC deliberately permits any peer-including a browser-hosted service-to call another peer without knowing its underlying transport. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

A complete Source RPC network therefore cannot be mapped directly onto Sparkplug roles without introducing a gateway or designated Host Application. That gateway can route tunneled frames, but the result is no longer native peer-to-peer Sparkplug semantics.

## 2. The delivery semantics differ

Sparkplug requires `NDATA`, `DDATA`, `NCMD`, `DCMD` and BIRTH messages to use MQTT QoS 0 and not be retained. Source RPC currently defaults its MQTT request/reply/event traffic to QoS 1, with request IDs and duplicate suppression. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

Consequently, a strictly conforming Sparkplug tunnel cannot preserve the current Source RPC transport semantics unchanged:

```text
Source RPC MQTT transport     QoS 1 / at-least-once transport
Sparkplug command and data    QoS 0 / best-effort transport
```

An inner Source RPC protocol could retry application messages and use durable idempotency, but:

- more calls will end in `UnknownOutcome`;
- responses may be lost;
- temporary subscribers cannot rely on broker queueing;
- a transient response is not recoverable through Sparkplug rebirth;
- the implementation becomes a new Source RPC transport rather than a simple wrapper.

That does not make it unusable. It makes it unsuitable as the default route for safety-relevant or non-repeatable RPC.

## 3. The current Source RPC MQTT payload is not a complete frame

In the current MQTT 5 wire format, the payload is only the method argument array. Source, kind, path, method, contract version and TTL are MQTT properties; correlation and reply destination use MQTT 5 Correlation Data and Response Topic. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md))

Therefore this is insufficient:

```ts
sparkplugBody = sourceRpcMqttPayload;
```

A tunnel needs a new transport-neutral inner envelope:

```ts
interface SourceRpcTunnelFrame {
  readonly version: 1;

  readonly kind:
    | 'call'
    | 'result'
    | 'error'
    | 'event';

  readonly requestId: string;

  readonly source: RpcComponentRef;
  readonly target: RpcComponentRef;

  readonly path?: string;
  readonly method?: string;
  readonly event?: string;

  readonly ttlMs?: number;
  readonly contractVersion?: string;
  readonly idempotencyKey?: string;

  readonly contentType:
    | 'application/msgpack'
    | 'application/json';

  readonly payload: Uint8Array;

  readonly signature?: Uint8Array;
}
```

The alternative is for the Sparkplug gateway to terminate Source RPC and create a fresh Source RPC call internally. That is simpler, but the gateway then becomes a trusted security boundary rather than a transparent relay.

## 4. Lifecycle semantics conflict on one MQTT session

A Sparkplug Edge Node must register its `NDEATH` as its MQTT Will, with QoS 1 and `retain=false`. Source RPC currently uses a retained offline presence message as its Will and retained online/offline presence for peer discovery. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

An MQTT connection carries one Will topic and payload, so one connection cannot directly implement both independent Will schemes. ([OASIS Open](https://docs.oasis-open.org/mqtt/mqtt/v5.0/cos01/mqtt-v5.0-cos01.pdf))

The clean initial implementation is therefore two logical MQTT sessions, even when both use the same broker:

```text
MQTT client: source-edge-01-sparkplug
  topics: spBv1.0/...
  will:   NDEATH
  role:   standard plant interoperability

MQTT client: source-edge-01-rpc
  topics: msgrpc/v2/...
  will:   retained Source RPC offline presence
  role:   rich Source RPC network
```

This costs one extra broker connection and avoids compromising either protocol.

Later, a dedicated `SparkplugTransport` could replace Source RPC presence with Sparkplug lifecycle, but that is a deeper protocol project and not needed for the commercial integration.

## 5. Sparkplug expects a session schema

An NBIRTH or DBIRTH must declare all metrics that the Edge Node or Device will publish during that Sparkplug session. Metrics may be added dynamically, but doing so requires a new BIRTH sequence. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

That fits a stable exported component profile, but not an unrestricted RPC surface whose methods and events appear arbitrarily at runtime.

The adapter should therefore freeze a **Sparkplug projection contract** for each session. A changed exported surface causes a controlled rebirth.

# An optional opaque tunnel

There may still be installations where a private tunnel is useful-for example, a network policy allows only the Sparkplug namespace or the customer wants one MQTT integration endpoint.

The most conformant shape would be to declare fixed `Bytes` metrics in BIRTH:

```text
SourceRPC/Request
SourceRPC/Response
SourceRPC/Event
```

Then:

```text
Host → DCMD
  SourceRPC/Request = <encoded SourceRpcTunnelFrame>

Edge → DDATA
  SourceRPC/Response = <encoded SourceRpcTunnelFrame>
```

For responses and events, `is_transient=true` tells compatible consumers that the metric is of interest but should not be retained as an ordinary historian tag. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

The request frame must contain its own:

- request ID;
- source and target;
- method and path;
- deadline;
- content type;
- arguments;
- idempotency information;
- result or error;
- signature.

This should be documented as:

> **Source RPC tunnel profile over Sparkplug B**

not as native Sparkplug RPC.

A normal Sparkplug host would discover the three byte metrics but would not understand their contents. Only Daritas-aware peers would participate.

# Security boundary

The Sparkplug projection should become the concrete firewall between standard plant connectivity and the richer MCP/Source RPC environment:

```text
Sparkplug command
       │
       ▼
Broker ACL
       │
       ▼
Sparkplug projection allowlist
       │
       ▼
Source RPC authorization
       │
       ▼
Typed component method
```

Sparkplug explicitly leaves command security to MQTT ACLs, Host Application controls and Edge Node application policy. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

The adapter should therefore:

- expose no method by default;
- allowlist each writable metric;
- restrict native mapping primarily to idempotent commands;
- validate ranges and units before invoking Source RPC;
- preserve Source RPC deadlines and owner fences where applicable;
- record the Sparkplug source/gateway identity;
- never treat arbitrary metric metadata as authenticated user identity;
- publish command result diagnostics without leaking internal stack traces;
- make read-only mode an easy deployment option.

This is a much stronger marketing claim than merely putting proprietary bytes in a standard payload:

> **Source Edge exposes an intentionally limited, standards-based industrial interface while its AI and engineering services remain behind a controlled policy boundary.**

# Recommended implementation order

## 1. Read-only Sparkplug projection

Build this first:

- standard NBIRTH/NDEATH;
- DBIRTH/DDEATH for selected components;
- component props and state as metrics;
- report-by-exception DDATA;
- rebirth handling;
- stable Device IDs;
- timestamps, aliases and bounded metric names;
- no plant commands.

This already demonstrates useful integration with SCADA, MES, historians and Source Assess.

## 2. Source Assess integration

Let Source Assess consume the Sparkplug projection and connect:

```text
assessed behaviour
        ↕
live Sparkplug metrics and lifecycle
        ↕
reviewed operational evidence
```

This directly strengthens the revenue product: the assessment can remain current using an open industrial interface.

## 3. Explicit safe command mappings

Add writable metrics only for:

- idempotent methods;
- bounded values;
- methods with observable reported state;
- commands approved in deployment policy.

Test the full command-confirmation flow rather than merely testing that a DCMD message arrives.

## 4. Templates and component profiles

Generate Sparkplug Templates from deliberately exported component profiles-not automatically from every TypeScript class.

## 5. TCK and external interoperability

Before marketing the product as **Sparkplug Compatible**, run the official TCK and follow the Sparkplug self-certification and listing process. The Eclipse process specifically ties compatibility claims and Sparkplug branding to TCK results and certification requirements. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/tck-process/))

Until then, safe wording is:

- “Sparkplug B integration”
- “Native Sparkplug B Edge Node and Device projection”
- “Exposes standard Sparkplug metrics and commands”

## 6. Opaque RPC tunnel only when demanded

Build the byte tunnel only when a paid deployment has a concrete need that the native projection cannot satisfy.

# Recommended product statement

> **Source Edge uses Sparkplug B as its standard plant-facing interoperability layer. Selected Source Edge components appear as discoverable Sparkplug Edge Nodes and Devices, with current state and carefully controlled commands. Source RPC remains the richer internal fabric for typed orchestration, browser peers, engineering tools and MCP.**

That is both technically honest and commercially stronger than saying Source RPC has merely been wrapped inside Sparkplug.

The concise architectural decision is:

> **Project semantics first; tunnel frames only as an optional private extension.**

---

**Sources:**

- [https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)
- [https://github.com/source-repo/rpc](https://github.com/source-repo/rpc)
- [https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md](https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md)
- [https://docs.oasis-open.org/mqtt/mqtt/v5.0/cos01/mqtt-v5.0-cos01.pdf](https://docs.oasis-open.org/mqtt/mqtt/v5.0/cos01/mqtt-v5.0-cos01.pdf)

## Prompt:
8/1/2026, 3:46:26 PM

The peer to peer limitation is drastic. It lobotomizes matt back to an old style topology. On the altar of simplified security. Maybe a good choice in reality. Does that mean we should also cancel that track and have a single master limitation in that environment. Or should we have a host side relay service solving peer to peer with the reduced performance that entails?

## Response:
8/1/2026, 3:46:28 PM

# Do not cancel peer-to-peer-cancel only the idea that Sparkplug must carry the whole mesh

Source RPC’s peer model is too central to Source Edge to discard. Its defining value is that named peers can both call and serve, regardless of whether they sit on MQTT, WebSocket, behind NAT, or in a browser. The existing Source RPC bus already demonstrates that a relay can preserve this logical peer model where direct routing is unavailable. ([GitHub](https://github.com/source-repo/rpc))

What I would abandon as a **default architecture** is:

> “Every Source RPC call must be translated into conformant Sparkplug messages.”

That produces poor RPC semantics and little external interoperability. Ordinary Sparkplug clients would still not understand the embedded Source RPC call.

The preferred rule remains:

> **Sparkplug is the standard plant-facing projection. Source RPC is the internal distributed execution fabric.**

## First, Sparkplug is not quite single-master

Sparkplug is asymmetric, but it does not require one global master for the entire plant:

- an Edge Node may designate one Primary Host Application;
- designating a Primary Host is optional;
- any number of additional Host Applications may monitor the infrastructure or act as standby;
- different Host Applications may each be primary for different subsets of Edge Nodes.

Commands are nevertheless defined in the Host Application → Edge Node/Device direction through `NCMD` and `DCMD`. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

So the practical model can be:

```text
Plant monitoring host
        │
        ├─ Cell A command host ── Edge Nodes A1, A2, A3
        │
        └─ Cell B command host ── Edge Nodes B1, B2
```

It need not be:

```text
One master controlling the entire factory
```

More importantly, Sparkplug is still publish/subscribe for data. Multiple Host Applications can consume state. The main asymmetry is **who originates standard commands**, not who may observe the system.

# Recommended deployment profiles

## 1. Managed Source Edge network: retain direct logical peer-to-peer

This should be the normal Source Edge architecture:

```text
                         MQTT broker
                 ┌────────────┴────────────┐
                 │                         │
       Source RPC namespace         Sparkplug namespace
          source-rpc/...                spBv1.0/...
                 │                         │
       peer-to-peer calls,         SCADA, MES, historian,
       events and queues           standard metrics/commands
```

The same broker can carry both, with separate identities, clients, topic namespaces and ACL policies.

This gives you:

- full Source RPC peer semantics;
- standard Sparkplug interoperability;
- no application-level host relay;
- no additional network listener;
- explicit firewall and authorization boundaries;
- a clean distinction between the rich internal system and the exported industrial interface.

The security argument does not require sacrificing peer-to-peer. Sparkplug itself does not prescribe a normative security model; it defers authentication, authorization and encryption to MQTT, TCP/IP and deployment policy. The specification specifically discusses broker ACLs restricting which topics each client can publish and subscribe to. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

Source RPC already supplements this with authenticated peer names, per-frame signing and replay protection. ([GitHub](https://github.com/source-repo/rpc))

Therefore, in an environment Daritas controls, the security policy can be:

```text
SCADA host:
  read spBv1.0/#
  write approved NCMD/DCMD topics

Source Edge peer A:
  write its own Sparkplug data topics
  read its approved Sparkplug command topics

  write Source RPC frames as peer A
  read Source RPC calls addressed to peer A

MCP gateway:
  no direct production I/O topics
  only explicitly exposed Source RPC capabilities
```

That is not inherently less secure than central command routing. It is more detailed to administer, but it is also more expressive.

## 2. Strict Sparkplug deployment: host-mediated commands

Some customers will insist that:

- only `spBv1.0/...` is allowed;
- Edge Nodes cannot publish or subscribe to private application namespaces;
- command authority must reside in an approved Host Application;
- every cross-system command must pass one audit and policy point.

In that profile, accept the Sparkplug topology honestly:

```text
Source Edge components inside Edge Node A
                  │
                  │ local calls
                  ▼
             Edge Node A
                  │
             Sparkplug
                  │
        Source Edge Command Host
                  │
             Sparkplug
                  ▼
             Edge Node B
                  │
                  │ local calls
                  ▼
Source Edge components inside Edge Node B
```

This does **not** require the host to control every calculation or every I/O operation. Each Edge Node can remain autonomous:

- local components call each other directly;
- local real-time loops remain local;
- local safety behavior continues without the Host;
- state is published through Sparkplug;
- only cross-node commands and orchestration pass through the Host.

That is a reasonable industrial profile. It resembles hierarchical cell autonomy rather than an old PLC master polling every remote value.

I would describe it as:

> **One active command authority per control domain**

rather than “single master.”

# 3. Optional host relay: preserve the API where Sparkplug-only policy demands it

A Host-side relay is technically viable and should remain an optional compatibility profile.

The earlier extension discussion already anticipated a central RPC coordinator mapping an external routing key to a target component’s mailbox when the underlying transport cannot route directly. `Extending Soure RPC.pdf`

Application code could remain:

```ts
const oven = await client.proxy<Oven>(
  'oven',
  'cell-b',
);

await oven.setTemperature(180);
```

Deployment chooses the route:

```ts
type RpcRoute =
  | 'local'
  | 'direct'
  | 'host-relay';
```

The caller does not need a different service contract, but the deployment system must know that the call is relayed.

## A Sparkplug-only relay flow

When both source and target are Sparkplug Edge Nodes, a full request/reply path becomes approximately:

```text
Edge A DDATA: RPC request
        ↓
Host receives and authorizes
        ↓
Host DCMD: request to Edge B
        ↓
Edge B executes
        ↓
Edge B DDATA: response
        ↓
Host correlates and authorizes
        ↓
Host DCMD: response to Edge A
```

This is four application messages rather than the normal two-message Source RPC request/reply path.

The raw performance penalty may be acceptable for:

- configuration;
- diagnostics;
- recipe preparation;
- model queries;
- maintenance coordination;
- asynchronous engineering actions;
- low-frequency cross-cell workflows.

The more serious problem is **failure semantics**. Conformant Sparkplug `NDATA`, `DDATA`, `NCMD`, and `DCMD` traffic uses MQTT QoS 0. Commands are represented as metric writes, and responses normally appear as later reported state. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

A private relay would therefore need to reconstruct:

- request IDs;
- response correlation;
- absolute deadlines;
- source identity;
- owner fencing;
- authorization delegation;
- typed remote errors;
- duplicate handling;
- idempotency;
- `UnknownOutcome`;
- bounded in-flight requests;
- response expiry.

At that point it is no longer “simple Sparkplug encapsulation.” It is a **Source RPC relay protocol carried by Sparkplug metrics**.

That is legitimate, but it should be labelled as a Daritas extension rather than native Sparkplug RPC.

# What the relay must not do

The relay should follow the existing Source RPC distinction between relaying and brokering:

- do not queue ordinary calls for an offline peer;
- do not silently retry non-repeatable commands;
- do not execute a command after its deadline;
- do not convert a failed route into delayed execution;
- report `UnknownOutcome` when execution may have occurred but the answer was lost;
- use the separate Source Queue service when durable queued work is actually intended.

Source RPC’s existing documentation already states that relaying is not brokering and that nothing is queued for a disconnected peer. ([GitHub](https://github.com/source-repo/rpc))

That distinction becomes even more important with a central relay. Otherwise a temporary communication failure can turn into a late industrial command.

# Do not silently fall back from direct to relay

The route should be a deployment decision, not a hidden runtime optimization:

```ts
interface RpcRoutePolicy {
  readonly allowed:
    | readonly ['local']
    | readonly ['local', 'direct']
    | readonly ['local', 'direct', 'host-relay'];

  readonly maxEndToEndLatencyMs?: number;

  readonly requireDurableIdempotency?: boolean;
}
```

For example:

```ts
const deploymentPolicy = {
  'diagnostics.readLog': {
    allowed: ['local', 'direct', 'host-relay'],
  },

  'recipe.prepare': {
    allowed: ['local', 'direct', 'host-relay'],
    maxEndToEndLatencyMs: 2_000,
  },

  'motion.execute': {
    allowed: ['local', 'direct'],
  },

  'safety.trip': {
    allowed: ['local'],
  },
} satisfies Record<string, RpcRoutePolicy>;
```

A deployment should fail validation when a required method cannot be routed with the declared guarantees.

It should not silently say:

> “The direct route is unavailable, so I will send this motion command through a slower Host relay instead.”

# A dual-role peer is possible, but is probably the wrong answer

Technically, every Source Edge runtime could act as both:

- a Sparkplug Edge Node publishing its own state;
- a Sparkplug Host Application sending commands to other Edge Nodes.

Sparkplug permits multiple Host Applications, so this could recover logical peer-to-peer without a central relay. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

But it creates several problems:

- every peer needs Host-level command permissions;
- every peer must publish and maintain Host `STATE`;
- command ACLs become much more complex;
- every peer must understand the private request/response metrics;
- QoS 0 and metric-write semantics remain;
- the apparent simplification of Sparkplug security disappears;
- ordinary Sparkplug applications still cannot interpret the RPC extension.

It amounts to recreating Source RPC badly inside Sparkplug. A separate tightly controlled Source RPC MQTT namespace is cleaner.

# The decision I would make now

## Keep

- Source RPC peer-to-peer as the native Source Edge model.
- Sparkplug B projection for standard state, discovery, lifecycle and selected commands.
- A strict Host-mediated deployment profile for customers who demand it.
- Local autonomy and local direct calls inside each Edge Node or cell.

## Defer

- Transparent Source RPC tunnelling through Sparkplug.
- A generic Host-side P2P relay.
- Dual-role Edge Node/Host peers.
- Automatic direct-to-relay fallback.

## Build only after a paid use case

Add the Host relay when a customer says both:

1. “Only Sparkplug traffic may cross this boundary.”
2. “Components on opposite sides must still invoke each other using Source RPC semantics.”

At that point the requirement is real, and the allowed methods, expected latency, availability, identity delegation and audit requirements will be known.

# Final architecture

```text
                     Standard plant systems
                 SCADA / MES / Historian / OEM
                              │
                         Sparkplug B
                              │
                  ┌───────────┴───────────┐
                  │  policy / projection │
                  │      boundary         │
                  └───────────┬───────────┘
                              │
                    Source RPC peer fabric
                  ┌───────────┼───────────┐
                  │           │           │
                Cell A      Cell B     Browser/MCP
                  │           │
             local control local control
```

For a locked customer:

```text
Cell A ── Sparkplug ── Command Host ── Sparkplug ── Cell B
```

The concise decision is:

> **Do not reduce Source Edge to a master/slave system globally. Accept Host-mediated control as one constrained deployment profile. Keep a relay design available, but implement it only when a real Sparkplug-only customer needs cross-node RPC.**

That preserves the valuable architecture without forcing its full complexity into every industrial installation.

---

**Sources:**

- [GitHub - source-repo/rpc: Source RPC - One programming model for a network of peers · GitHub](https://github.com/source-repo/rpc)
- [Sparkplug 3.0.0: Sparkplug Specification](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)

## Prompt:
8/1/2026, 4:13:10 PM

When the site only allows the Sparkplug top level MQTT topic I think a single Source RPC broker node (a normal RpcServer)  with one transport for EACH device would do the relay as it is now. Supposing all RPC messages are sent via Sparkplug. But the delivery promises is a problem

## Response:
8/1/2026, 4:13:14 PM

> **Searching the web**
>
> [sparkplug-specification-3.0.0.pdf](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)
> [MQTT Version 5.0 | OASIS Standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
>
> **Evaluating relay semantics**
>
> I’m following the proposed single relay with one transport per device. The architecture seems workable, but Sparkplug’s QoS 0 delivery makes request, response, timeout, and duplicate handling explicit rather than reliably inherited from transport behavior.
>
> **Refining transport boundaries**
>
> I’m agreeing with the relay concept, while distinguishing logical peers from physical Sparkplug sessions. One session per Edge Node is usually cleaner; multiple device-level transports can still share that session and its sequencing state.
>
> **Strengthening delivery semantics**
>
> I’m treating Sparkplug as an unreliable envelope for the inner RPC protocol. The relay should preserve request IDs, deadlines, acknowledgments, deduplication, and explicit “accepted” versus “executed” outcomes, especially across multiple hops.
>
> **Choosing the transport profile**
>
> I’m separating namespace permission from strict Sparkplug conformance. If only the prefix is restricted, a private QoS 1 RPC extension preserves stronger delivery; strict Sparkplug requires application acknowledgments, retries, deduplication, and weaker outcome guarantees.
>
> **Refined relay transport and strengthened delivery semantics**
>
> 
>
> **Searching github source-repo rpc relay RpcServer transports**
>
>
> **Searched 2 websites**
>
> 
>
> Worked for 17m 49s

## Yes-this is probably the right Sparkplug-only architecture

The physical topology becomes a star, but the **Source RPC topology remains logically peer-to-peer**:

```text
Source RPC peer A
      │
      │ NDATA/DDATA
      ▼
┌──────────────────────────────┐
│ Sparkplug Host Application   │
│                              │
│ Sparkplug transport A ─┐     │
│ Sparkplug transport B ─┼─►   │
│ Sparkplug transport C ─┘     │
│                              │
│ normal relay-only RpcServer  │
└──────────────────────────────┘
      │
      │ NCMD/DCMD
      ▼
Source RPC peer B
```

That fits Source RPC naturally. A relay-only bus is already just an `RpcServer` exposing nothing, custom `Transport` implementations are supported, and relaying preserves named-peer addressing. ([GitHub](https://github.com/source-repo/rpc)) The extension discussion also anticipated this shape: a central RPC coordinator reads an external routing key and maps it to the appropriate receiving component or mailbox. `Extending Soure RPC.pdf`

I would make one implementation distinction:

> The host should have one MQTT client and a multiplexer, but expose one **virtual Source RPC transport per remote peer** to the `RpcServer`.

It should not need one actual MQTT connection per device.

The virtual transport boundary will often be one Sparkplug **Edge Node**, not every Sparkplug Device beneath it. If a Device independently hosts a Source RPC peer, one-per-Device is appropriate. Otherwise the Edge Node transport can route internally to all of its Source RPC components.

# The delivery problem is real

A plain mapping would weaken Source RPC substantially:

- `NDATA` and `DDATA` must be published at MQTT QoS 0.
- `NCMD` and `DCMD` must also be QoS 0.
- Data messages have an eight-bit Sparkplug sequence number, wrapping at 255.
- Command messages must not contain a sequence number.
- Sparkplug clients use clean sessions; for MQTT 5 they must use Clean Start with Session Expiry Interval zero. The broker therefore does not provide the persistent-session queueing that Source RPC normally uses. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

MQTT QoS 0 is explicitly at-most-once: there is no receiver acknowledgement and no protocol retry. A packet arrives once or not at all. ([OASIS Open](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html?utm_source=chatgpt.com))

The Sparkplug `seq` field can tell the Host that an Edge-to-Host data message was missed. It cannot recover the message, and it provides no equivalent protection in the Host-to-Edge command direction.

This is because Sparkplug fundamentally favours:

> **Current-state reconstruction through BIRTH and later updates**, rather than delivery of every transient message.

That is excellent for process values. It is insufficient for RPC intent and outcomes.

# Recommended solution: end-to-end retries, not relay custody

The cleanest first implementation is to keep the central `RpcServer` as a normal, mostly stateless relay and add reliability at the **Source RPC endpoints**.

The central rule should be:

> **For an RPC call, the final result or error is the acknowledgement.**

The flow becomes:

1. Peer A creates one stable Source RPC request ID.
2. A retains the complete request locally.
3. A sends it through its Sparkplug outbound metric.
4. The relay forwards the frame unchanged to B.
5. B deduplicates by request ID.
6. B executes it or attaches the duplicate to an already-running invocation.
7. B returns a result or error with the same request ID.
8. A removes the retained request only after receiving that final outcome.
9. Until then, A may retransmit the same request ID, bounded by the original deadline.

```text
A owns request
     │
     ├── CALL id=42 ──► relay ──► B
     │
     │             packet or response lost
     │
     ├── CALL id=42 ──► relay ──► B
     │                              │
     │                   duplicate id=42:
     │                   do not execute twice
     │                              │
     ◄────────── RESULT id=42 ──────┘
     
A now releases request
```

The relay must never replace the original request ID or re-originate the call under its own identity. Otherwise Source RPC’s duplicate suppression and idempotency store cannot recognise a retransmission as the same invocation.

For a long-running method, B can send an optional `received` or `accepted` control frame to slow A’s retransmission rate. That frame must **not** cause A to discard the request, and it must not extend the deadline.

## Why this lets the relay stay simple

Suppose the relay crashes after forwarding the request but before forwarding the response.

After it restarts:

- A still has the original request;
- A resends the same request ID;
- B either returns its cached result or handles the duplicate according to method semantics.

The relay does not need to remember the call to make this work.

This is more appropriate for a normal Source RPC bus because Source RPC currently distinguishes relaying from brokering: the relay does not queue calls for disconnected peers or take durable ownership of them. ([GitHub](https://github.com/source-repo/rpc))

# The Sparkplug frame must contain a complete Source RPC envelope

The existing MQTT 5 Source RPC wire packet cannot simply be inserted as-is. Currently, the MQTT payload contains only the encoded argument array; source, kind, method, TTL, contract version, response destination, and correlation data live in MQTT 5 packet properties. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md))

Those properties disappear when Source RPC is carried as a Sparkplug Bytes metric. The Sparkplug transport therefore needs a transport-neutral inner frame, roughly:

```ts
export interface SparkplugRpcFrame {
  readonly version: 1;

  /**
   * Changes when this Source RPC transport process restarts.
   */
  readonly linkEpoch: string;

  /**
   * Per-direction ordering independent of Sparkplug's seq.
   */
  readonly streamSequence: bigint;

  /**
   * Stable across every retry of this logical invocation.
   */
  readonly requestId: Uint8Array;

  readonly source: string;
  readonly target: string;

  readonly kind:
    | 'call'
    | 'subscribe'
    | 'unsubscribe'
    | 'result'
    | 'error'
    | 'event'
    | 'control';

  readonly path?: string;
  readonly method?: string;
  readonly event?: string;

  readonly contractVersion?: string;
  readonly idempotencyKey?: string;

  /**
   * Remaining budget. A retry must never reset this.
   */
  readonly ttlMs: number;

  readonly contentType:
    | 'application/msgpack'
    | 'application/json';

  readonly payload: Uint8Array;
  readonly signature?: Uint8Array;
}
```

The Source RPC low-level model is already designed for this: transports own their wire format and encode/decode normal internal `Message` objects through their own frame codec. The Sparkplug transport should encode that internal message rather than trying to reproduce an MQTT packet inside another protocol. ([GitHub](https://github.com/source-repo/rpc/tree/main/packages/rpc))

## Sparkplug metrics

Each endpoint could declare two fixed Bytes metrics in its BIRTH:

```text
SourceRPC/Outbound    Edge → Host
SourceRPC/Inbound     Host → Edge
```

At Device level:

```text
Outbound: DDATA
Inbound:  DCMD
```

At Edge Node level:

```text
Outbound: NDATA
Inbound:  NCMD
```

Sparkplug supports Bytes metrics, and `is_transient` tells consuming applications that a metric should not be stored as an ordinary historian tag. ([Eclipse Sparkplug](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf))

A protocol version and maximum frame size can also be declared in BIRTH. RPC frames can be bundled in one Bytes value to reduce overhead.

# Preserve ordering independently of Sparkplug

Request IDs solve duplicate execution; they do not solve ordering.

Consider:

```text
1. setMode('manual')    lost
2. start()              delivered
1. setMode('manual')    retransmitted
```

Without an inner ordering mechanism, the target might execute `start()` before `setMode()`.

Therefore every virtual transport should maintain:

- a `linkEpoch`;
- a monotonically increasing `streamSequence`;
- a bounded out-of-order receive window;
- a bounded send window;
- expiration of a missing frame according to its original deadline.

The Sparkplug `seq` can still be used to diagnose an outer-message gap, but it is not the Source RPC ordering identifier.

A simple initial implementation can use one ordered stream per endpoint. Later, separate streams per target or ordering key could prevent an unrelated lost call from briefly holding up all other traffic.

# Result by interaction type

The framework should not try to give every kind of interaction the same promise.

| Interaction | Sparkplug-only behaviour |
|---|---|
| Component state | Latest full snapshot wins. Lost intermediate updates are acceptable; reconnect/BIRTH or snapshot replay restores current state. |
| Query | Retry using the same request ID. It may execute again. |
| Idempotent command | Retry using the same request ID. Re-execution leaves the same intended state. |
| Non-repeatable command with durable idempotency | Retry safely; the recorded outcome is returned rather than executing again. |
| Non-repeatable command without durable idempotency | A lost outcome becomes `UnknownOutcome`; never retry blindly. |
| Ordinary event | Best effort initially. |
| Audit-grade event | Use an acknowledged event extension or Source Queue. |
| Durable work | Use `@source-repo/queue`, not the RPC relay. |

This preserves the important distinction established in the extension discussion: commands ask for an outcome, events report facts, and queued work asks some suitable consumer to process a task. `Extending Soure RPC.pdf`

Source RPC already declares query, idempotent-command, and non-repeatable-command semantics, distinguishes `TransportError` from `UnknownOutcome`, and supports a durable `RpcIdempotencyStore` for replaying the recorded outcome of non-repeatable commands. ([GitHub](https://github.com/source-repo/rpc/tree/main/packages/rpc))

For the strongest physical-world guarantee, the downstream device operation should either accept the same idempotency key or be transactionally coupled to the durable outcome record. A database record alone cannot make an unrelated physical side effect atomic.

# Correct error semantics

The Sparkplug transport must be conservative.

## `TransportError`

Use this only when Source RPC knows that the call could not have left:

- encoding failed;
- local policy rejected it;
- the endpoint was already known to be offline;
- no Sparkplug publish attempt occurred.

## `Timeout` / `UnknownOutcome`

Once the first QoS 0 Sparkplug frame has been emitted, absence of a response cannot prove that the command did not run.

For a non-repeatable command:

```ts
try {
  await dispenser.dispense();
} catch (error) {
  if (
    error instanceof RpcError &&
    (
      error.code === 'UnknownOutcome' ||
      error.code === 'Timeout'
    )
  ) {
    // Inspect reported state or recover the recorded outcome.
    // Do not issue a second dispense blindly.
  }
}
```

This matches the distinction Source RPC already makes between “certainly did not run” and “may have run.” ([GitHub](https://github.com/source-repo/rpc/tree/main/packages/rpc))

Most importantly, a retransmission must carry the **remaining** TTL. It must never restart the original timeout, or a command could execute long after its caller has stopped waiting.

# When the relay needs durable storage

There is one critical rule:

> **An acknowledgement transfers custody.**

Suppose the relay tells A:

```text
“I have accepted request 42; you may forget it.”
```

If the relay then crashes before forwarding it to B, the request is gone.

Therefore a relay may send a custody-transfer acknowledgement only after durably recording:

- the complete request;
- its original deadline;
- source and target;
- request and idempotency IDs;
- current delivery phase.

That creates a second, stronger deployment profile:

```ts
export type SparkplugRpcReliability =
  | 'retry-until-deadline'
  | 'durable-relay';
```

## `retry-until-deadline`

- Recommended initial implementation.
- Caller owns the request until final result.
- Relay remains an ordinary `RpcServer`.
- Relay restart is recovered through caller retransmission.
- Nothing is queued for an endpoint that is already offline.
- Non-repeatable commands require target idempotency for safe retry.

## `durable-relay`

- Relay journals a request before accepting custody.
- Relay journals a result before accepting custody from the target.
- Results remain recoverable until caller acknowledgement or expiry.
- Relay can survive restart without relying on the caller process.
- Calls still expire at their original deadline.
- It must not quietly become a general offline work queue.

The second mode is essentially a bounded, deadline-aware RPC broker. It is useful, but it should not be required to make the first Sparkplug integration work.

# Recommended first version

I would build:

```text
SparkplugRpcHostTransport
    ├─ virtual transport: edge-a
    ├─ virtual transport: edge-b
    └─ virtual transport: edge-c
              │
              ▼
        relay-only RpcServer
```

With these initial semantics:

1. One Host MQTT connection, multiplexed into virtual per-peer links.
2. Two fixed transient Bytes metrics per endpoint.
3. Complete transport-neutral Source RPC frames.
4. Stable request IDs across retries and relays.
5. End-to-end retry until result/error or original deadline.
6. Inner link epoch and sequence for ordering and deduplication.
7. Queries and idempotent commands retry automatically.
8. Non-repeatable commands require a durable idempotency store for automatic retry.
9. State converges through full snapshots rather than reliable delivery of every update.
10. Ordinary events remain best effort; durable facts use Source Queue.
11. No store-and-forward to peers that were already offline.
12. Hard real-time control remains local.

So the conclusion is:

> **Your relay architecture works. The relay can remain a normal `RpcServer`, provided the caller retains ownership of each request until the final outcome and retransmits the same request ID. Sparkplug supplies discovery and connectivity; Source RPC must supply acknowledgement, deduplication, ordering, deadlines, and honest uncertainty.**

That keeps the Source RPC peer model intact inside a physically centralized Sparkplug environment without falsely claiming that QoS 0 provides reliable command delivery.

---

**Sources:**

- [https://github.com/source-repo/rpc](https://github.com/source-repo/rpc)
- [https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf](https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf)
- [MQTT Version 5.0 | OASIS Standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html?utm_source=chatgpt.com)
- [https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md](https://raw.githubusercontent.com/source-repo/rpc/main/docs/mqtt5-frame-spec.md)



---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)