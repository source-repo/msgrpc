# Extensions and an ecosystem

Designs that are **not built**. Everything else in `docs/` describes what Source RPC does; this describes what it could grow, and is kept separate for that reason. Distilled from [a long conversation](rpc-extensions-chat.md) — the reasoning is there, the conclusions are here, and the paths that were tried and abandoned are collected at the end rather than left lying across the middle.

One thread runs through all of it. The library already makes a network **self-describing**: a class is the contract, `extract` reads it off the AST before minification can touch it, and `describe()` serves it at runtime. Almost every idea below is a consequence of that one property — once a peer can say what it is, a console, a compiler, another peer or a model can all work out what to do with it without being told in advance.

| | |
| --- | --- |
| [Properties on a remote class](#properties-on-a-remote-class) | the one gap in the programming model |
| [Server-driven UI](#server-driven-ui) | a node describes its interface; something else renders it |
| [Capability discovery](#capability-discovery) | find by what a peer *does*, address by *which* peer it is |
| [Actions and events](#actions-and-events) | interaction surfaces a console and a model share |
| [Server-driven logic](#server-driven-logic) | JSON flows, and where they stop |
| [Execution tiers](#execution-tiers-and-the-real-time-boundary) | how far down toward the metal this goes |
| [A business around it](#a-business-around-an-open-core) | why any of it gets maintained |
| [Considered and dropped](#considered-and-dropped) | with the reasons, so they stay dropped |

## Properties on a remote class

Methods and events cross the wire; properties do not. The friction is real rather than incidental: a TypeScript setter cannot return a promise, so `remote.pressure = 100` has nowhere to put a `TransportError`, a timeout, or an idempotency key. Everything the library does to make network failure legible is unavailable at exactly the syntax that hides it.

**The design: a shadow copy fed by events.** Reads are synchronous against a local cache; writes stay explicit async methods. The server wraps an exposed instance in a `Proxy` whose `set` trap updates local state immediately and *then* decides whether to broadcast. The client hydrates once and applies pushed mutations after that, and because the library already replays subscriptions idempotently on reconnect, the shadow cannot go permanently deaf after a dropped link.

Client-side setters should **throw**. That is the whole discipline: a write must be fallible and awaitable, so it must be a method.

**The decorator carries the filtering**, because a plant full of analog sensors will otherwise flood the broker with micro-fluctuations:

```typescript
@rpcNamespace('oven', { version: '1' })
export class Oven {
    @rpcProperty({ throttle: 500, hysteresis: 0.5 })
    public temperature = 20.0

    @rpcProperty()
    public status = 'idle'
}
```

Two details that are easy to get wrong. The local mutation is **never** filtered — only the broadcast is, or the server's own logic starts reading stale values it wrote itself. And throttling must be **trailing-edge**: drop the intermediate frames, but send the final value when the window closes, or a client settles on whatever the value happened to be mid-swing.

Throttle and hysteresis are server-side behaviour and do not belong in the contract. The property's *type* does, so hydration and pushed updates can be checked like anything else — which means `extract` would need to read `PropertyDeclaration` nodes as well as methods.

## Server-driven UI

A scripted node on a plant floor is often behind NAT with one outbound MQTT connection. It cannot open an HTTP port, so its UI has to travel the way everything else does — over the bus.

The design arrived at, after three worse ones:

**A node describes its interface as JSON; a separate peer compiles it; the console displays the result.**

```typescript
@rpc({ semantics: 'query' })
async renderUi(): Promise<UiWidget> {
    return {
        type: 'Card',
        children: [
            { type: 'Gauge', props: { min: 0, max: 3000 }, bind: { state: 'rpm' } },
            { type: 'Toggle', bind: { state: 'running', action: 'toggleRun' } }
        ]
    }
}
```

`bind` is what makes it more than a layout format: `state` names the key to read from the node's telemetry, `action` names the RPC method to call. The renderer wires both from the proxy it already holds.

Three properties follow, and each was the reason to move one step further:

- **The node ships no HTML, CSS or JavaScript.** A typed JSON tree cannot break out of a renderer that only knows a fixed set of widget types, so there is no untrusted code to sandbox. It also validates like any other RPC payload — a node returning an unknown widget type fails at the boundary.
- **The compiler is a peer, not a library.** A `ui_compiler` node takes `(engine, layout, targetPeer)` and returns HTML. It can run on a laptop while prototyping or on a server for the whole plant. The CLI stays a lightweight orchestrator that routes JSON to a compiler and displays what comes back — it never learns what a Gauge is.
- **Rendering is still sandboxed.** The compiled HTML goes into an `iframe` with `sandbox="allow-scripts"`, talking to the console only through a `postMessage` bridge that can invoke methods on one specific proxy. Fifty node UIs cost zero extra broker sessions, because everything multiplexes over the console's existing link. Nothing is fetched from a CDN, so it works on an air-gapped network.

## Capability discovery

Three distinct things get confused with each other, and the design only works when they stay apart:

| | | |
| --- | --- | --- |
| **Interface name** | `UiCompiler` | what a peer *can do* — used to find it |
| **Namespace** | `ui_compiler` | the versioned service address — used to route |
| **Node id** | `SilentFoxDeltaEcho` | *which* peer — used to deliver |

Discovery searches `describe()` output for peers implementing an interface. That works here and nowhere else, because `extract` walks the AST *before* compilation: the interface name survives as a string in the schema, where type erasure and minification would otherwise have destroyed it. A search returning one node auto-connects; three lets the caller choose.

The namespace stays an explicit string rather than being inferred from the interface, for reasons that only show up later: renaming an interface in an IDE would silently move the network address and strand every older peer; two nodes can implement one interface and need distinct addresses (`ui_compiler_fast` and `ui_compiler_heavy`); and `@rpcNamespace(name, { version })` is where versioning already lives.

Execution addresses the **node id** directly, which is what guarantees point-to-point delivery. Interface for discovery, namespace for the service contract, node id for the message.

Two useful consequences: a peer implementing `AdvancedUiCompiler extends UiCompiler` satisfies a search for `UiCompiler`, so capabilities inherit over the wire; and because the console fetches the contract during discovery, it validates a payload **locally** and fails with `InvalidParams` before spending a network hop.

## Actions and events

Two small capability interfaces, distributed as contract-only packages with no implementation and no dependencies. A node implements one and becomes usable by any console or agent without either side being rebuilt.

**`ActionProvider`** — what a user may do *right now*. The node evaluates its own state and returns only valid actions, so a running pump does not offer "Start". An action returns either a toast or a `ui_modal` naming the compiler interface it needs, its layout, and a window size. The console never compiles a dashboard until an action asks for one, and it never encodes any of the node's business logic.

**`EventProvider`** — user-configurable wiring. `getAvailableEvents()` returns each event with its AST-extracted payload schema; `addEventSubscription({ eventId, targetNodeId, targetMethod })` wires an event on one node to a method on another.

The wiring is the interesting part. The console filters candidate targets by **signature compatibility** — an event emitting a `number` offers only methods taking one — so the dropdown shows `CoolingPumpDelta.setSpeed(speed: number)` rather than every method on the network. Once wired, execution is peer-to-peer over the broker and the console can go away; the emitting node just fires an RPC at the target id. It has no idea what the target does.

Because the CLI already hosts an MCP server, all of this reaches a model through the same discovery cache and the same schemas the human sees. There is no second implementation to drift, and a hallucinated wiring — a string event into a numeric parameter — is rejected by the same local validation, before it reaches the broker.

## Server-driven logic

The same move as the UI, one layer down: if a node can describe its interface, a *flow* can describe orchestration.

```json
{
  "trigger": { "nodeId": "BoilerSensorAlpha", "eventId": "temp_critical" },
  "pipeline": [
    { "type": "condition", "evaluate": "payload.temperature > 150 && state.manual_override == false" },
    { "type": "action", "targetNodeId": "CoolingPumpDelta", "method": "setSpeed", "params": { "speed": 100 } }
  ]
}
```

A `FlowRunner` peer takes the JSON, sets up the subscriptions, and dispatches. The value over Node-RED — which this is plainly chasing — is that the flow is a typed, diffable, version-controllable document rather than untyped payloads with JavaScript hidden in nodes. It can be checked against the network's schemas *before* deployment, and a model can read an existing flow and be asked whether any path leaves a pump un-engaged. A drag-and-drop editor becomes a frontend exercise over a data structure that was already the source of truth.

**JSON stops at Turing-completeness**, and pretending otherwise is how these systems rot. Loops, PID control, an FFT over vibration data, a platform call — none of that belongs in a declarative pipeline. `TsFlowRunner` is the escalation: same capability-discovery shape, but it accepts source, runs it in an isolated context, and can deploy a persistent worker. To the rest of the network a synthesised script looks exactly like a hardcoded node — it implements the same contracts and appears in the same dropdowns.

That gives a model two tiers rather than one: declarative flows where they suffice, synthesised code where they do not, with the boundary explicit instead of discovered the hard way.

## Execution tiers and the real-time boundary

This is where the conversation stopped flattering itself, and the honesty is the useful part.

**A mesh on a general-purpose OS cannot do hard real-time.** Not with Rust, not with WebAssembly, not with careful code. The Linux CFS or the Windows kernel will preempt a thread for a few hundred microseconds to service an interrupt, and worst-case execution time is destroyed. TwinCAT achieves what it achieves by hijacking a core and bypassing the kernel. A cutting tool does not care about average latency; it cares that the command is never late.

So the boundary is drawn deliberately rather than discovered:

| tier | what runs | where |
| --- | --- | --- |
| **Hard real-time** | servo loops, safety interlocks, sub-ms I/O | the PLC, untouched |
| **Firm real-time** | control logic, sensor ingestion | WebAssembly beside the process image, 5–10 ms |
| **Soft** | orchestration, routing, audit, simulation | the mesh, 10 ms and up |

**WebAssembly is the vehicle for the middle tier.** It is a memory-safe sandbox with near-native speed: a panicking module takes down its sandbox, not the host. AssemblyScript is the natural first target — strict TypeScript syntax, so a model synthesising edge logic stays in one mental model, and a compiler that runs inside Node, so a JSON flow can become a `.wasm` binary in milliseconds with no cloud build. Its ceiling is real (no closures, a small standard library) and Rust takes over above it, but the runtime loads a `.wasm` file and does not care which produced it.

On embedded, **WAMR** has a first-class Zephyr port, AoT compilation, and pairs with Zephyr user mode so a faulting module is contained in its thread. The sandbox reaches hardware only through host functions you register explicitly, which is also the security model: the module can toggle a GPIO because you exported a function that does, and nothing else.

On a Linux PLC the same idea removes the network entirely. A real-time daemon drives EtherCAT and owns the process image; WAMR is linked into that daemon; a native `write_io_bit` is registered as an import. Synthesised logic then flips a physical output by writing memory, with no serialisation and no broker in the path — while the same box remains an ordinary peer exposing an ordinary schema for orchestration.

**Legacy is the normal case, so extend rather than replace.** Keep the PLC and run the WASM node in user space beside it, exchanging through a shared-memory ring buffer — lock-free, because a user-space thread holding a mutex when it gets preempted will block the real-time side. Tune with `mlockall`, `SCHED_FIFO`, and core pinning and firm real-time is achievable. It is not hard real-time and should not be sold as such.

**The limitation is the safety architecture.** The PLC keeps the veto:

- a **heartbeat** the WASM daemon must toggle, with the PLC dropping to a safe state if it stops — which covers a hung script, an infinite loop, and an over-long preemption identically;
- a **stop request** OR-ed with the physical E-stop, so the intelligent layer can always halt the machine;
- a **permissive**, not a command: `IF (Request AND SafetyDoors_Closed AND Clamp_Pressure_OK) THEN Execute()`.

A few dozen lines of deliberately crude Structured Text de-risk everything above them. Synthesised logic can be deployed a hundred times a day, and the worst case is a rejected command or a halted machine.

## A business around an open core

Infrastructure has to be open to be adopted — nobody wires a factory to a protocol one vendor controls — and has to earn something to be maintained. Industrial buyers do not pay for technology; they pay for risk reduction, compliance and uptime.

**Open:** the AST extractor, the contract packages, the CLI and its MCP server, the basic compiler and flow-runner nodes. A prototype on a local network should cost nothing, because adoption is what makes the schemas a standard.

**Commercial:** what changes when five prototype nodes become five thousand across several sites.

- **Automated configuration audit and simulation** — the highest-value piece, and the one a human cannot do at scale. A platform ingesting `describe()` schemas and live subscriptions can answer "is there a `temp_critical` event anywhere that is not wired to a shutdown?" and prove it before deployment rather than after an incident.
- **Premium compilers** — the open renderer draws gauges and charts; a 3D digital twin of a floor, or a geographic view of a distributed power system, is a licensed peer on the broker.
- **Fleet governance** — multi-tenant identity, who may press Emergency Stop, deployment history for flows and scripts, and an audit log of every discovery and execution.
- **Managed sandboxes** — running untrusted synthesised code safely and highly available is genuinely hard, which is what makes it worth selling.

This is the ingestion layer for exactly that kind of platform. The hard part of auditing control systems is that the logic sits in proprietary PLCs and compiled C; a mesh where every edge node self-describes turns the black box into a graph, which is the only form an audit can work on.

## Considered and dropped

Kept because a rejected idea returns unless the reason is written down.

**Awaitable properties (`await remote.temperature`).** A mapped type turning every property into a promise and generating `setX()` methods. It fights the library rather than extending it: `proxy()` is already a carefully built proxy with traps of its own, including `$with`, and wrapping it to intercept property reads means two proxies disagreeing about what a get means. The shadow copy gets synchronous reads *and* leaves writes explicit.

**Properties as observables.** Exposing `Observable<string>` instead of `string` fits MQTT's pub/sub shape, but changes the class into something written for the network. The point of the library is that the class is ordinary.

**A sidecar HTTP server per node.** Serving the UI on port 7844 next to the RPC. Works locally and fails exactly where it matters — an edge device behind NAT with one outbound broker connection has no port to open.

**Raw HTML over RPC.** The first in-band design, and the one that made the iframe bridge necessary. Superseded by JSON layouts: a typed tree needs no sandbox in the first place, enforces one design system across every node, and validates like any other payload. The bridge survives as the transport for compiled output.

**A CDN-loaded SPA per node UI.** Each UI opening its own connection and fetching a framework from unpkg. Multiplies broker sessions, and fails outright on an air-gapped plant network.

**A widget library inside the CLI.** The obvious move, and it turns a diagnostic tool into a dashboard monolith. First decoupled into a plugin package, then out of the process entirely — the console should not know what a Gauge is.

**The interface name as the network namespace.** DRY and tempting. An IDE rename becomes a silent infrastructure change, two implementations of one interface cannot be addressed separately, and versioning loses the place it lives.

**A TwinCAT ADS boundary node.** Mapping the PLC's memory over ADS to bridge cyclic execution into the mesh. Technically sound and explicitly abandoned — mapping raw hex offsets is a large ongoing cost for a legacy path, and shared memory beside the PLC reaches the same place without the ghosts.

**WAMR compiled into a TwinCAT C++ module.** Compiling the runtime into a TcCOM object to get inside the real-time kernel. That kernel has no standard libc, no `malloc`, and a Beckhoff-specific target library; WAMR's platform layer would have to be ported to it. User-space WAMR builds in seconds with stock GCC and reaches the process image through shared memory instead.

**Chasing hard real-time in the mesh.** Attempting sub-millisecond determinism on a general-purpose OS. Not achievable without becoming a hypervisor, and unnecessary once the PLC keeps the safety-critical tier.
