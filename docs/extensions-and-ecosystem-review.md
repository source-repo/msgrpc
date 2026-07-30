# Review: extensions and an ecosystem

A critical review of [extensions-and-ecosystem.md](extensions-and-ecosystem.md), written to drive its revision. The findings came from checking that document's claims against the code as it stands; the resolutions accumulate as they are worked out, so a finding marked **resolved** has its answer in the second half of this file and a finding marked **open** does not yet. When the revision lands, this document has done its job.

| finding | | status |
| --- | --- | --- |
| [1. The capability string does not survive to runtime](#1-the-capability-string-does-not-survive-to-runtime) | discovery's foundation | **resolved** |
| [2. The flow condition is JavaScript in a string](#2-the-flow-condition-is-javascript-in-a-string) | the exact thing the design claims to avoid | **resolved** |
| [3. Server-driven UI moves the trust boundary](#3-server-driven-ui-moves-the-trust-boundary) | it does not remove one | **resolved** |
| [4. Signature compatibility is not safety compatibility](#4-signature-compatibility-is-not-safety-compatibility) | RPM wires cleanly into celsius | **resolved** |
| [5. The shadow copy is rigorous about writes and casual about reads](#5-the-shadow-copy-is-rigorous-about-writes-and-casual-about-reads) | three concrete gaps | **investigating** |
| [6. The schema version is a magic number](#6-the-schema-version-is-a-magic-number) | in five places, with no policy | **resolved** |
| [7. Authorization is absent throughout](#7-authorization-is-absent-throughout) | every feature is a new way to cause a call | **resolved** |
| [8. The moat is thinnest where the value is claimed highest](#8-the-moat-is-thinnest-where-the-value-is-claimed-highest) | audit ingests what competitors can ingest | **resolved** |

Then [where things belong](#where-things-belong) and [what to build first](#what-to-build-first), which the revision should fold in.

## The findings

### 1. The capability string does not survive to runtime

The document says the interface name "survives as a string in the schema" in the present tense. Today it does not: `extract.ts` has no handling for heritage clauses at all — it records `className` only, and that is the implementation's name, not a capability.

Worse, discovery as described searches `describe()` output at runtime, and `Introspection.ts:187` builds that from `instance.constructor?.name`, which a bundler mangles. This is not hypothetical: the console's own browser page answers `describe()` with `"className": "m"`. A browser peer is a first-class peer here, and the one property this section depends on — a nominal name surviving to the network — is exactly what minification destroys.

The same `describe()` answer also contains the proof of what does survive: `"paramNames": ["from", "text"]`, intact, because parameter names ride in the extracted `chat.types.json` embedded at build time. Same peer, same call, two paths — schema data survives minification, runtime reflection does not. The resolution below puts capabilities on the surviving path.

There is also no uniqueness or ownership scheme: `UiCompiler` from two vendors are different things, and a bare interface name cannot say whose it is. The resolution covers this too.

### 2. The flow condition is JavaScript in a string

```json
{ "type": "condition", "evaluate": "payload.temperature > 150 && state.manual_override == false" }
```

The stated value over Node-RED is "a typed, diffable, version-controllable document rather than untyped payloads with JavaScript hidden in nodes". That `evaluate` string is JavaScript hidden in a node. And the claim that a flow "can be checked against the network's schemas before deployment" is false for the only part of it that carries logic — `targetNodeId` and `method` validate, the predicate does not.

Two honest ways out, and the revision should pick one. Either the condition gets a real expression grammar — parsed, total, type-checked against the event's payload schema — or conditions are pushed down to the `TsFlowRunner` tier and the declarative tier stays genuinely declarative. A string that is sometimes validated is how these systems rot, which is the document's own sentence. The resolution below takes the first path, in a form that needs no parser at all.

### 3. Server-driven UI moves the trust boundary

"There is no untrusted code to sandbox" and "rendering is still sandboxed" sit two paragraphs apart. Both are true of different things, but the comfort drawn from the first is not earned: the *layout* is a typed tree, and the *compiler* is a discovered third-party peer that returns HTML which the console renders, with a `postMessage` bridge that can invoke methods on a real device. A peer that advertises `UiCompiler` gets its markup into your console and a channel that makes RPC calls.

The sandbox choice is right — `sandbox="allow-scripts"` without `allow-same-origin` — and the revision should carry a warning for whoever implements it: adding `allow-same-origin` alongside `allow-scripts` voids the sandbox entirely.

The deeper problem is who chose the compiler. Discovery picks it, and per [security-model.md](security-model.md) identity is per-connection and does not survive a relay — on a relayed bus nothing can authenticate which peer answered the discovery. Compiler selection has to be configuration, or a signed grant, not "whoever answers". The revision should say so and cross-reference the security model, which the current document never cites. The resolution below goes further, because the sandbox turned out to be the shallow half of the finding.

### 4. Signature compatibility is not safety compatibility

The event-wiring dropdown filters by type: an event emitting a `number` offers only methods taking one. In a document whose running examples are a boiler and a cooling pump, that filter passes the wiring of an RPM reading into `setTemperature(celsius: number)`. The type system says yes; physics says no.

This is the one finding where getting it wrong damages equipment. The contract needs either branded/unit types that the extractor can carry (`Rpm`, `Celsius` as distinct schema types, so the filter can refuse), or the wiring flow needs an explicit human confirmation step that displays both ends' names and units. Preferably both, since only the first helps a model. The resolution below keeps the units and drops the veto — the field's experience is that a picker that refuses is a picker worked around.

### 5. The shadow copy is rigorous about writes and casual about reads

The argument for keeping writes as methods is that failure must be legible. Reads then return a possibly-stale cache with no signal. The design's own logic, applied to its other half, exposes three gaps:

- `resubscribe()` (`RpcClientHandler.ts:161`) reports failure as a **count** via `resubscribeFailed`. A shadow copy cannot mark the right properties stale from a count. The event needs to name the subscriptions that failed — worth doing regardless of this document.
- Hydrate-then-subscribe has no sequence number, so an update that lands between the snapshot and the subscription is lost or applied out of order. The push needs a monotonic counter the hydration snapshot also carries.
- The server-side `Proxy` `set` trap only sees writes made through the proxy. A `setInterval(() => this.temperature = read(), 100)` started in the constructor captured the raw `this` — the single most common sensor pattern would silently never broadcast. Either the wrapping happens before user code can capture `this` (which `exposeClassInstance` cannot guarantee for constructor-started timers) or the limitation is documented as loudly as the feature.

Small but same family: `@rpcProperty({ hysteresis: 0.5 })` on a `string` property is meaningless and should fail at extract time, not be silently ignored.

### 6. The schema version is a magic number

`schema: 1` is hardcoded in five places — `Schema.ts:92`, `Introspection.ts:132`, `extract.ts:314`, `console.ts:514`, `conform.ts:27`. No shared constant, no compatibility policy, no statement of what a bump means.

Every ecosystem package the document imagines — contract packages, compilers, flow runners, the audit platform — consumes this format. It is the ecosystem's actual product. Before anything outside this repo depends on it: one exported constant, a version independent of the package version, and a written rule for what changes are additive and what forces a bump. Accepted as-is; the resolution below is the work order.

### 7. Authorization is absent throughout

Wiring an event on one node to a method on another. Compiling and rendering UI from a third-party peer. Deploying a flow. Deploying a persistent synthesised worker. Every one of these causes calls to happen on real devices, and the document discusses none of their permissions and never references [security-model.md](security-model.md).

The library already has the pieces — `authorize`, signed frames, `--scriptable-by` as the pattern for a grant made on the node being commanded — and the revision should route every feature through them explicitly. The `--scriptable-by` shape generalises: the grant lives on the target, names the grantee, and the key travels out of band. The resolution below consolidates what the other resolutions accumulated piecewise into one rigid model.

### 8. The moat is thinnest where the value is claimed highest

"Automated configuration audit" is named the highest-value commercial piece, and its input is open, self-describing schemas — which a competitor ingests exactly as easily. What is defensible is not the ingestion but the compliance artifact: the signed audit report, the safety case, the deployment history that satisfies an auditor. The revision should claim that, and not the graph. The resolution below goes further and replaces the audit-first business entirely.

## Resolutions

### Capabilities ride the schema, declared by `implements` (resolves finding 1)

A node declares a capability by implementing a contract interface — `class Compiler implements UiBuilder` — and `extract` reads the heritage clause off the AST and writes the capability into the `.types.json`. Discovery then finds it in `describe()` output because `describe()` serves the schema; `constructor.name` is never consulted. This is the path finding 1 proved survives minification.

Better than a decorator string, in two ways that matter:

- **The type system enforces the claim.** A class that says `implements UiBuilder` and does not, fails to compile. A decorator string advertises whatever was typed.
- **`check:contract` polices renames.** The dropped-ideas section rightly feared an IDE rename silently moving infrastructure. Once the capability is in the committed contract, renaming the interface is a contract diff and a failing check — the hazard stops being silent, which was the actual problem with it.

Three requirements for it to be sound:

1. **Qualify the name by where it was imported from.** `extract` resolves `import { UiBuilder } from '@source-repo/ui-contracts'` and emits `@source-repo/ui-contracts/UiBuilder`, not the bare string. Uniqueness comes free, and shared-package identity becomes the *definition* of capability identity: two vendors' local `UiBuilder` interfaces correctly do not match, because not sharing the contract package is not sharing the contract.
2. **Compute the transitive closure at extract time.** `AdvancedUiCompiler extends UiCompiler` emits both names, so a runtime search stays a flat string match and nobody resolves hierarchies over the wire.
3. **Write down the rule this implies: discoverable ⇒ has an extracted contract.** `implements` is erased at runtime, so a class exposed without ever running `extract` cannot advertise capabilities. That is acceptable — production peers should have contracts — but it must be a stated rule, not a surprise.

Naming: `UiBuilder`, not `IUiBuilder`. The name is user-facing — it appears in `describe()` output and discovery dropdowns — and the codebase already leans that way.

**This resolution is load-bearing for most of the document, not just for discovery.** Every named interface in it is an instance of the same mechanism: `UiCompiler` is how a console finds a compiler, `ActionProvider` and `EventProvider` are how a node becomes usable without either side being rebuilt, `FlowRunner` and `TsFlowRunner` are found "the same capability-discovery shape", and an action's `ui_modal` names the compiler interface it needs — a capability reference travelling *inside a payload*. So the three requirements above apply to each of them, and the revision should carry the consequences through: every one of those interfaces lives in a shared contract package and is referred to by its qualified name (`@source-repo/ui-contracts/UiBuilder`, not `UiBuilder`) everywhere one is written down — in schemas, in discovery queries, and in payloads like `ui_modal`. A bare name in any of those places recreates the uniqueness hole this resolution closes.

### The condition becomes an expression tree (resolves finding 2)

The `evaluate` string goes. A condition is a tree of typed nodes — operators applied to operands, operands being references or literals — and the runner never parses anything, because the tree already is the parse:

```json
{ "op": "and", "args": [
    { "op": ">", "args": [ { "ref": "payload.temperature" }, { "value": 150 } ] },
    { "op": "not", "args": [ { "ref": "state.manual_override" } ] } ] }
```

The grammar is a recursive union type, which the extractor already handles, so a condition validates with the same machinery as any other payload — a tree with an unknown operator fails at the boundary the way a layout with an unknown widget type does. This shape has decades of service in embedded and building-control systems; the design below mostly writes down what that tradition already knows.

**A closed, versioned operator set, with time as the only state.** Comparisons, boolean algebra, arithmetic — all pure — plus the stateful time operators the PLC world settled on long ago: on-delay, off-delay, hysteresis. They are included deliberately, because instantaneous comparison chatters — a temperature oscillating across a threshold fires the flow at whatever rate the sensor reports — and their state is bounded to a timestamp per node. Nothing else in the set holds state. Growth pressure will come, and every operator proposed beyond the set is a request to escalate that condition to `TsFlowRunner` instead; the set is versioned like a contract because it is one. These operators are not the properties section's `hysteresis` and `throttle` wearing a second hat: those filter broadcast magnitude at the source, these absorb threshold crossing in the logic, and a perfectly filtered property still chatters a `> 150` condition when the value swings across the threshold by more than the filter band. Both layers stay.

**References type-check.** `payload.*` resolves against the event's payload schema and `state.*` against the target's declared properties, which makes the checked-before-deployment claim true — and adds an edge to the dependency graph, because the `state` half has nothing to resolve against until `@rpcProperty` is in the schema.

**The expansion step.** An operand can be a selector rather than a point: OR over every fire-alarm input in house A. A selector needs two coordinates — what kind of source, and where in a structure. Capability (the resolution above) supplies the first; the structure below supplies the second, as a path prefix on a named axis — which is the shape this tradition already had, an operator naming a level in a hierarchy and a type of source data. Expansion happens at deploy time and the selector is retained: the runner records the concrete membership, re-expands when presence changes, and emits the membership change as an event. Deploy-time-only expansion is a commissioning hazard — the alarm added to house A next month is silently not in the OR — and runtime-only expansion makes "what does this flow actually watch" unanswerable; retaining the selector gives both answers, and a fire alarm leaving the bus becomes something a flow can alarm on, which is what supervision means in that industry.

**Where the structure comes from.** Two axes, because a physical structure and a logical one answer different questions about the same node: a pump is *in* building A, fire cell 3 — and it is *part of* the cooling system of line 2. **Place** is the physical path, declared at deployment beside `--name` and never in the class contract, because the same `PumpController` class is bolted into every building. **Owner** is the logical axis's foundation: a process that stands up several nodes declares which belongs to which — which is also what turns the console's flat list of three-word names into a tree worth looking at, a viewing win that stands on its own before selectors are involved. A logical **system** path extends the same idea across hosts, since a cooling system does not stop at a process boundary. A node inherits both paths from its owner unless it overrides them, so commissioning sets one place per host rather than one per node — and the override case is real, a sensor owned by a machine's controller but mounted in the next room.

A folder on either axis is a path segment, not an entity — no lifecycle, nothing to go offline, no functionality to define — which dissolves most of the folders-above-hosts question: grouping buildings A and B while C stands alone is just path depth, `campus/ab/building-a` beside `campus/building-c`. A selector then names its axis: the fire-cell OR expands over a place prefix, "every pump in cooling line 2" over a system prefix, both filtered by capability. What does not dissolve is that declared membership can be wrong or missing, and on the place axis that is a safety fault — an alarm input with no declared cell is silently absent from the OR, the same commissioning hazard one layer down. The audit rule follows: every peer with a safety capability declares a place, every cell expected non-empty is checked non-empty, and supervision extends from "a member left the bus" to "a member was never declared". The deeper question shrinks to whether a third axis ever earns its way in — electrical feeders, maintenance regions — and the discipline is that the naming already accommodates one, so each is refused until an installation demands it.

**Observability is the point, not a bonus.** Every node of the tree has a current value, and a runner that publishes per-node evaluation state gives any viewer a live-highlighted diagram — ladder logic's lit rungs, which is much of why simple logic has survived in the PLC world. The console renders that with machinery it already has, and it reaches the model too: asked why the pump started, a model reads the recorded evaluation states and answers with an explanation trail rather than an inference.

**Assessability is what the ceiling buys.** A closed operator set makes flows decidable: whether a branch is reachable, whether a state space is covered, whether two flows command the same actuator. That is finding 8's audit product given a sound query language — so Turing-incompleteness stops being the declarative tier's limitation and becomes its feature, and the revision should claim it that way. Infix text is display only: a tree renders to `payload.temperature > 150 AND NOT manual_override` for a human, and an editor may compile typed text back into a tree, but the wire format is the tree.

### UI trust is granted, and the chrome stays native (resolves finding 3)

The finding's sandbox concern was the shallow half. The deeper attack is content: a typed layout executes nothing and can still lie — render "Pressure: NORMAL" against an over-pressure tank, or a perfectly valid form titled "Update your company payment method". That is deception, not execution, and no sandbox stops it.

The setting is what makes it serious. This UI renders in a trusted internal environment — the control room — where suspicion is lowest and everything else on screen is legitimate, so an injected panel inherits a credibility no phishing site ever gets. "It is internal" is the posture that usually excuses weak defenses in industrial networks; here it is exactly what raises the stakes, because server-driven UI imports remote content into the operator's trusted zone. Every peer whose panel is rendered joins the control room's trusted computing base, and membership in that base has to be a deliberate act. So the defenses are structural, not vigilance:

**Trust is granted, not discovered.** A console renders a peer's UI only under a grant — configuration or a signed grant, default none. Implementing `ActionProvider` is a claim, not a right; the `--scriptable-by` pattern generalises once more, with the grant made on the rendering side and the key travelling out of band. Compilers are pinned by configuration: discovery may propose one, never appoint one, because over a relay nothing can authenticate who answered.

**Discovered UI is a maintenance surface; the operator UX is authored.** A panel reached by browsing the network or the place tree is a debugging, diagnostics and commissioning surface — the technician chasing a failing sensor. An operator UX is largely unrelated to the physical structure of the control system: it follows the task and the process, and nobody responds to a fire alarm by browsing to building A, cell 3. So the operator screen is an authored composition document that names the dialogs it embeds, by peer and capability, at authoring time — and that is the strongest form of the grant rule, because the operator surface's grant list *is* the document: versioned, diffable and reviewed like a flow, so a rogue panel cannot reach the operator without first getting itself into a reviewed artifact. The same dialogs serve both surfaces — the node authors its setpoint dialog once, the browse view shows it in provenance chrome, the operator screen embeds it in a flow — and composition inherits the full defense stack below. The composition document joins the flow documents among finding 8's audit artifacts.

**The chrome stays native.** Every remote panel sits in console-drawn framing that names the serving peer and its authentication status, loudly when unauthenticated. The bridge cannot draw console chrome, which is what makes confirmations trustworthy: a non-query call from a remote panel triggers a native dialog naming peer, method and arguments — and the risk grading is already in the contract, since `query`, `idempotent-command` and `non-repeatable-command` ride in the schema today. An action's human label renders beside the method it actually calls, so "Acknowledge alarm" wired to `setValve` is visible as the lie it is.

**The widget vocabulary is the phishing defense.** A closed set with no credential or payment primitives: a convincing credit-card form cannot be composed from Gauge, Toggle, Setpoint and Chart. Free text exists only where a contract method takes a string, and renders with its destination method visible. The document's "no untrusted code to sandbox" was too broad; the true claim is that a closed vocabulary can exclude the primitives deception needs, which is a stronger property than any sandbox grants.

**Values bypass the compiler.** Displayed state flows through the console's own schema-checked subscription, wired from the layout's `bind` declarations; compiled output that requests a binding absent from the layout the node declared is rejected. A compromised compiler can then mislabel a value but not fabricate one. Reproducible compilation — same layout, same compiler version, same output hash, recompiled and compared — turns compilers into verifiable functions, which belongs to finding 8's audit tier as a product rather than a hope.

**The sandbox stays**, as defense in depth: `allow-scripts` without `allow-same-origin`, with the standing warning that adding `allow-same-origin` beside it voids the sandbox entirely.

The honest residue: a granted, authenticated peer lying in its own panel about its own state. No protocol fixes that. It is bounded by the grant being deliberate, the provenance being visible, and every action still traversing the target's `authorize` — the UI layer is never the security boundary for what a call may do.

### Rank and reveal, never block (resolves finding 4)

The finding's remedy was half wrong, and the correction comes from the tools that live with this daily. The field's principle: when a value is selected for wiring, show every attribute it has, order the candidates by likelihood — and never prevent a choice whose general type matches, numeric to numeric, boolean to boolean. OPC UA, with the richest information model in the industry, goes no further than displaying `EngineeringUnits` and `EURange` beside the candidate. The reason is deeper than tool efficiency: sources in the field are under-specified as the norm, and a hard gate on an under-specified point does not stop the integrator — it gets worked around, by relabelling the point until the gate passes, and now the metadata lies to everything downstream including the audit layer finding 8 wants to sell. Guidance keeps metadata honest; a veto teaches it to lie.

What actually prevents these mistakes at scale is documented in [the WebPort notes](WebPort%20SCADA%20comparisons/process-value-scoping.md): templates and naming standards. A tag like `AHU01_GT11` encodes device type, device number, value type and point number — and the designations are not folklore, they come from the sector's drawing and physical labelling standards. `GT11` is printed on the engineering drawing and on the label beside the sensor in the cabinet, so the drawing, the device and the tool all speak the same name, and a technician can walk from any one of them to the other two. [The symbol library](WebPort%20SCADA%20comparisons/symbol-library.md) is what makes the standard pluggable: suffixes like `_PV` and `_SP` are defined in the library's configuration, prefixes come from the project's naming standard, and a different sector's standard is a different library. Dropping an AHU template on a page auto-binds its points through that machinery, and register hell is resolved by a published standard plus pattern matching.

Every piece of it is a stringly-typed edition of something this design already has, typed: the AHU template is a capability contract, `GT11` is a role name declared as a property on it (`AirHandlingUnit.inletTemperature`), the symbol library is a contract package, and [the per-tag sheet of unit, range and description](WebPort%20SCADA%20comparisons/process-value-attributes.md) that WebPort has entered and maintained by hand on every tag is `@rpcProperty` metadata declared once per class. What graduates is the encoding — from regex-matched strings into a schema the extractor checks. Two consequences the revision should carry. A capability package should encode a published sector standard and name which one, keeping the standard's designation on each role — `inletTemperature` carrying `designation: 'GT11'` — so the schema agrees with the drawing and the label in the cabinet, and the console shows a technician the name physically in front of them. And the governance burden from [where things belong](#where-things-belong) shrinks accordingly: role naming inside a sector package defers to that sector's standards body rather than being invented, and what remains to govern centrally is only which packages exist.

Not every industry is that far standardised — building automation has big players and published designations, a one-off factory has neither. The rule degrades by narrowing scope rather than failing: where no sector standard exists, a project-local contract package plays the symbol library's role for that plant alone. WebPort already embodies exactly this split, suffixes from the published library and prefixes from the project's own convention.

So the picker: the hard gate stays at general type only, which is the existing signature filter demoted from ceiling to floor. Everything else ranks and reveals — role-name match against the target capability's declared properties, unit match, place proximity from the structure tree, so the sensor in the same cabinet outranks the one across campus — with unit, range, description, semantics and place shown on every candidate. Never a veto. A ranked list with honest attributes serves a model exactly as it serves a human, and the choice made is recorded either way.

The hard stop the industry does accept already exists, and it sits at the right boundary: the target's own declared range. `min` and `max` ride on numbers in the schema today and are validated at the call boundary — WebPort's `Eng-min`/`Eng-max` limiting operator input, generalised to every caller including a model. An RPM reading at 2800 wired into a 0–120 setpoint is `InvalidParams` before the device sees it. The gate lives on the device, not in the picker, which is resolution 3's rule again: the UI layer is never the security boundary. The consequential-command case is likewise already covered there, by native-chrome confirmation graded on the contract's semantics.

What survives of the finding's original remedy: units belong in the contract — as ranked, displayed, model-readable attributes on `@rpcProperty` and method parameters, never as a type-level veto.

### An investigation, not yet a resolution: process values as objects (finding 5)

Finding 5 stays open, but its direction changed. The constructor trap — a timer started in the constructor writing to a `this` the proxy never wrapped — is real and has bitten before, and it is an artifact of the design choice rather than of the problem: intercepting writes to a primitive field requires wrapping the host object, and a wrapper can always be outrun by code that captured `this` first. Two ways to make the trap structurally impossible are on the table.

**Sampling instead of interception.** The decorator's throttle interval already defines how often the network may hear a change, so sampling decorated fields at that interval and diffing removes the proxy entirely. Trailing-edge behaviour comes free — a sample reads current state — and hysteresis becomes a diff filter. The cost is a change heard up to one sample late, which at plant-telemetry intervals is what every polling SCADA has always accepted.

**Process values as class instances.** `temperature = new ProcessValue(…)`, or a subclass, makes the value itself the interception point: server code writes through the object, and no wrapper around the host exists to be outrun. This is the tempting one, and not only for the trap. The industry has never modelled a process value as a bare number — OPC's value–quality–timestamp triple, BACnet's analog objects with present-value, status-flags and units, WebPort's per-tag sheet; the tag is an object in every system that has lived long in this domain. An object gives quality somewhere to live, which answers this finding's staleness gap structurally: a shadow whose resubscription failed marks `quality: 'stale'` on exactly the affected values, and a read is never silently wrong because the read carries its own verdict. It gives forcing and simulation a home — the maintenance surface wants `forced: true` visible — and it attaches the write path's discipline to the value itself: a `Setpoint`'s `set` is an idempotent command, async and fallible on the client shadow, which is what the shadow-copy design legislated from outside.

The objection is the library's own doctrine — the dropped-ideas section rejects observable-typed properties because the class is ordinary. The distinction that may survive that test: an `Observable` is reactivity plumbing, written for the network, while a process value object is domain vocabulary — the thing a standalone control program with no network attached would still contain, alarm limits and all. Ordinary industrial code has had tag objects for fifty years. And the typing cost that historically favoured primitives — `oven.temperature` against `oven.temperature.value` — weighs less when models write much of the code, while the explicit object gives a model more to read: completing `temperature.` reveals value, quality, unit and forced, and teaches the domain in a way a bare float never did.

To settle before this resolves: one wire model regardless of source spelling, so a decorated primitive — if it survives as sugar — extracts and travels as a degenerate process value; extraction of the generic and its subclasses, with designation, unit and range riding as schema; the write path — which values are writable, how command semantics attach, what the target's `authorize` sees; quality propagation with transport loss, resubscription failure and forcing each visibly distinct; and what the console renders, the properties panel growing quality badges being the visible payoff.

**The extractor experiment, run against 3.4.3.** Two of those questions are now facts rather than unknowns. The data shape extracts today, cleanly: `ProcessValue<number>` and `ProcessValue<string>` come out distinct and correct — the quality union as literals, `at` as a date, `unit` optional — and `Temperature extends ProcessValue<number>` with a designation field flattens its inheritance into a named type. Zero diagnostics.

Two edges mark where the work is. Instantiated generics inline anonymously, by deliberate design — `nameOf` refuses them because `Record<string, number>` and `Record<string, string>` share one symbol, and keying both under it would silently alias the second to the first (`extract.ts:51`) — so nominal recognition today means a named subclass per role, which happens to align with resolution 4's sector designations: `Temperature` is a class the way `GT` is a designation. Naming instantiations together with their arguments is the alternative, and a contained change. And behaviour refuses loudly: give the class `set` or `onChange` and extraction fails with *is a function, which cannot be checked on the wire* (`extract.ts:69`), writing nothing. So the tooling itself settles the wire model: what crosses is the data projection, and the one piece of new extractor work the object model needs is the projection rule — a recognized process value strips its behaviour and keeps its data — or a source spelling that keeps the two apart.

### The version constant is accepted work (resolves finding 6)

Nothing to design. One exported constant replacing the five literals, a schema version independent of the package version, and a written compatibility policy — what is additive, what forces a bump, what a consumer may assume. It sits third in the build order below because it has to exist before the first external package reads the format, and it is the cheapest item on the list.

### Authorization goes from absent to rigid (resolves finding 7)

The resolutions above have been building this model piecewise — grants on scripting, grants on rendering, discovery that proposes but cannot appoint — and the resolution is to state it once, rigidly, and hold every feature to it. None of the rules is new; each has already shipped in some form, which is the evidence the model is livable:

1. **The grant lives on the side that bears the consequence.** The scripted node names `--scriptable-by`; the rendering console names whose panels it shows; the target of a wired event authorizes its callers. The requester never grants itself anything.
2. **Default is none, and absence is invisible.** No grant, no namespace published, no tool advertised — a peer that may not do a thing does not learn the thing exists.
3. **Keys travel out of band.** A bus able to hand over the key that unlocks the bus is a bus able to unlock itself; remote desktop, a phone call, paper.
4. **Across a relay, only signed frames carry identity.** Per-connection identity does not survive a relay and no flag changes that — the information is not there to have.
5. **The UI layer is never the security boundary.** Enforcement is the target's `authorize` plus schema validation at the call boundary; chrome and confirmations shape behaviour, they do not gate it.
6. **Capability is a claim, never a right.** Implementing an interface advertises what a peer can do; whether anyone may ask it to is a separate, granted question.
7. **Per-artifact identity.** A deployed flow, worker or script is a peer with its own name and key, never borrowing its deployer's — scripts already work this way, and it is what lets grants stay narrow and audit attribute an action to the artifact that took it.

And the rigidity clause that makes it stick: **a feature specification without its authorization paragraph is incomplete.** Who grants, where the grant lives, what the target checks — written before the feature is designed further, not retrofitted after the wiring ships, because retrofitting grants onto shipped wiring is how permissive defaults calcify.

### Assessment first, audit later (resolves finding 8)

The critique stands — the audit-first business had a dependency it never acknowledged: a platform that ingests `describe()` schemas has nothing to read until the mesh is adopted, and the open schemas it reads are readable by any competitor. The resolution is a reframing from the actual business: **assessment of existing control systems**, which has no such dependency, because it reads the brown field as it is — Modbus registers, BACnet objects, OPC UA models, tag lists, PLC programs nobody has documentation for. The method is AI plus industrial knowledge plus actively trying to get information out of the system in as many ways as possible — and that instrument set already exists, because it is the CLI: `describe`, `check` and `diff` for what serves what, `record` and `replay` for behaviour, `tap` for who actually talks to whom, `bench`, `conform`, fakes for probing a hypothesis against a device that does not exist yet, and the MCP server so the model does the digging.

The shape of the business then: the open mesh and CLI are both the probe kit and the destination. Assessment finds what a customer has; the mesh is the modern path offered for upgrades and new systems; and the tool is valuable continuously rather than report-shaped, because drift — what changed since last month — is a question a plant keeps having. Audit is a possible later layer on that foundation, not the lead product, and the defensible artifact remains what finding 8 said it was: the signed assessment, the safety case, the history an auditor accepts — not the ingestion. Naming is a business detail in motion — the company likely Daritas, the SaaS named separately — and the revision should keep it out of the technical document entirely.

## Where things belong

The document frames this as core versus ecosystem. The repo already has a sharper axis, from the versioning rule in `CLAUDE.md`: rpc and rpc-cli version together because the CLI depends on the library's exact shape. So: **what changes the schema versions together; what only reads the schema is a package.**

| where | what |
| --- | --- |
| `@source-repo/rpc` | `@rpcProperty` and the shadow-copy runtime; capability capture's runtime half; owner and the place/system paths as peer identity, carried in presence and `describe()`; `resubscribeFailed` naming what failed; the schema version as an exported constant with a compatibility policy |
| `@source-repo/rpc-cli` | `extract` reading `PropertyDeclaration` nodes and heritage clauses; the discovery cache; console UI for discovery, actions and wiring; the MCP surface for the same. No widgets — the document is right that a widget library is where a diagnostic tool becomes a dashboard monolith |
| separate packages | the contract-only capability packages; `ui_compiler`; the operator-screen composer and its document format; `FlowRunner` and `TsFlowRunner`; everything WebAssembly and embedded |

Two placement notes the document misses:

**Properties span both packages.** The decorator and runtime live in `rpc`, the extraction in `rpc-cli` — so the feature is a coupled release across both, not a core-only change. The both-packages-version-together rule absorbs this, but the revision should say it.

**The contract-only packages need central governance.** They can live in separate repositories, but the naming and versioning policy must be owned in one place, or three incompatible `ActionProvider`s appear and discovery becomes a coin flip. Package-qualified capability names (resolution above) make the package name part of the capability's identity, which is exactly why its ownership matters.

## What to build first

Not the exciting parts. Two features change the schema, and everything else in the document is downstream of them:

1. **`@rpcProperty` and the shadow copy** — server-driven UI's `bind: { state: 'rpm' }` is unimplementable without it, and so is the `state.*` half of expression-tree references.
2. **Capability capture** — every discovery story is unimplementable without it, and so is everything built as a named interface: `UiCompiler`, `ActionProvider`, `EventProvider`, the flow runners. This is the widest dependency in the document.
3. **The schema version constant and policy** — before any external package consumes the format, not after.
4. **The authorization story** — routed through `authorize` and signed frames while the features are on paper, because retrofitting grants onto shipped wiring is how permissive defaults calcify.

Then the ecosystem packages — compilers, flow runners, capability contracts — can be built by anyone, including someone who is not the library's author. That is the actual test of whether this is an ecosystem rather than a feature list.
