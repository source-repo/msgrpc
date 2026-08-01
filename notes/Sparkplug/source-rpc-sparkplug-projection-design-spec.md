# Source RPC Sparkplug B Projection and the Plant Boundary

**Status:** Proposed design specification
**Companion:** `notes/ai-boundary/source-rpc-ai-boundary-design-spec.md` — the transport-independent AI boundary and security administration model, split out of this document because it governs Source RPC as such; this projection is its first large consumer
**Target:** Source RPC after 4.5.0, as a new ecosystem package
**Primary reference:** Sparkplug B 3.0.0 (Eclipse), MQTT 5, and the Source RPC 4.5 component/topology/context architecture
**Audience:** Source RPC maintainers, reviewers, integrators pointing SCADA/MES/historians at a Source RPC network, and whoever builds the first deployment

## 1. Executive decision

Source RPC gains a Sparkplug B **projection**: selected components appear to standard plant systems as Sparkplug Edge Nodes and Devices, with their state as metrics, their lifecycle as BIRTH/DEATH, and a deliberately small allowlist of idempotent commands as writable metrics. Source RPC itself remains the internal fabric — typed calls, events, components, topology, context, queues — and is never reduced to what Sparkplug can carry.

- **Projection over tunnelling.** Sparkplug outside, Source RPC inside. An opaque byte tunnel through Sparkplug is not part of this design and is deliberately not promised (§2.3).
- **Open source.** The projection ships as a public ecosystem package, `@source-repo/sparkplug`, versioning independently like `@source-repo/queue` — the second external consumer of the schema compatibility policy, and the proof that the extension architecture reaches the industry's own standard. Commercial products build policy, integration and certification on top; none of that lives here.
- **The security model lives in the companion document.** AI as a principal, the four per-node capability grants, sponsorship, the badge desk, environments as recommended practice, and the commercial knife (security is never a paid feature; managing it across a fleet is) are specified transport-independently in `notes/ai-boundary/source-rpc-ai-boundary-design-spec.md`. This projection consumes that model; it does not define it.
- **Security, never safety.** Nothing here is a functional safety mechanism — human safety belongs to the FSoE/TwinSAFE-class tier this stack neither implements nor touches. The full statement, binding on this document too, is the companion's §10 — and the companion's §9 is the duty-to-inform chapter that must accompany any marketing of AI into these environments, this projection included.

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
8. **The relay for Sparkplug-only sites** (§8) keeps the caller owning the request: stable request id, retransmit until result or deadline, the relay itself a plain relay-only `RpcServer` with virtual per-peer transports over one MQTT client. Deferred until a paying deployment needs it.
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

**Open question, recorded:** whether a DCMD-mediated command should be able to ride command authority (DEV-348) — the gateway holding `$acquire` on behalf of the SCADA that is, in plant terms, the operator in control. Deferred; the answer shapes nothing in M1–M2.

## 6. Protocol substrate

**Protobuf, static, vendored.** Sparkplug B payloads are protobuf. The official `sparkplug_b.proto` is vendored at a pinned spec version, code is generated once and committed (the same discipline as the extracted contracts: generated artifacts are reviewed files, not build-time surprises), and regeneration is a scripted step with a check. No runtime reflection.

**The session state machine is the actual work.** `bdSeq` pairing between NBIRTH and the NDEATH Will; the 0–255 `seq` wrap on data; `Node Control/Rebirth` handling; primary-host STATE observation; data and commands at QoS 0, non-retained, on clean sessions. This is fiddly, TCK-tested territory and the honest cost center of the whole project — the mapping is a week, the state machine is the month. It lives in `@source-repo/sparkplug` as its own tested module, independent of the projection logic above it.

**Two clients, one broker.** The Sparkplug session (NDEATH Will, clean start) and the Source RPC MQTT transport (retained presence Will, persistent session) are separate MQTT clients even when they share a broker and a process. A future `SparkplugTransport` that replaces presence with Sparkplug lifecycle is explicitly out of scope until the projection has earned its keep.

## 7. What already exists and is reused

Recorded so the implementation does not rebuild it: the component channel (snapshots, epoch/revision, status with age) is the projection's entire data source; the shape hash (4.4.0) is the rebirth trigger; the event cursors (4.4.0) are the ordering vocabulary for anything Sparkplug-carried; `peersSettled` is the gateway's startup discipline; the idempotency store and `UnknownOutcome` carry the QoS 0 story end to end; fakes, `serve --contract`, `record`/`replay` are the machine-free dev stage's machine park (companion, §8); declared method semantics and the command-authority lease pattern are the AI boundary's enforcement primitives (companion, §3 and §6); and the schema compatibility policy governs the projection contract file the way it governs `*.types.json`.

## 8. The Sparkplug-only relay profile (deferred)

For sites where only `spBv1.0/...` may cross a boundary and components on both sides must still call each other: the profile is designed, recorded here, and not built until a paying deployment states the need.

Shape: a Host-side relay that is a plain relay-only `RpcServer`; one MQTT client multiplexed into one virtual transport per Edge Node (per Device only where a Device independently hosts a peer); two transient Bytes metrics per endpoint carrying complete self-contained frames (§2.2.3) stamped with the cursor vocabulary; **`retry-until-deadline` semantics** — the caller retains the request and retransmits the same request id until a result, an error, or the original deadline, so the relay holds no custody and recovers from its own restart by doing nothing; duplicate suppression and durable idempotency at the target decide what a retry may do, exactly as they do today; commands serialized per target (§2.2.7). A `durable-relay` profile (journal before custody-transfer acknowledgement) is a later, stronger option that must never quietly become an offline work queue — the queue package exists for intended queueing.

Per interaction: state converges by snapshot, queries and idempotent commands retry freely, non-repeatable commands retry only against a durable idempotency store and otherwise end in `UnknownOutcome` stated plainly, ordinary events stay best-effort, audit-grade facts belong to the queue.

A related boundary case that does not need the relay: a dev-stage setup at a site whose policy allows only the Sparkplug namespace. A dev stage is not on the production broker, so granting a private topic on the dev broker is almost always available and always preferable. The tunnel stays rejected (§2.3).

One architectural note for the reader who knows the functional-safety world: the black channel treats the entire fieldbus as untrusted transport and puts all responsibility at certified endpoints — the same shape as this relay's caller-owned retries over QoS 0. The industry's safety tier concluded long ago that you do not trust the middle. This design applies that shape one tier up, and — per the companion's §10 — never claims to be the tier below.

## 9. Package and product boundary

`@source-repo/sparkplug` is public and versions independently, depending only on the library's public API — the second package (after the queue) whose existence proves the compatibility policy. It contains the vendored proto and generated code, the session state machine, the projection engine, the projection-contract format, and its tests. The CLI may grow a verb to scaffold and validate projection contracts.

The commercial knife — mechanism open entirely, administration commercial entirely, the litmus test, and the no-variant-classes rule — is doctrine of the companion document (§11 there), and this package sits wholly on the open side of it: everything named in this specification, including the projection's enforcement and its default-closed posture, is open source. Beyond this sentence, nothing in this repository references the commercial products.

## 10. Milestones

- **M1 — substrate.** Vendored proto, committed codegen, the Edge Node session machine (bdSeq, seq wrap, rebirth requests, STATE observation) tested against a real broker with an in-repo host-side validator. No projection yet: an Edge Node that is born, publishes one metric honestly, and dies correctly is the milestone.
- **M2 — read-only projection.** The projection contract file; component channel → snapshot-atomic DDATA; Quality on stale; DDEATH on closed; shape-hash rebirth; stable Device IDs under owner churn. This is the first customer-visible artifact.
- **M3 — the AI boundary**: specified and milestoned in the companion document. A parallel track, core library + CLI + console, independent of everything Sparkplug; listed here only so the numbering in earlier discussions stays valid.
- **M4 — allowlisted commands.** Writable metrics, idempotent-only, gateway-side bounds validation, confirmation-by-state, the full command-and-confirm flow tested rather than merely the DCMD arriving.
- **M5 — Templates** from component profiles, for repeated units.
- **M6 — relay profile**, only against a named paying need (§8).
- **TCK and certification** when the wording needs to change from "integration" to "compatible"; until then the safe words are the safe words.

## 11. Open questions

Recorded, deliberately unresolved: command authority across the boundary (§5); whether Sparkplug Group IDs should mirror any level of the internal topology or stay a flat deployment label; historian expectations for transient event metrics; and whether a dev-stage Sparkplug crossing ever becomes a real request rather than a theoretical one. The AI boundary's open questions — grants format, generation depth, instance badging mechanics — live with their specification, in the companion document's §13.
