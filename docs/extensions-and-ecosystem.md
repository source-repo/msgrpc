# Extensions and an ecosystem

What Source RPC could grow — and, since the 4.1–4.3 releases, in large part what it did. This began as the ledger of designs that were **not built**; the load-bearing half has since shipped, and each section now opens with where it stands. What is built lives as fact in the code, the CHANGELOG and the package READMEs; what remains design stays here, keeping the reasoning that will shape it. Distilled from [a long conversation](https://github.com/source-repo/rpc/blob/main/notes/archived/rpc-extensions-chat.md), then hardened by [a critical review](https://github.com/source-repo/rpc/blob/main/notes/archived/extensions-and-ecosystem-review.md) that checked every load-bearing claim against the code — seven findings resolved in review, and the one it left open settled shortly after: process values are class instances, and primitive properties are rejected. The paths tried and abandoned are collected at the end rather than left lying across the middle.

One thread runs through all of it. The library already makes a network **self-describing**: a class is the contract, `extract` reads it off the AST before minification can touch it, and `describe()` serves it at runtime. Almost every idea below is a consequence of that one property — once a peer can say what it is, a console, a compiler, another peer or a model can all work out what to do with it without being told in advance.

A second thread emerged in review: the pieces keep meeting in the middle. The command semantics shipped for idempotency turn out to grade the UI's confirmation dialogs; the place tree wanted for viewing ranks the wiring picker; the designations a sector's drawing standard prints on cabinet labels are the role names a capability contract declares. Where a design needed a mechanism, an existing one kept fitting — which is usually the sign the designs pull in one direction.

| | | |
| --- | --- | --- |
| [Process values](#process-values) | the gap in the programming model, closed as objects | carrier **built**; domain classes pending |
| [The concurrency model](#the-concurrency-model) | the peer is an actor; say so and default accordingly | **built** 4.2.0 |
| [Observable components and work queues](#observable-components-and-work-queues) | the 4.1/4.2 spec, adopted with six amendments | **built** 4.2.0 / queue 0.2.0 |
| [Topology and structural context](#topology-and-structural-context) | parent, owner, and inherited context, federated | **built** 4.2.0–4.3.0 |
| [Server-driven UI](#server-driven-ui) | a node describes its interface; something else renders it | design |
| [Capability discovery](#capability-discovery) | find by what a peer *does*, address by *which* peer it is | **built** 4.2.0 |
| [Actions and events](#actions-and-events) | interaction surfaces a console and a model share | design |
| [Server-driven logic](#server-driven-logic) | expression trees, structure, and where declarative stops | design; its structure axis **built** |
| [Execution tiers](#execution-tiers-and-the-real-time-boundary) | how far down toward the metal this goes | positioning |
| [Authorization](#authorization) | seven rules, held rigidly | held through every build |
| [A business: assessment first](#a-business-assessment-first) | why any of it gets maintained | direction |
| [Where things belong](#where-things-belong) | what is core, what is a package | held; queue landed as placed |
| [What to build first](#what-to-build-first) | the two features everything else waited on | **all of it built** |
| [Considered and dropped](#considered-and-dropped) | with the reasons, so they stay dropped | standing |

## Process values

**Status: the carrier is built; the vocabulary is next.** The observable component shipped in 4.2.0 — snapshots, epoch/revision, per-channel status, extraction, validation, the console panel — exactly as the layered design below places it. What remains design here is the entry: the process-value domain classes (`Temperature`, `Setpoint`) and the sector contract packages they live in, and with them the extractor's projection rule.

**A process value is a class instance, and there are no primitive properties.** The `@rpcProperty` decorator on a bare field — this section's earlier draft — is rejected outright, not kept as sugar and not kept as a debug view; the reasoning is written into [the dropped list](#considered-and-dropped) so it stays rejected. Everything downstream that binds live state — the UI's `bind`, the expression trees' `state.*` references — builds on this section, which is why it sits first in [the build order](#what-to-build-first).

Methods and events cross the wire; plain properties never will. The friction was real rather than incidental — a TypeScript setter cannot return a promise, so `remote.pressure = 100` has nowhere to put a `TransportError`, a timeout, or an idempotency key — and the rule that survives is the one the whole library is built on: a write is fallible and awaitable, so a write is a method, and client-side setters throw.

```typescript
@rpcNamespace('oven', { version: '1' })
export class Oven {
    temperature = new Temperature({ throttle: 500, hysteresis: 0.5, unit: '°C', designation: 'GT11' })
    setpoint = new Setpoint({ unit: '°C', min: 0, max: 120 })
}
```

The industry has never modelled a process value as a bare number — OPC's value–quality–timestamp triple, BACnet's analog objects with present-value, status-flags and units, WebPort's per-tag sheet; the tag is an object in every system that has lived long in this domain. The object earns its place four times over. It is its own interception point: server code writes through it, so there is no wrapper around the host to be outrun — the constructor-timer trap that sank primitive interception cannot exist. It gives **quality** somewhere to live: a shadow whose resubscription failed marks `quality: 'stale'` on exactly the affected values, and a read is never silently wrong because the read carries its own verdict. It gives **forcing** and simulation a home, which the maintenance surface wants visible. And it attaches the write discipline to the value itself: a `Setpoint`'s `set` is an idempotent command, async and fallible on the client shadow, checked at the owner's boundary against the declared range.

This is not the dropped observable-property idea returning. An `Observable` is reactivity plumbing, written for the network; a process value object is domain vocabulary — the thing a standalone control program with no network attached would still contain, alarm limits and all. Ordinary industrial code has had tag objects for fifty years; it is the bare float that is ordinary only in web code. And the explicit object gives a model more to read: completing `temperature.` reveals value, quality, unit and forced, and teaches the domain in a way a bare float never did.

The extractor has already been run against the design, so the wire model is fact rather than plan. The data shape extracts today — `ProcessValue<number>` and `ProcessValue<string>` distinct and correct, a subclass flattening its inheritance into a named type — and behaviour is refused loudly: give the class `set` and extraction fails with *is a function, which cannot be checked on the wire*. So what crosses is the **data projection**, and the one piece of new extractor work is the projection rule: a recognized process value strips its behaviour and keeps its data. Instantiated generics inline anonymously (the `Record<string, number>` collision, `extract.ts:51`), so nominal recognition means a named subclass per role — which is [the sector designations below](#actions-and-events) arriving from the other direction: `Temperature` is a class the way `GT` is a designation.

The shape that falls out has a name. Reads come from a **replicated shadow** that never contends and carries its own quality; writes are **commands through the owner's inbox**, serialized by [the concurrency model](#the-concurrency-model). Commands and queries split along exactly the line the contract's semantics already draw, without anyone imposing an architecture on top.

**The carrier is settled too, and it is layered.** [The 4.1/4.2 design spec](https://github.com/source-repo/rpc/blob/main/notes/extending-rpc-design/source-rpc-next-design-spec.md) — adopted in [Observable components and work queues](#observable-components-and-work-queues) below — supplies the generic transport: an observable component whose `props` and `state` snapshots ride epoch/revision ordering, a race-free targeted snapshot on subscribe, and a per-channel status of `initializing | live | stale | closed`. The process value is the *entry*, not the transport: a pump's `state` carries `{ temperature: ProcessValueData, … }`, the component moves it, and the domain classes — `Temperature` with its designation, unit and range — live in the sector contract packages where `GT11` was already headed. The spec's own words draw the same line: industrial quality/timestamp wrappers belong in domain libraries. Channel status and per-value quality then compose instead of competing — the status says whether the picture as a whole is current, the quality says whether one reading within it is trustworthy — which also settles the earlier `$link` question at the right scope.

Two details of broadcast filtering carry over, and one placement follows from the layering. The local mutation is never filtered — only the broadcast is, or the owner's own logic reads stale values it wrote itself. The throttle is trailing-edge: drop the intermediate frames, send the final value when the window closes, or a client settles on whatever the value happened to be mid-swing. And **per-value filtering lives with the value, not the component**: the spec's `minPublishIntervalMs` coalesces the whole snapshot, which is right for the channel and useless for telemetry — a 10 Hz analog beside a mode enum needs its own throttle, hysteresis and deadband, applied by the process value before it reaches `setState`. These filter broadcast *magnitude* at the source; they are not the logic tier's time operators, which absorb threshold crossing — both layers stay. What remains is build work, not model questions: the write-path grants, and the console rendering channel status beside per-value quality.

## The concurrency model

**Status: built** (4.2.0). Graded execution defaults, the bounded mailbox answering `Busy`, and setpoint-shaped commands conflating into `Superseded` all shipped as designed.

**A peer is an actor in every sense that carries load, and the design's job is to say so and default accordingly.** The library already has the pieces: `execution: 'serial'` is a mailbox — one promise chain per instance, or per key, which is actor-per-unit; the deadline is deliberately read *after* the wait in that queue, so a command that queued past its ttl is refused rather than applied late — the stale-setpoint hazard every naive mailbox has, already handled; and the idempotency claim happens before the run, so a duplicate is recognised before a sibling starts the same command alongside it.

The vocabulary matters less than it seems. Erlang's `gen_server` — the actor tradition's own workhorse — is a process with named operations, handling one message at a time, where `call` blocks the caller until the reply. That *is* typed methods over async. What is genuinely modern is not tell-only messaging but **explicit concurrency discipline instead of accidental interleaving** — and accidental interleaving is exactly what the current default permits: `parallel` execution on a stateful node lets two awaited calls interleave at every `await` inside them, shared-state races without a thread in sight. That, not the class syntax, is the discredited part of OOP.

**Execution defaults are graded by the semantics already in the contract.** A `query` runs parallel; `idempotent-command` and `non-repeatable-command` serialise, per instance or per declared key. A stateful node then gets the actor guarantee without anyone typing a word, and a pure query never waits behind a command. The explicit `execution` declaration stays as the override.

**The mailbox is bounded.** The queue is currently an unbounded promise chain, and an industrial inbox must not be: a flooded node sheds load with a loud `Busy` refusal instead of executing a backlog into a plant that has moved on. Dequeue-time expiry already catches the stale; bounding catches the flood. A refinement the semantics also grade: latest-wins conflation for setpoint-shaped idempotent commands, strict FIFO for non-repeatable sequences.

**A sequence is either one message or held authority.** "A command completes before someone else modifies the state" has two levels, and the mailbox only solves the first. Within one call: serialisation, done. Across a sequence — read, decide, ramp, verify, with nobody interleaving — no actor system solves that with mailboxes either, and the two honest answers are both already in this document's spirit. Push the sequence into the owner so it becomes one message — which is what the scripting and flow tiers are for. Or **command authority**: not a mutex but the arbitration concept every real plant has — local/remote, HMI-in-control, the teach pendant that owns the arm. An `acquire`/`release` lease with a timeout, `controlledBy` visible as a process value so everyone can see who holds the unit, and the safety tier overriding everything. Authority composes with [the authorization model](#authorization) rather than adding a mechanism: it is granted, visible, and it expires.

What is deliberately not imported from actor frameworks: tell-first untyped messaging, which would trade away the typed contract that is this library's entire value; supervision trees as doctrine, though the owner tree is already the right shape if supervision ever wants a home; and virtual-actor machinery — the plant hands out identity physically, and nobody needs a framework to invent it.

## Observable components and work queues

**Status: built.** The components shipped in 4.2.0 with every amendment below honoured; the queue shipped as `@source-repo/queue` — 0.1.0 with the full lease state machine, 0.2.0 with `latest` task context made real by the context resolver.

[The 4.1/4.2 design spec](https://github.com/source-repo/rpc/blob/main/notes/extending-rpc-design/source-rpc-next-design-spec.md) is **adopted** as the design for both capabilities — the observable component (cached `props`/`state` snapshots, epoch/revision ordering, race-free subscribe, per-channel status) and the lease-based work queue (acquire-ID replay, lease tokens, retry and dead-letter state machine, reject-new capacity, the at-least-once statement said plainly). It was written against the 4.0 code and its refusals are as valuable as its designs: no stringly-typed dispatch beside the typed contract, no MQTT shared subscription dressed up as a work queue, no zero-copy claim the runtime cannot keep. Its §2.1 prerequisites — the per-call timeout, the zero-timeout timer bug, event-subscription reference counting, peer lifecycle forwarding — are core fixes worth shipping ahead of everything else. Six amendments ride the adoption.

**Two paradigms, three primitives.** MQTT's retained message and RabbitMQ's queue are not two flavours of one thing — they are different promises, and forcing either through the other's primitive is how both traditions go wrong. *Last-value* — a control system's "what is the current state" — is the observable component: the targeted snapshot on subscribe is retained-message semantics done with authorization, and coalescing is conflation done honestly, because for state only the newest value was ever the point. *Every-value* — work that must not be lost — is the queue: reject-new only, leases, dead letters, and **a queue that conflates is not a queue, it is a last-value cache wearing a queue's clothes**. *History* — replay, trends, what happened while nobody watched — is neither, and belongs to a historian tool node when one earns its place. Naming the boundary keeps each primitive honest about which promise it makes.

**The queue is a package, not a core subpath.** It lands as `packages/queue` in this repository — its own npm package, its own version, the first tool node of the ecosystem. The reasoning is this document's own placement axis: the queue only reads public APIs, and the versions-together rule exists for the CLI's exact-shape dependency, which the queue does not have. The workspace placement keeps what a core subpath would have bought — the broker CI, conformance tests running against HEAD core so drift is caught at commit time — while keeping what it would have cost: the queue becomes the first external consumer of the schema version policy, the founding example of the tool-node pattern with a capability contract and per-artifact identity, and extractable to its own repository later without breaking a single import. The contract stays inside the implementation package until a second backend appears; the split trigger is written down rather than hoped for.

**Component classes declare their methods.** The spec keeps `setState` off the wire by making it an own-property arrow function the exposure scan happens not to walk. That works and is fragile the way all scan-blind-spot reliance is fragile: a component class is required to use `@rpc` marks, so the allow-list is the guarantee and the scan behaviour is merely consistent with it.

**Codes for the protocol, results for the domain.** `Busy` and `Superseded` are execution-layer refusals any method can meet, and they are RPC codes. A queue reporting `full` or `lease-lost` is a service answering a business question, and those are discriminated results the wrapper may turn into typed errors. The global error vocabulary grows only for conditions the protocol itself can produce — written down here so it never creeps.

**Authorization paragraphs are still owed.** The spec's security section is sound but does not everywhere meet the rigidity clause: the component channel's grant (who may observe, where that grant lives), the queue's produce/consume/admin separation as concrete `authorize` rules, and the admin surface's command semantics — retrying a dead letter is a consequential command and its declaration should say so — are written before implementation, per [the authorization model](#authorization).

**Per-value filtering stays with the value**, as the [process-values section](#process-values) records: the component coalesces the channel, the process value filters itself.

## Topology and structural context

**Status: built**, across 4.2.0 and 4.3.0: the federated topology core with durable epochs, the owner fence on calls, opt-in remote mutation, the console's trees, and then the whole context layer — tokens, providers, the cross-host resolver with atomic remounts and named rings, and bounded capture. The coordinated `TopologyAuthority` remains what the amendments made it: a deferred adapter contract.

[The distributed topology and context spec](https://github.com/source-repo/rpc/blob/main/notes/extending-rpc-design/source-rpc-distributed-context-topology-design-spec.md) is **adopted with amendments**, settled through [a review round](https://github.com/source-repo/rpc/blob/main/notes/extending-rpc-design/source-rpc-distributed-context-topology-design-spec-review-review.md) that accepted most of the first review and improved the rest. The spine survives intact: `parent` is physical location, `owner` is logical scope, identity depends on neither, paths are display data derived by lookup, context is an immutable versioned view inherited through exactly one declared axis, and shared mutable state stays in an authoritative component rather than becoming transparent distributed memory. Its Phase 0 prerequisites are the component work already shipped, which is the sequencing test an honest spec passes.

**Two consistency profiles, one implementation.** The topology core is *federated* by default — each component's home host is the sole writer of its outgoing `parent` and `owner` edges, cycles are detected rather than prevented, reverse indexes are eventually consistent projections, deletion leaves tombstones. The *coordinated* profile — the central `TopologyAuthority` with guaranteed acyclicity, authoritative indexes and strict deletion — is defined as an adapter contract and built only when a managed deployment needs it, because two concurrent root-to-root commits genuinely can race into a cycle that no host-local check catches, and a deployment that cannot live with detection should buy prevention explicitly. Which guarantees are active is stated in a capabilities record surfaced through `describe()`, so no implementation silently promises another's strength.

**A cycle is detected invalid topology, never tolerated topology.** The affected axis reports `invalid` with a named reason — `cycle` with the path, `depth-exceeded`, `invalid-reference` — resolution uses a visited set because a depth limit cannot tell a cycle from a deep plant, `require()` fails regardless of stale policy, topology-dependent authorization fails closed, and ordinary methods that do not depend on topology continue.

**Invocation context is an explicit handle, because a browser is a full peer.** `currentRpcInvocation()` over AsyncLocalStorage would be the first library surface that works in Node and silently degrades in a page that hosts real services. Instead a method opts in with `@rpc({ injectInvocation: true })` and receives a branded `RpcInvocation` as its final parameter — context, `AbortSignal`, and `invocation.call()` for propagation with correlation, causation and the remaining deadline. The proxy type strips the parameter from the caller's signature and the extractor omits it from the wire schema; ALS may exist as Node-only sugar and nothing portable may depend on it. Not a mutable `this.invocation`, which two suspended handlers on one instance would race on.

**Every host has one effective root, not one registered ceremony.** A host that declares no root gets a synthetic, durable `$host` — the `$` prefix already means reserved here — stable across restarts, hidden from ordinary discovery, default parent of top-level components, and carrier of the host's one permitted cross-host physical edge. Small peers need do nothing.

**One lifecycle vocabulary.** The public status is `initializing` — the spec's `resolving` survives only as the resolver's internal name — joined by `invalid`, with a `transitionReason` distinguishing initial load from owner remount from reconnect. `stale` keeps the narrow meaning the component channel already gave it: the same mount, freshness no longer established, last value readable with its age on it.

**Epochs are durable, normatively.** A topology mutation is acknowledged only after parent, owner, version and both epochs are atomically in the durable store. A restart never changes an epoch; an owner mutation always does, even A-to-B-and-back; a restored backup rotates epochs so commands fenced out yesterday do not come back valid; fenced methods stay unavailable until durable state is loaded; a volatile profile must advertise itself as one. The fence check itself is target-local — the component compares the carried `ownerEpoch` to its own durable record — so command fencing works under the federated default with no authority anywhere.

**Remote topology mutation is opt-in, and its authorization is the design.** A host refuses `msgrpc.updateTopology` wholesale unless started with `topology.allowRemoteMutation` - a deployment that never enables it has no new surface at all - and an enabled host still passes every mutation through `authorize()` with the instance and patch visible, which is where a plant names who may restructure it. The CAS `expectedVersion` is mandatory, so there is no blind write and a retry after an uncertain outcome fails the version check instead of applying twice. Reading rides the introspection gate: listing where everything sits is reconnaissance of the same order as listing what everything does. The per-call owner fence is the caller's half: `$with({ ownerEpoch })` on any call refuses `OwnershipChanged` when the target's generation moved while the command was in flight, queued or retried - and a fence against an instance with no record fails closed.

**The resolver is last, and context is its own milestone.** Topology core, then invocation and fencing, then the queue envelope, and only then the distributed context resolver — the largest single piece of machinery in the spec, built to move the least dynamic data, which is exactly why it must not lead. The queue adopts the `snapshot | latest` context discriminant on the wire now and capability-gates `latest` until the resolver exists: specify the context model now, implement the distributed resolver later.

## Server-driven UI

**Status: design.** Its gating dependency — process values to `bind` against — now exists in carrier form, so this is buildable when wanted.

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

`bind` is what makes it more than a layout format: `state` names the process value to read from the node's telemetry, `action` names the RPC method to call. The renderer wires both from the proxy it already holds — which depends on [process values](#process-values) existing, and is why they gate this design.

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

**Status: built** (4.2.0). `implements` becomes a package-qualified capability at extract time with the closure flattened in, `describe()` serves it from the schema, and `source-rpc find` and the MCP `find_capability` answer with who implements what — a hallucinated capability answering empty, and a wrong-shaped call failing `InvalidParams` before the wire.

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

**Status: design.** The designation vocabulary it leans on arrives with the sector contract packages.

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

**Status: design — except the structure it consumes.** Both axes now exist as topology records and the console draws both trees, so the selectors' "where" coordinate is real; the expression trees and the flow runner remain design.

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

**Where the structure comes from.** Two axes, because a physical structure and a logical one answer different questions about the same node: a pump is *in* building A, fire cell 3 — and it is *part of* the cooling system of line 2. **Place** is the physical path, declared at deployment beside `--name` and never in the class contract, because the same `PumpController` class is bolted into every building. **Owner** is the logical axis's foundation: a process that stands up several nodes declares which belongs to which — which is also what turns the console's flat list of three-word names into a tree worth looking at, a viewing win that stands on its own. A logical **system** path extends the same idea across hosts. A node inherits both paths from its owner unless it overrides them, so commissioning sets one place per host — and the override case is real, a sensor owned by a machine's controller but mounted in the next room. A folder on either axis is a path segment, not an entity — no lifecycle, nothing to go offline, no functionality to define — so grouping buildings A and B while C stands alone is just path depth, `campus/ab/building-a` beside `campus/building-c`. Path segments are ids; display is the **label**'s job — free Unicode, exactly what the project's Excel and the plant drawings say, `+A1-KF10 "Kylvatten, framledning"` and all, because the drawing always wins and yelling about identifier rules never does. A label never appears in a topic, a key or an address — that rule is what makes any-character labels safe — and it is never required to be unique; the path disambiguates. Beside the standard `designation` on a value, the label is the project's own name for the thing: the picker searches both, delivery uses neither. The logical path defaults to the owner chain, so zero configuration yields the tree of who created whom; overriding it takes a sequence of ids — a convention, not a liveness requirement, so nothing dissolves when a referenced node is offline, but the console can link a segment to its node when it exists and the audit layer can ask whether a declared parent has ever been seen. Overriding the logical path does not reparent ownership: owner is fact, the logical path is declaration, and when they diverge both stay readable. What does not dissolve is that declared membership can be wrong or missing, and on the place axis that is a safety fault: the audit rule is that every peer with a safety capability declares a place, every cell expected non-empty is checked non-empty, and supervision extends from "a member left the bus" to "a member was never declared". Whether a third axis ever earns its way in — electrical feeders, maintenance regions — is deliberately deferred: the naming accommodates one, so each is refused until an installation demands it.

**Observability is the point, not a bonus.** Every node of the tree has a current value, and a runner that publishes per-node evaluation state gives any viewer a live-highlighted diagram — ladder logic's lit rungs, which is much of why simple logic has survived in the PLC world. The console renders that with machinery it already has, and it reaches the model too: asked why the pump started, a model reads the recorded evaluation states and answers with an explanation trail rather than an inference.

**Assessability is what the ceiling buys.** A closed operator set makes flows decidable: whether a branch is reachable, whether a state space is covered, whether two flows command the same actuator. Turing-incompleteness is not the declarative tier's limitation but its feature — it is what makes those questions answerable at all. Infix text is display only: a tree renders to `payload.temperature > 150 AND NOT manual_override` for a human, and an editor may compile typed text back into a tree, but the wire format is the tree.

**`TsFlowRunner` is the escalation.** Loops, PID control, an FFT over vibration data, a platform call — none of that belongs in a declarative pipeline. Same capability-discovery shape, but it accepts source, runs it in an isolated context, and can deploy a persistent worker. To the rest of the network a synthesised script looks exactly like a hardcoded node — it implements the same contracts and appears in the same dropdowns. That gives a model two tiers rather than one, with the boundary explicit instead of discovered the hard way.

## Execution tiers and the real-time boundary

**Status: positioning, unchanged.**

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

**Status: held, rigidly, through every build.** Each shipped feature carried its authorization paragraph before implementation — the component channel's subscription path, the queue's produce/consume/admin split, topology mutation's opt-in, the context service's silent local-exposure filtering — and the rule did its work: no feature shipped with authorization as an afterthought.

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
| `@source-repo/rpc` | the observable-component machinery and the spec's §2.1 prerequisites; command authority; capability capture's runtime half; owner and the place/system paths as peer identity, carried in presence and `describe()`; `resubscribeFailed` naming what failed; the schema version as an exported constant with a compatibility policy |
| `@source-repo/rpc-cli` | `extract` reading property declarations and heritage clauses; the discovery cache; console UI for discovery, actions, wiring and the structure tree; the MCP surface for the same. No widgets — a widget library is where a diagnostic tool becomes a dashboard monolith |
| separate packages | the work-queue tool node, as `packages/queue` — a workspace in this repository with its own version; the contract-only capability packages, sector-standard and project-local, where the process-value domain classes live; `ui_compiler`; the operator-screen composer and its document format; `FlowRunner` and `TsFlowRunner`; everything WebAssembly and embedded |

Three placement notes. **Components span both packages** — the runtime in `rpc`, the extraction in `rpc-cli` — so that feature is a coupled release across both, which the versions-together rule absorbs but the plan should state. **A workspace is not the versions-together rule**: rpc and rpc-cli version together because the CLI depends on the library's exact shape; `packages/queue` shares the repository for its CI and HEAD-parity tests and versions on its own — worth a line in `CLAUDE.md` the day the workspace appears, so nobody generalizes the rule by accident. And **the contract-only packages are the interoperability crown jewels**: they can live in separate repositories, but which packages exist is governed centrally, while role naming inside a sector package defers to that sector's standards body.

## What to build first

**Status: all of it built**, in the order argued for below, across 4.1–4.3 — and the ecosystem test this section names was run: `packages/queue` was built against public APIs only, gated on the version constant and the component machinery, exactly as written. The section stands as the record of the order chosen and why.

Not the exciting parts. Two features change the schema, and everything else in this document is downstream of them:

1. **The 4.1 core.** The spec's §2.1 prerequisites first — the zero-timeout timer bug is live today — then the observable-component machinery and the extractor emitting `props` and `state`, then command authority. Graded execution and the bounded mailbox have already shipped. The UI's `bind` and the expression trees' `state.*` references are unimplementable without the components; the process-value domain classes ride the first sector contract package rather than the core.
2. **Capability capture** — the widest dependency in the document: discovery, and everything built as a named interface — `UiCompiler`, `ActionProvider`, `EventProvider`, the flow runners.
3. **The schema version constant and policy** — one exported constant replacing the five hardcoded literals, a schema version independent of the package version, and a written rule for what is additive and what forces a bump — before the first external package reads the format, not after.
4. **The authorization paragraphs** — written into each feature's specification as it is designed, per the rigidity clause.

Then the ecosystem packages — compilers, flow runners, capability contracts, the composer — can be built by anyone, including someone who is not the library's author. That is the actual test of whether this is an ecosystem rather than a feature list, and `packages/queue` runs it first: the work-queue tool node, gated on the version constant and the component machinery, built against public APIs only.

## Considered and dropped

Kept because a rejected idea returns unless the reason is written down.

**Awaitable properties (`await remote.temperature`).** A mapped type turning every property into a promise and generating `setX()` methods. It fights the library rather than extending it: `proxy()` is already a carefully built proxy with traps of its own, including `$with`, and wrapping it to intercept property reads means two proxies disagreeing about what a get means.

**Properties as observables.** Exposing `Observable<string>` instead of `string` fits MQTT's pub/sub shape, but changes the class into something written for the network. The point of the library is that the class is ordinary. The [process-value decision](#process-values) answered the near-miss: a process value object is domain vocabulary — what a standalone control program would contain with no network attached — where an `Observable` is reactivity plumbing. This entry stands against the plumbing.

**Primitive properties (`@rpcProperty` on a bare field).** The plan's original first feature, rejected whole. Every hard problem in the investigation was the cost of primitives — a wrapper that code capturing `this` in the constructor could outrun, sampling versus interception, two source spellings of one wire model — and the last justification standing was debugging convenience. A bad design kept for debugging purposes will be misused: the easy spelling becomes the common spelling, and the plant ends up monitored through the mechanism that was never meant to carry it. Monitoring reads the same quality-carrying shadow as everything else; the process value is the model, with no second one beside it.

**A JavaScript condition in a string.** The first flow design carried `"evaluate": "payload.temperature > 150 && …"` — JavaScript hidden in a node, in a document whose stated value was having none, and unverifiable by exactly the schema checks that make the rest of a flow checkable. Dropped for the expression tree. A string that is sometimes validated is how these systems rot.

**Unit types as a wiring veto.** Branded `Rpm` and `Celsius` making the picker refuse a mismatch. A veto on the under-specified sources that are the field's norm gets worked around by relabelling, and the relabelling poisons the metadata everything downstream reads. Units stay in the contract — as ranked, displayed, model-readable attributes, never a gate.

**Runtime class names as identity.** Discovery reading `constructor.name` at runtime. A bundler mangles it — the console's own page describes its introspection class as `m` — and no capability, designation or role can rest on a name that dies in minification. The schema is the carrier; names that matter are written down and extracted.

**Audit as the lead product.** It ingests schemas that exist only after the mesh is adopted, and open schemas are readable by any competitor. Assessment of existing systems leads, because it reads what is already there; audit layers on later, where the defensible artifact is the signed result rather than the ingestion.

**One queue with a last-value mode.** A single queue contract whose conflating mode serves state distribution — the MQTT-retained and RabbitMQ worlds folded into one primitive. Dropped because the two make different promises: conflation in a work queue silently skips work a caller was promised, and last-value already has its own primitive, the observable component, where conflation is the honest behaviour because for state only the newest value was ever the point. Two primitives, each keeping the promise it names.

**MQTT retained messages as the component cache.** Publishing a component snapshot as a retained message, so a late subscriber reads current state from the broker without asking the server. Tempting as a transport acceleration and dropped for the authorization hole: no snapshot is sent before the subscription is authorized, and a retained topic answers anyone the broker ACL admits — the server's `authorize` never runs. Could return only for deployments where broker ACLs *are* the grant, stated explicitly, never as a silent default.

**A sidecar HTTP server per node.** Serving the UI on port 7844 next to the RPC. Works locally and fails exactly where it matters — an edge device behind NAT with one outbound broker connection has no port to open.

**Raw HTML over RPC.** The first in-band design, and the one that made the iframe bridge necessary. Superseded by JSON layouts: a typed tree needs no sandbox for execution, enforces one design system across every node, and validates like any other payload. The bridge survives as the transport for compiled output.

**A CDN-loaded SPA per node UI.** Each UI opening its own connection and fetching a framework from unpkg. Multiplies broker sessions, and fails outright on an air-gapped plant network.

**A widget library inside the CLI.** The obvious move, and it turns a diagnostic tool into a dashboard monolith. First decoupled into a plugin package, then out of the process entirely — the console should not know what a Gauge is.

**The interface name as the network namespace.** DRY and tempting. An IDE rename becomes a silent infrastructure change, two implementations of one interface cannot be addressed separately, and versioning loses the place it lives.

**A TwinCAT ADS boundary node.** Mapping the PLC's memory over ADS to bridge cyclic execution into the mesh. Technically sound and explicitly abandoned — mapping raw hex offsets is a large ongoing cost for a legacy path, and shared memory beside the PLC reaches the same place without the ghosts.

**WAMR compiled into a TwinCAT C++ module.** Compiling the runtime into a TcCOM object to get inside the real-time kernel. That kernel has no standard libc, no `malloc`, and a Beckhoff-specific target library; WAMR's platform layer would have to be ported to it. User-space WAMR builds in seconds with stock GCC and reaches the process image through shared memory instead.

**Chasing hard real-time in the mesh.** Attempting sub-millisecond determinism on a general-purpose OS. Not achievable without becoming a hypervisor, and unnecessary once the PLC keeps the safety-critical tier.
