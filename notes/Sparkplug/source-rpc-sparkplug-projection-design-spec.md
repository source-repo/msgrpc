# Source RPC Sparkplug B Projection, Environments, and the Plant Boundary

**Status:** Proposed design specification
**Target:** Source RPC after 4.5.0, as a new ecosystem package
**Primary reference:** Sparkplug B 3.0.0 (Eclipse), MQTT 5, and the Source RPC 4.5 component/topology/context architecture
**Audience:** Source RPC maintainers, reviewers, integrators pointing SCADA/MES/historians at a Source RPC network, and whoever builds the first deployment

## 1. Executive decision

Source RPC gains a Sparkplug B **projection**: selected components appear to standard plant systems as Sparkplug Edge Nodes and Devices, with their state as metrics, their lifecycle as BIRTH/DEATH, and a deliberately small allowlist of idempotent commands as writable metrics. Source RPC itself remains the internal fabric — typed calls, events, components, topology, context, queues — and is never reduced to what Sparkplug can carry.

- **Projection over tunnelling.** Sparkplug outside, Source RPC inside. An opaque byte tunnel through Sparkplug is not part of this design and is deliberately not promised (§10).
- **Open source.** The projection ships as a public ecosystem package, `@source-repo/sparkplug`, versioning independently like `@source-repo/queue` — the second external consumer of the schema compatibility policy, and the proof that the extension architecture reaches the industry's own standard. Commercial products build policy, integration and certification on top; none of that lives here.
- **Per-node AI capability grants are the security model.** Four grants — AI-at-a-tool writing, AI-at-a-tool programming, AI-authored-program writing, AI-authored-program programming — closed by default on every node and opened explicitly, lease-shaped, on the node that bears the consequence, with the posture rendered and operated hierarchically in the console. Framed as enablement: the point is to allow AI exactly where it is useful, bounded in scope and time. Staged environments (dev/test/verify/prod) are recommended practice, not mechanism — ambient claims about places rot, grants travel with the machine (§8).
- **Security, never safety.** Nothing in this design — the projection, the environment line, authorization, signing — is a functional safety mechanism, and no document may imply otherwise. Human safety belongs to the functional-safety tier: FSoE/TwinSAFE-class hardware with its own CPU, its own credentials and SIL-rated logic. The stance in one sentence: **no AI modelling with dangerous machines — and even that line is not what safety relies on** (§8.4).

The central rule is:

> **Project semantics, never frames. The plant sees an intentionally limited, inspectable, standards-based surface; the rich fabric stays behind a policy boundary that refuses by default.**

## 2. Source basis and disposition of the Sparkplug discussion

This specification incorporates the exploration recorded in `OpenAI chat about MQTT Sparkplug B.md` (in this directory) and states what it adopts, what it amends, and what it rejects. The chat predates Source RPC 4.4.0/4.5.0, which matters: several mechanisms it proposes to invent were built in those releases and are reused rather than duplicated.

### 2.1 Adopted

1. **Projection as the primary product; tunnelling at most a private extension.** The native projection is what ordinary Sparkplug hosts can actually use.
2. **Read-only first.** The first shippable milestone publishes state and lifecycle and accepts no commands at all.
3. **The core mapping table** (§4): runtime → Edge Node, selected component → Device, props/state → metrics, lifecycle → BIRTH/DEATH, component classes → Templates where useful.
4. **Not every component is projected.** Selection is explicit; internal helpers, queue workers and MCP services never become visible to SCADA by default.
5. **Two MQTT sessions.** One connection carries one Will; Sparkplug demands NDEATH as the Will while Source RPC presence uses a retained offline message. Two logical clients on the same broker, cleanly, rather than one compromised session.
6. **A frozen per-session projection schema with controlled rebirth** when the exported surface changes.
7. **Commands are an explicit allowlist of idempotent, bounded, state-confirmed methods** — never generated from every public method.
8. **The relay for Sparkplug-only sites** (§9) keeps the caller owning the request: stable request id, retransmit until result or deadline, the relay itself a plain relay-only `RpcServer` with virtual per-peer transports over one MQTT client. Deferred until a paying deployment needs it.
9. **No silent route fallback.** Whether a call may go local, direct or relayed is deployment policy, validated at deployment time; a motion command is never quietly rerouted through a slower relay.
10. **QoS 0 honesty.** Sparkplug data and command traffic is at-most-once; the projection and any relay must say `UnknownOutcome` where the outcome is genuinely unknown, and must never let a retry restart a deadline.

### 2.2 Amended by this specification

1. **Rebirth rides the description hash.** The chat proposes freezing a projection schema per session and re-birthing on change; 4.4.0's shape hash in presence (`TransportEvent.peerShape`) is exactly that signal, already deduplicated and already carried on both transports. The gateway subscribes; a reshaped peer triggers a controlled rebirth of its Devices. Nothing new is invented.
2. **Ordering vocabulary is the event cursors'.** The chat invents `linkEpoch`/`streamSequence` for its inner frame. 4.4.0's event cursor discipline — an epoch per incarnation, a sequence that only orders within it, "cannot know" across a restart — is the same vocabulary, already server-side. The Sparkplug transport reuses it rather than shipping a third ordering language.
3. **The inner frame is assembled, not invented.** The chat correctly notes the MQTT 5 wire format keeps routing in packet properties, so its payload cannot be tunnelled as-is — but Source RPC transports own their wire format, and the socket.io transport already frames complete self-contained messages through its codec. A Sparkplug-carried frame is that framing plus the cursor fields, not a new protocol.
4. **Snapshot atomicity is a stated rule.** Sparkplug is metric-granular; the component channel is snapshot-atomic. The projection publishes **one DDATA per snapshot commit**, carrying every changed metric of that commit, so a consumer can never observe a torn snapshot. Report-by-exception happens by diffing snapshots inside the gateway, never by racing per-metric publishes.
5. **Staleness has a native expression.** A component channel that goes `stale` does not go silent and does not lie: the projection marks the Device's metrics with the standard Sparkplug Quality property (uncertain), and `closed` becomes DDEATH. The age of a stale picture is already on the snapshot; the projection carries it as a property rather than dropping it.
6. **Identity flattening is stated, loudly.** A DCMD carries no authenticated caller. Plant-side identity granularity ends at the broker ACL plus the gateway's own peer identity; on the Source RPC side, the invocation handle will truthfully report every projected command as the gateway calling. The gateway records the Sparkplug-side origin it can see (client id, topic) in its own audit log, and no design may pretend that is authentication.
7. **Relay ordering starts with a window of one.** The chat designs bounded out-of-order receive windows. The first relay implementation serializes commands per target — one in flight, the next leaves when the first resolves — which makes the `setMode`-then-`start` reordering hazard structurally impossible at a latency cost industrial command streams mostly cannot notice. Windows are an optimization with evidence, later.

### 2.3 Rejected

1. **The opaque byte tunnel, harder than the chat rejects it.** The chat keeps it as an on-demand option; this specification does not promise it at all. A Sparkplug-only site chose that constraint because it wants inspectable traffic at the boundary; opaque Source RPC bytes through the DMZ honor the letter of the policy while violating its spirit, and the projection's whole security story is that the boundary can read what crosses it. If a real deployment ever demands it, it is a new decision against this paragraph, not an activation of a dormant feature.
2. **Dual-role Edge/Host peers.** Every peer holding Host command permissions recreates Source RPC badly inside Sparkplug and dissolves the ACL story. The chat reaches the same conclusion; recorded here as settled.
3. **Command result metrics (`Command/Last/*`) in v1.** State confirmation is the Sparkplug-native answer; a private result-metric profile is vocabulary nobody standard can read. Revisit only with a concrete consumer.

## 3. Goals and non-goals

**Goals.** A read-only projection a SCADA/historian can consume with zero knowledge of Source RPC; explicit, auditable command exposure; lifecycle fidelity (BIRTH/DEATH, rebirth, staleness) that never claims more than the fabric knows; an environment model that keeps AI tooling structurally out of production; a package boundary that proves the public extension architecture again.

**Non-goals.** Functional safety, or any wording that drifts toward it. General RPC over Sparkplug as a default path. TCK certification in the first milestones — the safe wording until the TCK has been run is "Sparkplug B integration", never "Sparkplug Compatible". Projecting the full topology graph: Sparkplug's Group/Edge/Device tree is shallower than Source RPC's parent/owner graphs, and flattening everything into it would lose information and churn BIRTHs; the full graph stays inside, with parent, owner and epochs exposed as metadata metrics where useful.

## 4. The projection model

| Source RPC | Sparkplug B |
| --- | --- |
| One runtime or gateway process | Edge Node |
| Selected component (explicitly listed) | Device, with a stable Device ID |
| Component class / profile | Template (later milestone) |
| `props` | DBIRTH metadata / read-only metrics |
| `state` snapshot | DBIRTH values, then DDATA on commit |
| Snapshot commit | Exactly one DDATA (all changed metrics) |
| Channel `stale` (with age) | Quality property: uncertain |
| Channel `closed` / peer gone | DDEATH |
| Shape hash change (peerShape) | Controlled rebirth |
| Allowlisted idempotent method | Writable metric via DCMD |
| Parent / owner / epochs | Read-only metadata metrics |
| Low-rate transient event | Transient DDATA metric |

**Selection is a committed contract.** A projection is declared in a file — working name `sparkplug.projection.json` — naming the components, their Device IDs, the metric map (metric name → props/state path), units and bounds, and the writable allowlist. It is committed and checked like `*.types.json`, because the projection is a contract with the plant: reviewable in a diff, not assembled in someone's head. The CLI can scaffold it from an extracted contract — `extract` already knows every component's props and state shapes — but a human commits it, and nothing is projected that the file does not name.

**Device IDs are stable.** An owner reassignment is a logical remount inside Source RPC and must never change a Device ID or cause a DEATH/BIRTH cycle; the owner metadata metric changes, the Device stays. BIRTH churn is the Sparkplug equivalent of the reconnect storms this library spends so much machinery avoiding.

**The gateway is a component host like any other.** It subscribes to projected components through the ordinary component channel (`client.component()`), so it inherits epoch/revision ordering, targeted snapshots on subscribe, and staleness — the projection's fidelity is the channel's fidelity, not a parallel implementation.

## 5. Commands across the boundary

A writable metric maps to exactly one method, declared `idempotent-command`, with bounds and units validated by the gateway before the call is made — a DCMD with an out-of-range value is refused at the boundary and never travels. Completion is confirmed by the resulting state update, which is the Sparkplug-native pattern; callers that need RPC result semantics are Source RPC callers and should be inside.

Non-repeatable commands, parameterized queries, long-running workflows, typed errors, deadlines-and-cancellation: all stay Source RPC. The boundary's poverty is a feature — what crosses it is exactly what a metric write can honestly express.

**Read-only mode is a first-class deployment option**, not an afterthought: a projection with an empty allowlist is the recommended starting posture for every new site.

**Open question, recorded:** whether a DCMD-mediated command should be able to ride command authority (EME-348) — the gateway holding `$acquire` on behalf of the SCADA that is, in plant terms, the operator in control. Deferred; the answer shapes nothing in M1–M2.

## 6. Protocol substrate

**Protobuf, static, vendored.** Sparkplug B payloads are protobuf. The official `sparkplug_b.proto` is vendored at a pinned spec version, code is generated once and committed (the same discipline as the extracted contracts: generated artifacts are reviewed files, not build-time surprises), and regeneration is a scripted step with a check. No runtime reflection.

**The session state machine is the actual work.** `bdSeq` pairing between NBIRTH and the NDEATH Will; the 0–255 `seq` wrap on data; `Node Control/Rebirth` handling; primary-host STATE observation; data and commands at QoS 0, non-retained, on clean sessions. This is fiddly, TCK-tested territory and the honest cost center of the whole project — the mapping is a week, the state machine is the month. It lives in `@source-repo/sparkplug` as its own tested module, independent of the projection logic above it.

**Two clients, one broker.** The Sparkplug session (NDEATH Will, clean start) and the Source RPC MQTT transport (retained presence Will, persistent session) are separate MQTT clients even when they share a broker and a process. A future `SparkplugTransport` that replaces presence with Sparkplug lifecycle is explicitly out of scope until the projection has earned its keep.

## 7. What already exists and is reused

Recorded so the implementation does not rebuild it: the component channel (snapshots, epoch/revision, status with age) is the projection's entire data source; the shape hash (4.4.0) is the rebirth trigger; the event cursors (4.4.0) are the ordering vocabulary for anything Sparkplug-carried; `peersSettled` is the gateway's startup discipline; the idempotency store and `UnknownOutcome` carry the QoS 0 story end to end; fakes, `serve --contract`, `record`/`replay` are the machine-free dev stage's machine park (§8.5); declared method semantics are the mechanical write boundary and command authority's lease pattern is the shape of a time-bounded grant (§8); and the schema compatibility policy governs the projection contract file the way it governs `*.types.json`.

## 8. The AI boundary: per-node capability grants

The purpose of this section is enablement, and that is not a softening — it is the design driver. The point is not to keep AI out of plant networks; it is to make AI **useful and safe at the same time**: to allow it exactly where it earns its keep, bounded in scope and in time, with the bounds visible at a glance. A boundary nobody can afford to open is a boundary people route around; a boundary that opens precisely is one people actually use.

### 8.1 The four grants

AI capability is gated per node — on each `RpcServer`, independent of everything else — along two axes: **who originates** (AI at a tool, or an AI-authored program) times **what power** (writing to the plant, or programming the network).

| grant | what it permits |
| --- | --- |
| `ai.tool.write` | AI at a tool (MCP) calling state-changing methods on this node |
| `ai.tool.program` | AI at a tool creating, changing, starting or removing programs on this node |
| `ai.program.write` | An AI-authored program calling state-changing methods on this node |
| `ai.program.program` | An AI-authored program managing programs on this node |

All four are **closed by default on every node, everywhere** — not denied by a zone, not implied by an environment, simply absent until a person opens them on the node that bears the consequence. Observation is the deliberate exception: provenance-marked AI may make `query`-semantics calls wherever ordinary authorization allows, because diagnosis and understanding are where AI earns its place, and a bounded intelligence that can see everything and touch nothing is immediately useful and immediately safe.

The write boundary is mechanical, not curated: a method's declared semantics already split `query` from the two command kinds, so "AI may observe but not write" is enforced by the dispatch layer reading a declaration that exists today.

`ai.program.program` is named now precisely because it is speculative. Unnamed powers get bundled into broader grants; naming this one lets it stay closed while `ai.program.write` opens. It is also where the future arrives — a node with resident AI maintaining its own toolkit is a plausible endpoint of the technology — and it is the replication link: a program that programs programs is a chain, which is why provenance carries generation (§8.2) and grants can bound the depth they permit.

### 8.2 Provenance

A node can only enforce these grants if it can tell AI from everything else, and the claim must be vouched, never self-declared. Provenance therefore rides the existing rail: the identity's `roles`, issued with the credential by whoever operates the bus — `ai-tool` on the MCP server's token, `ai-program` on a script's, with a generation count distinguishing a program written at the tool from a program written by a program. `authorize` and the invocation handle already carry identity to every dispatch, so every target sees honest provenance with no new plumbing.

One prerequisite is a real gap today, filed as **DEV-361**: scripts are handed the node's own `SOURCE_RPC_TOKEN`, so on an authenticating bus an AI-authored program either cannot connect under its own name or dissolves into the node's identity. Derived per-script credentials — the script's own peer name, `ai-program` in its roles, revoked with the parent — are what make the `ai.program.*` grants enforceable at all.

### 8.3 Enforcement and the shape of a grant

Grants are **declarative data, not authorizer code**. A small per-node document states which of the four capabilities is open and to whom; the library enforces it before `authorize` ever runs, so the default is refusal even on a node whose author wrote no authorizer at all, and `authorize` remains the fine-grained veto on top. Declarative matters twice: it is what the console can render (§8.4), and it is what a reviewer can diff — the same argument as the committed projection contract.

Write-class grants should default to being **lease-shaped**. "Bounded" means bounded in time as well as scope, and the machinery exists: command authority's acquire/TTL/renewal pattern, applied to permission. The ergonomic default for `ai.tool.write` on a commissioning afternoon is a lease somebody renews on purpose and everybody watches expire; standing grants remain possible and visible for the installations that want them. Grants that linger as configuration archaeology are the failure mode this prevents.

### 8.4 The console is the switch

The console gains a security panel under the existing peer tree: per node — authenticated, signing, authority, `--scriptable-by`, and the four AI grants with their scopes, grantees and remaining lease time. Its verb is not only *audit* but *open*: "open this, here, until then", with what is currently open always one glance away. That panel is simultaneously the auditor's screen and the reason default-closed never pressures anyone into blanket-opening — granting precisely must be cheaper than granting broadly.

### 8.5 Environments as recommended practice

An earlier draft of this specification made staged environments — dev, test, verify, prod — an enforced mechanism, with tools refusing buses declared as higher zones. That is demoted, deliberately, to **recommended practice**, and the reason deserves recording: a zone is an ambient claim about a *place*, and ambient claims about places rot. Floor space runs out, a prototype of something genuinely dangerous gets parked in the corner that has always been "just developers", and the declaration nobody re-reads now radiates confidence the reality no longer deserves. An enforced-but-wrong zone is negative security. Per-node grants do not have that failure mode: **the grant travels with the machine; the zone stays behind when the machine moves.** The dangerous newcomer arrives with its writes closed no matter whose corner it is parked in.

What survives as guidance, because it is still good practice: stage deployments dev → test → verify → prod; keep the dev stage machine-free, its machine park built from fakes, committed contracts and replayed recordings; promote artifacts between stages — contracts upward with code, recordings downward as replay material, CI as the vehicle — and never span stages with a live connection. The documentation should present this as the recommended deployment shape, in the zones-and-conduits vocabulary plant security auditors already recognize, and the console may display an informational environment label where a deployment declares one. Nothing refuses on it.

For a dev setup at a site whose policy allows only the Sparkplug namespace: a dev stage is not on the production broker, so granting a private topic on the dev broker is almost always available and always preferable. The tunnel stays rejected (§2.3).

### 8.6 Security, never safety

Everything in this document is security and operational integrity. None of it is functional safety, and no product wording may drift there. Human safety belongs to the functional-safety tier — FSoE/TwinSAFE-class yellow hardware with its own CPU, its own program-change credentials, black-channel communication and SIL-rated logic — a tier this stack neither implements nor touches. The grants keep AI bounded as a matter of *operational policy*; they are explicitly not the mechanism a person's safety depends on, and the documentation says so wherever the boundary is described.

One architectural note for the reader who knows both worlds: the black channel treats the entire fieldbus as untrusted transport and puts all responsibility at certified endpoints — the same shape as this design's caller-owned retries over QoS 0. The industry's safety tier concluded long ago that you do not trust the middle. This design applies that shape one tier up, and never claims to be the tier below.

## 9. The Sparkplug-only relay profile (deferred)

For sites where only `spBv1.0/...` may cross a boundary and components on both sides must still call each other: the profile is designed, recorded here, and not built until a paying deployment states the need.

Shape: a Host-side relay that is a plain relay-only `RpcServer`; one MQTT client multiplexed into one virtual transport per Edge Node (per Device only where a Device independently hosts a peer); two transient Bytes metrics per endpoint carrying complete self-contained frames (§2.2.3) stamped with the cursor vocabulary; **`retry-until-deadline` semantics** — the caller retains the request and retransmits the same request id until a result, an error, or the original deadline, so the relay holds no custody and recovers from its own restart by doing nothing; duplicate suppression and durable idempotency at the target decide what a retry may do, exactly as they do today; commands serialized per target (§2.2.7). A `durable-relay` profile (journal before custody-transfer acknowledgement) is a later, stronger option that must never quietly become an offline work queue — the queue package exists for intended queueing.

Per interaction: state converges by snapshot, queries and idempotent commands retry freely, non-repeatable commands retry only against a durable idempotency store and otherwise end in `UnknownOutcome` stated plainly, ordinary events stay best-effort, audit-grade facts belong to the queue.

## 10. Package and product boundary

`@source-repo/sparkplug` is public and versions independently, depending only on the library's public API — the second package (after the queue) whose existence proves the compatibility policy. It contains the vendored proto and generated code, the session state machine, the projection engine, the projection-contract format, and its tests. The CLI may grow a verb to scaffold and validate projection contracts.

Commercial products — policy gateways, assessment integration, certified deployment profiles, support — consume this package; nothing in this repository references them beyond this sentence.

## 11. Milestones

- **M1 — substrate.** Vendored proto, committed codegen, the Edge Node session machine (bdSeq, seq wrap, rebirth requests, STATE observation) tested against a real broker with an in-repo host-side validator. No projection yet: an Edge Node that is born, publishes one metric honestly, and dies correctly is the milestone.
- **M2 — read-only projection.** The projection contract file; component channel → snapshot-atomic DDATA; Quality on stale; DDEATH on closed; shape-hash rebirth; stable Device IDs under owner churn. This is the first customer-visible artifact.
- **M3 — the AI boundary** (parallel track, core library + CLI + console, independent of Sparkplug): provenance roles on issued credentials, derived per-script credentials (DEV-361), the per-node grants document with library-side default-refusal enforcement, lease-shaped write grants, the console security panel, and the environments-as-recommended-practice chapter in the docs.
- **M4 — allowlisted commands.** Writable metrics, idempotent-only, gateway-side bounds validation, confirmation-by-state, the full command-and-confirm flow tested rather than merely the DCMD arriving.
- **M5 — Templates** from component profiles, for repeated units.
- **M6 — relay profile**, only against a named paying need (§9).
- **TCK and certification** when the wording needs to change from "integration" to "compatible"; until then the safe words are the safe words.

## 12. Open questions

Recorded, deliberately unresolved: command authority across the boundary (§5); whether Sparkplug Group IDs should mirror any level of the internal topology or stay a flat deployment label; historian expectations for transient event metrics; the grants document's exact format and where it lives (per-node file, bus-provisioned, or both — settled in M3's design review), and whether grantees are named peers, roles, or either; the right generation-depth default for `ai.program.program` beyond zero; and whether a dev-stage Sparkplug crossing ever becomes a real request rather than a theoretical one.
