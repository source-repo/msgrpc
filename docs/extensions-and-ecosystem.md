# Extensions and an ecosystem

Designs that are **not built**. Everything else in `docs/` describes what Source RPC does; this describes what it could grow, and is kept separate for that reason. Distilled from [a long conversation](archived/rpc-extensions-chat.md), then hardened by [a critical review](archived/extensions-and-ecosystem-review.md) that checked every load-bearing claim against the code — seven findings resolved into what follows, one left open and marked as such. The paths tried and abandoned are collected at the end rather than left lying across the middle.

One thread runs through all of it. The library already makes a network **self-describing**: a class is the contract, `extract` reads it off the AST before minification can touch it, and `describe()` serves it at runtime. Almost every idea below is a consequence of that one property — once a peer can say what it is, a console, a compiler, another peer or a model can all work out what to do with it without being told in advance.

A second thread emerged in review: the pieces keep meeting in the middle. The command semantics shipped for idempotency turn out to grade the UI's confirmation dialogs; the place tree wanted for viewing ranks the wiring picker; the designations a sector's drawing standard prints on cabinet labels are the role names a capability contract declares. Where a design needed a mechanism, an existing one kept fitting — which is usually the sign the designs pull in one direction.

| | |
| --- | --- |
| [Properties and process values](#properties-and-process-values) | the one gap in the programming model — **under investigation** |
| [Server-driven UI](#server-driven-ui) | a node describes its interface; something else renders it |
| [Capability discovery](#capability-discovery) | find by what a peer *does*, address by *which* peer it is |
| [Actions and events](#actions-and-events) | interaction surfaces a console and a model share |
| [Server-driven logic](#server-driven-logic) | expression trees, structure, and where declarative stops |
| [Execution tiers](#execution-tiers-and-the-real-time-boundary) | how far down toward the metal this goes |
| [Authorization](#authorization) | seven rules, held rigidly |
| [A business: assessment first](#a-business-assessment-first) | why any of it gets maintained |
| [Where things belong](#where-things-belong) | what is core, what is a package |
| [What to build first](#what-to-build-first) | the two features everything else waits on |
| [Considered and dropped](#considered-and-dropped) | with the reasons, so they stay dropped |

## Properties and process values

**Status: under investigation — the one section here that is a question rather than a design.** Everything downstream that binds live state — the UI's `bind`, the expression trees' `state.*` references — waits on its answer, which is why it sits first in [the build order](#what-to-build-first).

Methods and events cross the wire; properties do not. The friction is real rather than incidental: a TypeScript setter cannot return a promise, so `remote.pressure = 100` has nowhere to put a `TransportError`, a timeout, or an idempotency key. Everything the library does to make network failure legible is unavailable at exactly the syntax that hides it. One rule survives every candidate below: a write must be fallible and awaitable, so a write is a method, and client-side setters throw.

The drafted design was **a shadow copy fed by events** — reads synchronous against a local cache, writes explicit async methods, the server wrapping an exposed instance in a `Proxy` whose `set` trap updates local state immediately and then decides whether to broadcast:

```typescript
@rpcNamespace('oven', { version: '1' })
export class Oven {
    @rpcProperty({ throttle: 500, hysteresis: 0.5, unit: '°C' })
    public temperature = 20.0
}
```

Two details of that filtering stay true in every candidate. The local mutation is never filtered — only the broadcast is, or the server's own logic starts reading stale values it wrote itself. And the throttle must be trailing-edge: drop the intermediate frames, but send the final value when the window closes, or a client settles on whatever the value happened to be mid-swing.

Review found three gaps in the shadow copy, and the third is structural. `resubscribeFailed` reports a count, not which subscriptions failed, so a shadow cannot mark the right values stale. Hydrate-then-subscribe has no sequence number, so an update landing between snapshot and subscription is lost or applied out of order. And the `set` trap only sees writes made through the proxy — a `setInterval(() => this.temperature = read(), 100)` started in the constructor captured the raw `this`, so the single most common sensor pattern silently never broadcasts. A wrapper can always be outrun by code that captured `this` first; the trap is an artifact of choosing interception. Two ways to make it structurally impossible are on the table.

**Sampling instead of interception.** The throttle interval already defines how often the network may hear a change, so sampling decorated fields at that interval and diffing removes the proxy entirely. Trailing-edge behaviour comes free — a sample reads current state — and hysteresis becomes a diff filter. A change is heard up to one sample late, which at plant-telemetry intervals is what every polling SCADA has always accepted.

**Process values as class instances.** `temperature = new ProcessValue(…)`, or a subclass, makes the value itself the interception point: server code writes through the object, and no wrapper around the host exists to be outrun. The industry has never modelled a process value as a bare number — OPC's value–quality–timestamp triple, BACnet's analog objects with present-value, status-flags and units, WebPort's per-tag sheet; the tag is an object in every system that has lived long in this domain. An object gives quality somewhere to live, which answers the staleness gap structurally: a shadow whose resubscription failed marks `quality: 'stale'` on exactly the affected values, and a read is never silently wrong because the read carries its own verdict. It gives forcing and simulation a home — a maintenance surface wants `forced: true` visible — and it attaches the write discipline to the value itself: a `Setpoint`'s `set` is an idempotent command, async and fallible on the client shadow.

The objection is this document's own [dropped-ideas section](#considered-and-dropped), which rejects observable-typed properties because the class is ordinary. The distinction under test: an `Observable` is reactivity plumbing, written for the network, while a process value object is domain vocabulary — the thing a standalone control program with no network attached would still contain, alarm limits and all. Ordinary industrial code has had tag objects for fifty years. And the typing cost that historically favoured primitives — `oven.temperature` against `oven.temperature.value` — weighs less when models write much of the code, while the explicit object gives a model more to read: completing `temperature.` reveals value, quality, unit and forced, and teaches the domain in a way a bare float never did.

The extractor has been run against the idea, so two questions are already facts. The data shape extracts today, cleanly: `ProcessValue<number>` and `ProcessValue<string>` come out distinct and correct — quality as a literal union, `at` as a date, `unit` optional — and a subclass flattens its inheritance into a named type. And behaviour is refused loudly: give the class `set` or `onChange` and extraction fails with *is a function, which cannot be checked on the wire*. That settles the wire model — what crosses is the data projection — and names the one piece of new extractor work: the projection rule, where a recognized process value strips its behaviour and keeps its data, or a source spelling that keeps the two apart. Instantiated generics inline anonymously (the `Record<string, number>` collision, `extract.ts:51`), so nominal recognition means a named subclass per role — which aligns with [the sector designations below](#actions-and-events): `Temperature` is a class the way `GT` is a designation.

Still to settle: the write path — which values are writable, how command semantics attach, what the target's `authorize` sees; quality propagation, with transport loss, resubscription failure and forcing each visibly distinct; and what the console renders, the properties panel growing quality badges being the visible payoff. Whatever wins, the decorator's `throttle` and `hysteresis` filter broadcast magnitude at the source and are not the logic tier's time operators, which absorb threshold crossing — a perfectly filtered property still chatters a `> 150` condition when the value swings across the threshold by more than the filter band. Both layers stay.

## Server-driven UI

A scripted node on a plant floor is often behind NAT with one outbound MQTT connection. It cannot open an HTTP port, so its UI has to travel the way everything else does — over the bus.

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

`bind` is what makes it more than a layout format: `state` names the key to read from the node's telemetry, `action` names the RPC method to call. The renderer wires both from the proxy it already holds — which depends on [properties](#properties-and-process-values) existing, and is why that investigation gates this design.

Three properties carried the original design, and each was the reason to move one step further. The node ships no HTML, CSS or JavaScript — a typed JSON tree validates like any other RPC payload, and a layout with an unknown widget type fails at the boundary. The compiler is a peer, not a library — a `ui_compiler` node takes `(engine, layout, targetPeer)` and returns HTML, so the CLI stays a lightweight orchestrator that never learns what a Gauge is. And rendering is sandboxed — compiled HTML goes into an `iframe` with `sandbox="allow-scripts"`, talking to the console only through a `postMessage` bridge scoped to one proxy, so fifty node UIs cost zero extra broker sessions and nothing is fetched from a CDN.

### The trust model

The typed tree prevents *execution*, not *deception* — and review found the second is the deeper attack. A layout that executes nothing can still lie: render "Pressure: NORMAL" against an over-pressure tank, or a perfectly valid form titled "Update your company payment method". No sandbox stops content.

The setting is what makes it serious. This UI renders in a trusted internal environment — the control room — where suspicion is lowest and everything else on screen is legitimate, so an injected panel inherits a credibility no phishing site ever gets. "It is internal" is the posture that usually excuses weak defenses on industrial networks; here it is exactly what raises the stakes, because server-driven UI imports remote content into the operator's trusted zone. Every peer whose panel is rendered joins the control room's trusted computing base, and membership in that base is a deliberate act. So the defenses are structural, not vigilance:

- **Trust is granted, not discovered.** A console renders a peer's UI only under a grant — configuration or a signed grant, default none. Implementing a capability is a claim, not a right. Compilers are pinned by configuration: discovery may propose one, never appoint one, because over a relay nothing can authenticate who answered — see [the security model](security-model.md).
- **Discovered UI is a maintenance surface; the operator UX is authored.** A panel reached by browsing the network or the place tree is for debugging, diagnostics and commissioning — the technician chasing a failing sensor. An operator follows the task and the process, not the physical structure of the control system: nobody responds to a fire alarm by browsing to building A, cell 3. So the operator screen is an authored composition document naming the dialogs it embeds, by peer and capability — and that is the strongest form of the grant rule, because the operator surface's grant list *is* the document, versioned, diffable and reviewed like a flow. A rogue panel cannot reach the operator without first getting itself into a reviewed artifact. The same dialogs serve both surfaces; composition inherits the whole defense stack.
- **The chrome stays native.** Every remote panel sits in console-drawn framing naming the serving peer and its authentication status, loudly when unauthenticated. The bridge cannot draw console chrome, which is what makes confirmations trustworthy: a non-query call from a remote panel triggers a native dialog naming peer, method and arguments — risk-graded for free, because `query`, `idempotent-command` and `non-repeatable-command` already ride in every contract. An action's human label renders beside the method it actually calls, so "Acknowledge alarm" wired to `setValve` is visible as the lie it is.
- **The widget vocabulary is the phishing defense.** A closed set with no credential or payment primitives: a convincing credit-card form cannot be composed from Gauge, Toggle, Setpoint and Chart. Free text exists only where a contract method takes a string, rendered with its destination method visible. A closed vocabulary excludes the primitives deception needs, which is a stronger property than any sandbox grants.
- **Values bypass the compiler.** Displayed state flows through the console's own schema-checked subscription, wired from the layout's `bind` declarations; compiled output requesting a binding absent from the layout the node declared is rejected. A compromised compiler can mislabel a value but not fabricate one. Reproducible compilation — same layout, same compiler version, same output hash, recompiled and compared — turns compilers into verifiable functions, which the [assessment tier](#a-business-assessment-first) can sell as a check rather than a hope.
- **The sandbox stays**, as defense in depth: `allow-scripts` without `allow-same-origin` — adding `allow-same-origin` beside it voids the sandbox entirely.

The honest residue: a granted, authenticated peer lying in its own panel about its own state. No protocol fixes that. It is bounded by the grant being deliberate, the provenance being visible, and every action still traversing the target's `authorize` — the UI layer is never the security boundary.

## Capability discovery

Three distinct things get confused with each other, and the design only works when they stay apart:

| | | |
| --- | --- | --- |
| **Capability** | `@source-repo/ui-contracts/UiBuilder` | what a peer *can do* — used to find it |
| **Namespace** | `ui_compiler` | the versioned service address — used to route |
| **Node id** | `SilentFoxDeltaEcho` | *which* peer — used to deliver |

A node declares a capability by implementing a contract interface — `class Compiler implements UiBuilder` — and `extract` reads the heritage clause off the AST and writes the capability into the schema. Discovery then finds it in `describe()` output because `describe()` serves the schema; `constructor.name` is never consulted. That distinction is not stylistic: runtime reflection dies in a bundler, and the console's own page proves both halves in one answer — it describes its introspection class as `"m"` while serving parameter names intact, because the names ride in the extracted contract embedded at build time. Schema data survives minification; runtime reflection does not.

Declaring by `implements` buys two things a decorator string cannot. The type system enforces the claim — a class that says `implements UiBuilder` and does not, fails to compile. And `check:contract` polices renames — once the capability is in the committed contract, renaming the interface is a contract diff and a failing check, so the IDE-rename hazard stops being silent, which was the actual problem with it.

Three rules make it sound. The name is **qualified by where it was imported from**: `extract` resolves `import { UiBuilder } from '@source-repo/ui-contracts'` and emits `@source-repo/ui-contracts/UiBuilder`, never the bare string — uniqueness comes free, and shared-package identity becomes the definition of capability identity, so two vendors' local `UiBuilder` interfaces correctly do not match. The **transitive closure is computed at extract time** — `AdvancedUiCompiler extends UiCompiler` emits both names, so a runtime search stays a flat string match. And **discoverable means having an extracted contract**: `implements` is erased at runtime, so a class exposed without ever running `extract` cannot advertise capabilities — acceptable, production peers should have contracts, but it is a rule, not a surprise. Qualified names travel everywhere a capability is referred to, including inside payloads — an action's `ui_modal` names the compiler interface it needs, and a bare name there would reopen the uniqueness hole.

The namespace stays an explicit string rather than being inferred from the interface, for reasons that only show up later: renaming an interface in an IDE would silently move the network address and strand every older peer; two nodes can implement one interface and need distinct addresses (`ui_compiler_fast` and `ui_compiler_heavy`); and `@rpcNamespace(name, { version })` is where versioning already lives.

Two useful consequences survive from the original design: a peer implementing a subinterface satisfies a search for its parent, so capabilities inherit over the wire; and because the console fetches the contract during discovery, it validates a payload locally and fails with `InvalidParams` before spending a network hop.

Capability packages have a governance model with two tiers. Where a sector has published standards — building automation, with its drawing and labelling designations — the package encodes the standard and names which one, so role naming defers to the sector's standards body rather than being invented. Where no standard exists — the one-off factory — a project-local contract package plays the same role for that plant alone, the same mechanism at narrower scope. What remains to govern centrally is only which packages exist.

## Actions and events

Two small capability interfaces, distributed as contract-only packages with no implementation and no dependencies. A node implements one and becomes usable by any console or agent without either side being rebuilt.

**`ActionProvider`** — what a user may do *right now*. The node evaluates its own state and returns only valid actions, so a running pump does not offer "Start". An action returns either a toast or a `ui_modal` naming the qualified compiler capability it needs, its layout, and a window size. The console never compiles a dashboard until an action asks for one, and it never encodes any of the node's business logic.

**`EventProvider`** — user-configurable wiring. `getAvailableEvents()` returns each event with its AST-extracted payload schema; `addEventSubscription({ eventId, targetNodeId, targetMethod })` wires an event on one node to a method on another. Once wired, execution is peer-to-peer over the broker and the console can go away; the emitting node fires an RPC at the target id with no idea what the target does.

### The picker ranks and reveals, and never blocks

The wiring dropdown's hard gate sits at the general type only — an event emitting a `number` offers methods taking a number, boolean matches boolean — and everything beyond that is ranking, not refusal. This is the field's hard-won principle, and as far as even a well-modelled OPC UA client goes: show `EngineeringUnits` and range beside the candidate, order by likelihood, and let the choice be made. Sources in the field are under-specified as the norm, and a hard gate on an under-specified point does not stop the integrator — it gets worked around by relabelling the point until the gate passes, and now the metadata lies to everything downstream, including the assessment layer that wants to read it. Guidance keeps metadata honest; a veto teaches it to lie.

What prevents wiring mistakes at scale is documented in [the WebPort notes](WebPort%20SCADA%20comparisons/process-value-scoping.md): naming standards and templates. A tag like `AHU01_GT11` encodes device type and point role by the sector's drawing and physical labelling standards — `GT11` is printed on the engineering drawing and on the label beside the sensor in the cabinet, so drawing, device and tool all speak the same name, and a technician can walk from any one to the other two. [The symbol library](WebPort%20SCADA%20comparisons/symbol-library.md) makes the standard pluggable; [the per-tag sheet](WebPort%20SCADA%20comparisons/process-value-attributes.md) of unit, range and description is maintained by hand on every tag. Every piece of that machinery is a stringly-typed edition of this design: the template is a capability contract, `GT11` is a role name declared as a property on it, the symbol library is a contract package, and the per-tag sheet is `@rpcProperty` metadata declared once per class. A role carries the standard's designation — `inletTemperature` with `designation: 'GT11'` — so the schema agrees with the drawing and the cabinet label, and the console shows a technician the name physically in front of them.

So the picker ranks by role-name match against the target capability's declared properties, unit match, and place proximity from [the structure tree](#server-driven-logic) — the sensor in the same cabinet outranks the one across campus — with unit, range, description, semantics and place shown on every candidate. A ranked list with honest attributes serves a model exactly as it serves a human, and the choice is recorded either way.

The hard stop the industry does accept already exists, at the right boundary: the target's own declared range. `min` and `max` ride on numbers in the schema today and are validated at the call boundary — an RPM reading at 2800 wired into a 0–120 setpoint is `InvalidParams` before the device sees it. The gate lives on the device, not in the picker, which is the trust model's rule again: the UI layer is never the security boundary.

Because the CLI already hosts an MCP server, all of this reaches a model through the same discovery cache and the same schemas the human sees. There is no second implementation to drift.

## Server-driven logic

The same move as the UI, one layer down: if a node can describe its interface, a *flow* can describe orchestration. A condition is a tree of typed nodes — operators applied to operands, operands being references or literals — and the runner never parses anything, because the tree already is the parse:

```json
{
  "trigger": { "nodeId": "BoilerSensorAlpha", "eventId": "temp_critical" },
  "pipeline": [
    { "type": "condition", "expression": { "op": "and", "args": [
        { "op": ">", "args": [ { "ref": "payload.temperature" }, { "value": 150 } ] },
        { "op": "not", "args": [ { "ref": "state.manual_override" } ] } ] } },
    { "type": "action", "targetNodeId": "CoolingPumpDelta", "method": "setSpeed", "params": { "speed": 100 } }
  ]
}
```

The grammar is a recursive union type, which the extractor already handles, so a condition validates with the same machinery as any other payload — a tree with an unknown operator fails at the boundary the way a layout with an unknown widget type does. The value over Node-RED is now true without an asterisk: the flow is a typed, diffable, version-controllable document, checked against the network's schemas before deployment — `payload.*` references resolve against the event's payload schema, `state.*` against the target's declared properties — and a model can read an existing flow and be asked whether any path leaves a pump un-engaged.

**A closed, versioned operator set, with time as the only state.** Comparisons, boolean algebra, arithmetic — all pure — plus the stateful time operators the PLC world settled on long ago: on-delay, off-delay, hysteresis. Included deliberately, because instantaneous comparison chatters — a temperature oscillating across a threshold fires the flow at whatever rate the sensor reports — and their state is bounded to a timestamp per node. Nothing else in the set holds state. Growth pressure will come, and every operator proposed beyond the set is a request to escalate that condition to `TsFlowRunner` instead; the set is versioned like a contract because it is one.

**The expansion step.** An operand can be a selector rather than a point: OR over every fire-alarm input in house A. A selector needs two coordinates — what kind of source, which a capability supplies, and where in a structure, which the paths below supply as a prefix on a named axis. This is the shape the control tradition has used for decades: an operator naming a level in a hierarchy and a type of source data. Expansion happens at deploy time and the selector is retained — the runner records the concrete membership, re-expands when presence changes, and emits the membership change as an event. Deploy-time-only expansion is a commissioning hazard, the alarm added to house A next month silently absent from the OR; runtime-only expansion makes "what does this flow actually watch" unanswerable; retaining the selector gives both answers, and a fire alarm leaving the bus becomes something a flow can alarm on, which is what supervision means in that industry.

**Where the structure comes from.** Two axes, because a physical structure and a logical one answer different questions about the same node: a pump is *in* building A, fire cell 3 — and it is *part of* the cooling system of line 2. **Place** is the physical path, declared at deployment beside `--name` and never in the class contract, because the same `PumpController` class is bolted into every building. **Owner** is the logical axis's foundation: a process that stands up several nodes declares which belongs to which — which is also what turns the console's flat list of three-word names into a tree worth looking at, a viewing win that stands on its own. A logical **system** path extends the same idea across hosts. A node inherits both paths from its owner unless it overrides them, so commissioning sets one place per host — and the override case is real, a sensor owned by a machine's controller but mounted in the next room. A folder on either axis is a path segment, not an entity — no lifecycle, nothing to go offline, no functionality to define — so grouping buildings A and B while C stands alone is just path depth, `campus/ab/building-a` beside `campus/building-c`. What does not dissolve is that declared membership can be wrong or missing, and on the place axis that is a safety fault: the audit rule is that every peer with a safety capability declares a place, every cell expected non-empty is checked non-empty, and supervision extends from "a member left the bus" to "a member was never declared". Whether a third axis ever earns its way in — electrical feeders, maintenance regions — is deliberately deferred: the naming accommodates one, so each is refused until an installation demands it.

**Observability is the point, not a bonus.** Every node of the tree has a current value, and a runner that publishes per-node evaluation state gives any viewer a live-highlighted diagram — ladder logic's lit rungs, which is much of why simple logic has survived in the PLC world. The console renders that with machinery it already has, and it reaches the model too: asked why the pump started, a model reads the recorded evaluation states and answers with an explanation trail rather than an inference.

**Assessability is what the ceiling buys.** A closed operator set makes flows decidable: whether a branch is reachable, whether a state space is covered, whether two flows command the same actuator. Turing-incompleteness is not the declarative tier's limitation but its feature — it is what makes those questions answerable at all. Infix text is display only: a tree renders to `payload.temperature > 150 AND NOT manual_override` for a human, and an editor may compile typed text back into a tree, but the wire format is the tree.

**`TsFlowRunner` is the escalation.** Loops, PID control, an FFT over vibration data, a platform call — none of that belongs in a declarative pipeline. Same capability-discovery shape, but it accepts source, runs it in an isolated context, and can deploy a persistent worker. To the rest of the network a synthesised script looks exactly like a hardcoded node — it implements the same contracts and appears in the same dropdowns. That gives a model two tiers rather than one, with the boundary explicit instead of discovered the hard way.

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

## Authorization

Every feature above causes calls to happen on real devices, so the authorization model is stated once and held rigidly. None of its rules is new — each already ships somewhere in the library, which is the evidence the model is livable rather than aspirational:

1. **The grant lives on the side that bears the consequence.** The scripted node names `--scriptable-by`; the rendering console names whose panels it shows; the target of a wired event authorizes its callers. The requester never grants itself anything.
2. **Default is none, and absence is invisible.** No grant, no namespace published, no tool advertised — a peer that may not do a thing does not learn the thing exists.
3. **Keys travel out of band.** A bus able to hand over the key that unlocks the bus is a bus able to unlock itself; remote desktop, a phone call, paper.
4. **Across a relay, only signed frames carry identity.** Per-connection identity does not survive a relay and no flag changes that — the information is not there to have.
5. **The UI layer is never the security boundary.** Enforcement is the target's `authorize` plus schema validation at the call boundary; chrome and confirmations shape behaviour, they do not gate it.
6. **Capability is a claim, never a right.** Implementing an interface advertises what a peer can do; whether anyone may ask it to is a separate, granted question.
7. **Per-artifact identity.** A deployed flow, worker or script is a peer with its own name and key, never borrowing its deployer's — scripts already work this way, and it is what lets grants stay narrow and an assessment attribute an action to the artifact that took it.

And the clause that makes it stick: **a feature specification without its authorization paragraph is incomplete.** Who grants, where the grant lives, what the target checks — written before the feature is designed further, not retrofitted after the wiring ships, because retrofitting grants onto shipped wiring is how permissive defaults calcify.

## A business: assessment first

Infrastructure has to be open to be adopted — nobody wires a factory to a protocol one vendor controls — and has to earn something to be maintained. Industrial buyers do not pay for technology; they pay for risk reduction, compliance and uptime.

**Open:** the library, the CLI and its MCP server, the AST extractor, the contract packages, the basic compiler and flow-runner nodes. A prototype on a local network should cost nothing, because adoption is what makes the schemas a standard.

**The commercial lead is assessment of existing control systems.** An audit-first platform has a dependency it cannot escape: it ingests `describe()` schemas, so it has nothing to read until the mesh is adopted — and open schemas are readable by any competitor. Assessment has no such dependency, because it reads the brown field as it is: Modbus registers, BACnet objects, OPC UA models, tag lists, PLC programs nobody has documentation for. The method is AI plus industrial knowledge plus actively trying to get information out of the system in as many ways as possible — and that instrument set already exists, because it is the CLI: `describe`, `check` and `diff` for what serves what, `record` and `replay` for behaviour, `tap` for who actually talks to whom, `bench`, `conform`, fakes for probing a hypothesis against a device that does not exist yet, and the MCP server so the model does the digging.

The open mesh is then both the probe kit and the destination: assessment finds what a customer has, the mesh is the modern path offered for upgrades and new systems, and the tool is valuable continuously rather than report-shaped, because drift — what changed since last month — is a question a plant keeps having.

Later layers, on that foundation: **audit and compliance**, where the defensible artifact is the signed assessment, the safety case and the history an auditor accepts — never the ingestion, which is open by design; **premium visualisation**, a 3D digital twin or a geographic view as a licensed peer on the broker; **fleet governance**, multi-tenant identity, deployment history for flows and scripts, who may press Emergency Stop; and **managed sandboxes**, because running untrusted synthesised code safely and highly available is genuinely hard, which is what makes it worth selling.

## Where things belong

Core versus ecosystem is the wrong axis. The repo already has a sharper one, from the versioning rule in `CLAUDE.md`: rpc and rpc-cli version together because the CLI depends on the library's exact shape. So: **what changes the schema versions together; what only reads the schema is a package.**

| where | what |
| --- | --- |
| `@source-repo/rpc` | the process-value runtime once the investigation settles; capability capture's runtime half; owner and the place/system paths as peer identity, carried in presence and `describe()`; `resubscribeFailed` naming what failed; the schema version as an exported constant with a compatibility policy |
| `@source-repo/rpc-cli` | `extract` reading property declarations and heritage clauses; the discovery cache; console UI for discovery, actions, wiring and the structure tree; the MCP surface for the same. No widgets — a widget library is where a diagnostic tool becomes a dashboard monolith |
| separate packages | the contract-only capability packages, sector-standard and project-local; `ui_compiler`; the operator-screen composer and its document format; `FlowRunner` and `TsFlowRunner`; everything WebAssembly and embedded |

Two placement notes. **Properties span both packages** — the runtime in `rpc`, the extraction in `rpc-cli` — so that feature is a coupled release across both, which the versions-together rule absorbs but the plan should state. And **the contract-only packages are the interoperability crown jewels**: they can live in separate repositories, but which packages exist is governed centrally, while role naming inside a sector package defers to that sector's standards body.

## What to build first

Not the exciting parts. Two features change the schema, and everything else in this document is downstream of them:

1. **The process-value decision, then its build.** Settle [the investigation](#properties-and-process-values) — objects, sampling, or both with one wire model — before anything hardens around it. The UI's `bind` and the expression trees' `state.*` references are unimplementable without it.
2. **Capability capture** — the widest dependency in the document: discovery, and everything built as a named interface — `UiCompiler`, `ActionProvider`, `EventProvider`, the flow runners.
3. **The schema version constant and policy** — one exported constant replacing the five hardcoded literals, a schema version independent of the package version, and a written rule for what is additive and what forces a bump — before the first external package reads the format, not after.
4. **The authorization paragraphs** — written into each feature's specification as it is designed, per the rigidity clause.

Then the ecosystem packages — compilers, flow runners, capability contracts, the composer — can be built by anyone, including someone who is not the library's author. That is the actual test of whether this is an ecosystem rather than a feature list.

## Considered and dropped

Kept because a rejected idea returns unless the reason is written down.

**Awaitable properties (`await remote.temperature`).** A mapped type turning every property into a promise and generating `setX()` methods. It fights the library rather than extending it: `proxy()` is already a carefully built proxy with traps of its own, including `$with`, and wrapping it to intercept property reads means two proxies disagreeing about what a get means.

**Properties as observables.** Exposing `Observable<string>` instead of `string` fits MQTT's pub/sub shape, but changes the class into something written for the network. The point of the library is that the class is ordinary. The [process-value investigation](#properties-and-process-values) walks near this and must answer it: the distinction under test is reactivity plumbing versus domain vocabulary, and this entry stands against the former.

**A JavaScript condition in a string.** The first flow design carried `"evaluate": "payload.temperature > 150 && …"` — JavaScript hidden in a node, in a document whose stated value was having none, and unverifiable by exactly the schema checks that make the rest of a flow checkable. Dropped for the expression tree. A string that is sometimes validated is how these systems rot.

**Unit types as a wiring veto.** Branded `Rpm` and `Celsius` making the picker refuse a mismatch. A veto on the under-specified sources that are the field's norm gets worked around by relabelling, and the relabelling poisons the metadata everything downstream reads. Units stay in the contract — as ranked, displayed, model-readable attributes, never a gate.

**Runtime class names as identity.** Discovery reading `constructor.name` at runtime. A bundler mangles it — the console's own page describes its introspection class as `m` — and no capability, designation or role can rest on a name that dies in minification. The schema is the carrier; names that matter are written down and extracted.

**Audit as the lead product.** It ingests schemas that exist only after the mesh is adopted, and open schemas are readable by any competitor. Assessment of existing systems leads, because it reads what is already there; audit layers on later, where the defensible artifact is the signed result rather than the ingestion.

**A sidecar HTTP server per node.** Serving the UI on port 7844 next to the RPC. Works locally and fails exactly where it matters — an edge device behind NAT with one outbound broker connection has no port to open.

**Raw HTML over RPC.** The first in-band design, and the one that made the iframe bridge necessary. Superseded by JSON layouts: a typed tree needs no sandbox for execution, enforces one design system across every node, and validates like any other payload. The bridge survives as the transport for compiled output.

**A CDN-loaded SPA per node UI.** Each UI opening its own connection and fetching a framework from unpkg. Multiplies broker sessions, and fails outright on an air-gapped plant network.

**A widget library inside the CLI.** The obvious move, and it turns a diagnostic tool into a dashboard monolith. First decoupled into a plugin package, then out of the process entirely — the console should not know what a Gauge is.

**The interface name as the network namespace.** DRY and tempting. An IDE rename becomes a silent infrastructure change, two implementations of one interface cannot be addressed separately, and versioning loses the place it lives.

**A TwinCAT ADS boundary node.** Mapping the PLC's memory over ADS to bridge cyclic execution into the mesh. Technically sound and explicitly abandoned — mapping raw hex offsets is a large ongoing cost for a legacy path, and shared memory beside the PLC reaches the same place without the ghosts.

**WAMR compiled into a TwinCAT C++ module.** Compiling the runtime into a TcCOM object to get inside the real-time kernel. That kernel has no standard libc, no `malloc`, and a Beckhoff-specific target library; WAMR's platform layer would have to be ported to it. User-space WAMR builds in seconds with stock GCC and reaches the process image through shared memory instead.

**Chasing hard real-time in the mesh.** Attempting sub-millisecond determinism on a general-purpose OS. Not achievable without becoming a hypervisor, and unnecessary once the PLC keeps the safety-critical tier.
