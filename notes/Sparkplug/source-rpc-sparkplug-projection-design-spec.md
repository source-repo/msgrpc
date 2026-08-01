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
- **Security, never safety.** Nothing here is a functional safety mechanism — human safety belongs to the FSoE/TwinSAFE-class tier this stack neither implements nor touches. The full statement, binding on this document too, is the companion's §11 — and the companion's §10 is the duty-to-inform chapter that must accompany any marketing of AI into these environments, this projection included.

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

1. **Rebirth is decided by a projection hash; `peerShape` only triggers revalidation.** The chat proposes freezing a projection schema per session and re-birthing on change, and an early draft of this specification made 4.4.0's shape hash (`TransportEvent.peerShape`) that decision directly. Review corrected it, rightly: the two hashes answer different questions. A projection can change while the peer description is identical — a renamed metric, a changed unit, alias, bound, source path, a metric becoming writable, a Device added or removed — and a peer can reshape without touching a single projected path, which would rebirth for nothing. So `peerShape` is a *signal to revalidate*, and a normalized hash over the projection contract itself (plus the encoding version and the source-contract fragments the projection actually reads) is what decides. Only a changed projection hash rebirths.
2. **Ordering vocabulary is the event cursors'.** The chat invents `linkEpoch`/`streamSequence` for its inner frame. 4.4.0's event cursor discipline — an epoch per incarnation, a sequence that only orders within it, "cannot know" across a restart — is the same vocabulary, already server-side. The Sparkplug transport reuses it rather than shipping a third ordering language.
3. **The inner frame is assembled, not invented.** The chat correctly notes the MQTT 5 wire format keeps routing in packet properties, so its payload cannot be tunnelled as-is — but Source RPC transports own their wire format, and the socket.io transport already frames complete self-contained messages through its codec. A Sparkplug-carried frame is that framing plus the cursor fields, not a new protocol.
4. **Commit atomicity, stated at its true strength.** Sparkplug is metric-granular; the component channel is snapshot-atomic. The projection publishes **one DDATA per snapshot commit**, carrying every projected metric that commit changed, so report-by-exception happens by diffing inside the gateway rather than racing per-metric publishes. The accurate claim is narrow and review was right to narrow it: *a received DDATA never contains only part of a commit.* It is **not** that a consumer can never observe a torn picture — DDATA is QoS 0, so losing one whole message leaves the consumer with a later commit applied over an older one. Convergence is a separate mechanism (§4.1), not a consequence of atomicity.
5. **Connectivity and data quality are different things.** An early draft mapped a `stale` channel to a Quality of "uncertain", which is wrong twice over: Sparkplug 3.0 defines no UNCERTAIN code — the standard Quality property is `0` BAD, `192` GOOD, `500` STALE — and a channel going stale is a *connectivity* fact, not a value fact. A component channel that goes `stale` means the serving peer was lost and the last snapshot is being retained; the honest Sparkplug expression of that is **DDEATH**, after which a Host marks the Device offline and its metrics stale by the specification's own rules. `Quality = 500` is for the narrower case where the Device is reachable and one reported value is known to be stale; `Quality = 0` only where BAD is genuinely meant. A returning peer produces a DBIRTH carrying complete current values, never a trickle of the fields that happened to change while it was gone.
6. **Identity flattens, and the gateway sees less than an early draft claimed.** A DCMD carries no authenticated caller, so standard Sparkplug flattens command origin to "a publisher the broker authorized to write this topic". The draft said the gateway records the origin "client id, topic" — review caught the factual error: **a delivered MQTT PUBLISH does not carry the publisher's Client ID.** What the gateway can honestly record is the command topic, the payload and its timestamp, the metric names and values, its own broker session identity, and local receive time; anything more requires a trusted broker-side mechanism (audit logs, a broker-injected authenticated property, a command proxy), and a self-asserted `originClientId` user property is not authentication and must never be treated as one. On the Source RPC side the caller is always the projection gateway (§5.1).
7. **The relay is a private tunnel, and is no longer part of this document.** See §2.3.1 and the separate relay specification.

### 2.3 Rejected

1. **Carrying Source RPC frames inside this projection — and the pretence that a relay is not a tunnel.** An earlier draft rejected the opaque byte tunnel and then kept a deferred relay that carries complete self-contained Source RPC frames through two transient `Bytes` metrics. Review named that contradiction plainly: by any normal description, that *is* a private Source RPC tunnel over Sparkplug. The resolution is honesty rather than vocabulary. The tunnel is rejected **here** — nothing in `@source-repo/sparkplug` carries opaque Source RPC bytes, because a Sparkplug-only site accepted that constraint wanting inspectable traffic at the boundary, and the projection's entire security story is that the boundary can read what crosses it. The relay lives in its own specification (`source-rpc-sparkplug-relay-design-spec.md`) and its own package, described as what it is: a deliberate private extension that a deployment adopts as a stated policy exception. It is never dormant functionality inside the standards-based projection, and adopting it is a decision argued on its own terms.
2. **Dual-role Edge/Host peers.** Every peer holding Host command permissions recreates Source RPC badly inside Sparkplug and dissolves the ACL story. The chat reaches the same conclusion; recorded here as settled.
3. **Command result metrics (`Command/Last/*`) in v1.** State confirmation is the Sparkplug-native answer; a private result-metric profile is vocabulary nobody standard can read. Revisit only with a concrete consumer.

## 3. Goals and non-goals

**Goals.** A read-only projection a SCADA/historian can consume with zero knowledge of Source RPC; explicit, auditable command exposure; lifecycle fidelity (BIRTH/DEATH, rebirth, staleness) that never claims more than the fabric knows; an environment model that keeps AI tooling structurally out of production; a package boundary that proves the public extension architecture again.

**Non-goals.** Functional safety, or any wording that drifts toward it. General RPC over Sparkplug as a default path. Formal compatibility *listing* and trademark use in the first milestones — though TCK **execution** is an M1 exit criterion (§6), because the TCK exists precisely to catch the state-machine errors this document calls its cost centre. Until the listing process is complete the safe wording is "Sparkplug B integration", never "Sparkplug Compatible". Projecting the full topology graph: Sparkplug's Group/Edge/Device tree is shallower than Source RPC's parent/owner graphs, and flattening everything into it would lose information and churn BIRTHs; the full graph stays inside, with parent, owner and epochs exposed as metadata metrics where useful.

## 4. The projection model

| Source RPC | Sparkplug B |
| --- | --- |
| One runtime or gateway process | Edge Node |
| Selected component (explicitly listed) | Device, with a stable Device ID |
| Component class / profile | Template (later milestone) |
| `props` | DBIRTH metadata / read-only metrics |
| `state` snapshot | DBIRTH values, then DDATA on commit |
| Snapshot commit | Exactly one DDATA (every projected metric that commit changed) |
| Before the first complete snapshot | No DBIRTH yet — a Device is never born carrying fabricated defaults |
| Channel `stale` (serving peer lost) | DDEATH; the Host marks the Device offline and its metrics stale |
| Serving peer returns | DBIRTH with complete current values |
| One reported value known stale, Device reachable | `Quality = 500` on that metric |
| Value invalid while Device reachable | `Quality = 0`, only where BAD is genuinely meant |
| Channel `closed` / Device withdrawn from the projection | DDEATH, then absent from the next complete BIRTH sequence |
| Projection hash change (`peerShape` revalidates) | Controlled rebirth |
| Allowlisted idempotent method | Writable metric via DCMD |
| Parent / owner / epochs | Read-only metadata metrics |
| Low-rate transient event | Transient DDATA metric |

**Selection is a committed contract.** A projection is declared in a file — working name `sparkplug.projection.json` — naming the components, their Device IDs, the metric map (metric name → props/state path), units and bounds, and the writable allowlist. It is committed and checked like `*.types.json`, because the projection is a contract with the plant: reviewable in a diff, not assembled in someone's head. The CLI can scaffold it from an extracted contract — `extract` already knows every component's props and state shapes — but a human commits it, and nothing is projected that the file does not name.

**Device IDs are stable.** An owner reassignment is a logical remount inside Source RPC and must never change a Device ID or cause a DEATH/BIRTH cycle; the owner metadata metric changes, the Device stays. BIRTH churn is the Sparkplug equivalent of the reconnect storms this library spends so much machinery avoiding.

**The gateway is a component host like any other.** It subscribes to projected components through the ordinary component channel (`client.component()`), so it inherits epoch/revision ordering, targeted snapshots on subscribe, and staleness — the projection's fidelity is the channel's fidelity, not a parallel implementation.

The contract file carries more than the mapping, because most of what makes a projection correct is not the mapping: its own schema version; Group ID and Edge Node ID validation; stable Device IDs; deterministic aliases that are **unique across the entire Edge Node's metric set**, not merely within a Device, as the specification requires; Sparkplug datatype conversion and nullable-value handling; numeric range and unit metadata; array and map restrictions; a packet-size estimate; per-metric publish rate and deadband; command deadline and rate limit; the reported-state path for every writable metric; whether a metric is historical or transient; and the namespace rule for custom properties.

### 4.1 Converging under QoS 0

Commit atomicity (§2.2.4) says a DDATA is never a fragment of a commit. It says nothing about a DDATA that never arrives, and Sparkplug requires data at QoS 0 — no acknowledgement, no retry, arrives once or not at all. A lost `DDATA(A, B)` followed by a delivered `DDATA(C)` leaves the consumer with new `C` over stale `A` and `B`: no commit was torn, and the reconstructed state has still diverged. Sparkplug's own answer is sequence validation plus Host-initiated rebirth, and the projection has to hold up its end of it:

- **One global output queue per Edge Node.** NBIRTH, DBIRTH, NDATA, DDATA and DDEATH share one `seq` stream, so a Host can detect a gap at all.
- **Diff against what was published, not against what was observed.** An incoming snapshot must not advance the projection baseline until its DDATA has been handed off to the local MQTT client, or a lost message is also forgotten.
- **Bound and coalesce.** "One DDATA per commit" must not mean an unbounded queue behind a component committing at kilohertz. Per-Device `maxPublishHz`, deadband and latest-wins coalescing, with the coalesced diff computed against last-published state.
- **Republish completely on quality transitions.** A Device returning to life publishes every projected value through DBIRTH, not only what changed while it was away.
- **One packet, or refuse.** If a projected snapshot cannot fit the configured MQTT packet limit, the contract is rejected or the offending value is explicitly mapped to a Dataset or Bytes metric. Multipart publishing would dissolve the atomicity claim.
- **Rebirth is implemented and tested early**, because under QoS 0 it is not an ancillary feature — it is the recovery mechanism.

## 5. Commands across the boundary

A writable metric maps to exactly one method, declared `idempotent-command`, with bounds and units validated by the gateway before the call is made — a DCMD with an out-of-range value is refused at the boundary and never travels. Completion is confirmed by the resulting state update, which is the Sparkplug-native pattern; callers that need RPC result semantics are Source RPC callers and should be inside.

Non-repeatable commands, parameterized queries, long-running workflows, typed errors, deadlines-and-cancellation: all stay Source RPC. The boundary's poverty is a feature — what crosses it is exactly what a metric write can honestly express.

**Read-only mode is a first-class deployment option**, not an afterthought: a projection with an empty allowlist is the recommended starting posture for every new site.

**Confirmation is weaker than it looks, and the specification says so.** Three consequences of confirming by state:

- **A same-value command still gets confirmed.** If the setpoint is already 6 and a Host writes 6, the component may commit nothing and the Host would wait forever for a confirmation that never comes. The gateway republishes the reported metric after a mapped method returns successfully, even unchanged — which says "the gateway processed a command and the current value is six", and deliberately does not say *which* request caused it, because Sparkplug carries no command correlation.
- **A failed command is indistinguishable from a slow one.** There is no standard result channel, so a Host cannot tell command loss from gateway refusal from method failure from delayed convergence, using the standard metric surface alone. That is stated plainly rather than papered over; `UnknownOutcome` is recorded in the gateway's audit and cannot be returned to an ordinary Sparkplug Host as a typed error.
- **A multi-metric DCMD is processed non-atomically, and says so.** Sparkplug permits several metrics in one DCMD. The projection prevalidates every mapped value, then applies them sequentially, with explicitly non-atomic semantics. A genuinely grouped transaction is modelled as one grouped Source RPC method declared for a named metric set — never inferred because two metrics arrived in the same packet.

**Refused for projection**, beyond the non-idempotent: methods requiring an owner fence or a command-authority lease; methods with no corresponding reported-state metric; and commands whose useful outcome cannot be represented as current state.

**Command authority does not cross the boundary — resolved as no for v1.** An earlier draft left this open. A gateway holding `$acquire` "on behalf of the operator" would be claiming an authenticated identity it does not have (§5.1), which is exactly the thing this design refuses to invent. Revisit only if a deployment supplies a separately authenticated identity channel from the SCADA.

### 5.1 The gateway principal

Where the two specifications meet, and binding on both. Every projected command reaches Source RPC as the **gateway's own principal** under a narrow service identity — `sparkplug-gateway/site-a` in shape — and ordinary Source RPC authorization then permits exactly the projected methods and nothing else. The gateway never reconstructs or claims the original requester; an untrusted Sparkplug property never becomes a principal; and a standard Sparkplug command does **not** consume an `ai.tool.*` grant merely because the SCADA that sent it happens to contain AI, because nothing in the frame says so and inventing that claim would be worse than admitting the gap.

The resulting trust statement is short enough to put in front of a customer: *the broker decides which systems may publish commands; the projection contract decides which metrics may become Source RPC calls; Source RPC authorization decides which calls the gateway principal may make.*

## 6. Protocol substrate

**Protobuf, static, vendored.** Sparkplug B payloads are protobuf. The official `sparkplug_b.proto` is vendored at a pinned spec version, code is generated once and committed (the same discipline as the extracted contracts: generated artifacts are reviewed files, not build-time surprises), and regeneration is a scripted step with a check. No runtime reflection.

**The session state machine is the actual work.** `bdSeq` pairing between NBIRTH and the NDEATH Will; the 0–255 `seq` wrap on data; `Node Control/Rebirth` handling; primary-host STATE observation; data and commands at QoS 0, non-retained, on clean sessions. This is fiddly, TCK-tested territory and the honest cost center of the whole project — the mapping is a week, the state machine is the month. It lives in `@source-repo/sparkplug` as its own tested module, independent of the projection logic above it.

**The TCK runs in CI from M1**, not at the end. It exists to catch exactly these errors, and running it late means finding them after the projection is built on top of them. Passing the applicable Sparkplug 3.0 TCK tests against a real broker is an M1 exit criterion; the formal compatibility listing, with its membership and trademark obligations, stays a later commercial decision (§3).

**Attribution is part of the package**, not an afterthought at publication: the Eclipse specification is credited, the vendored proto keeps its copyright and licence intact, the Sparkplug trademark is acknowledged, and someone checks that `@source-repo/sparkplug` is acceptable naming under Eclipse's trademark guidance before the name is published.

**Two clients, one broker.** The Sparkplug session (NDEATH Will, clean start) and the Source RPC MQTT transport (retained presence Will, persistent session) are separate MQTT clients even when they share a broker and a process — and separate all the way down: different Client IDs, different credentials where the deployment can issue them, separate least-privilege ACLs, and no shared private key merely because the two happen to run in one process. A future `SparkplugTransport` that replaces presence with Sparkplug lifecycle is explicitly out of scope until the projection has earned its keep.

## 7. What already exists and is reused

Recorded so the implementation does not rebuild it: the component channel (snapshots, epoch/revision, status with age) is the projection's entire data source; the shape hash (4.4.0) is the revalidation trigger behind the projection hash (§2.2.1); the event cursors (4.4.0) are the ordering vocabulary for anything Sparkplug-carried; `peersSettled` is the gateway's startup discipline; the idempotency store and `UnknownOutcome` carry the QoS 0 story end to end; fakes, `serve --contract`, `record`/`replay` are the machine-free dev stage's machine park (companion, §9); declared method semantics and the command-authority lease pattern are the AI boundary's enforcement primitives (companion, §3 and §6), whose `effect` classification the projection's writable allowlist should declare; and the schema compatibility policy governs the projection contract file the way it governs `*.types.json`.

## 8. The relay lives elsewhere

For sites where only `spBv1.0/...` may cross a boundary and components on both sides must still call each other, a relay carrying complete Source RPC frames through transient `Bytes` metrics is designed — in **`source-rpc-sparkplug-relay-design-spec.md`**, as its own package, and described there as what it is: a private tunnel adopted as a stated policy exception (§2.3.1). It is deferred until a paying deployment names the need, and nothing in this specification or in `@source-repo/sparkplug` depends on it or carries Source RPC bytes.

A related boundary case that does not need it: a dev stage at a Sparkplug-only site is not on the production broker, so a private topic on the dev broker is almost always available and always preferable.

## 9. Package and product boundary

`@source-repo/sparkplug` is public and versions independently, depending only on the library's public API — the second package (after the queue) whose existence proves the compatibility policy. It contains the vendored proto and generated code, the session state machine, the projection engine, the projection-contract format, and its tests. The CLI may grow a verb to scaffold and validate projection contracts.

`@source-repo/sparkplug-relay` is a separate package with its own specification, deliberately not a mode of this one, so that a standards-based projection and a private tunnel can never be confused for one another in a dependency list.

The commercial knife — mechanism open entirely, administration commercial entirely, the litmus test, and the no-variant-classes rule — is doctrine of the companion document (§12 there), and this package sits wholly on the open side of it: everything named in this specification, including the projection's enforcement and its default-closed posture, is open source. Beyond this sentence, nothing in this repository references the commercial products.

## 10. Milestones

- **M1 — substrate.** Vendored proto, committed codegen, the Edge Node session machine (bdSeq, seq wrap, rebirth requests, STATE observation) tested against a real broker with an in-repo host-side validator, **and the applicable Sparkplug 3.0 TCK tests passing in CI** — the exit criterion, not a later phase. No projection yet: an Edge Node that is born, publishes one metric honestly, and dies correctly is the milestone.
- **M2 — read-only projection.** The projection contract file with its own schema and canonical hash; component channel → one DDATA per commit; the convergence policy of §4.1 (global seq stream, publish-state diffing, bounded coalescing, rebirth tested against real broker faults); DDEATH on a lost serving peer and `Quality = 500` for a stale value; alias allocation tests; stable Device IDs under owner churn. This is the first customer-visible artifact.
- **M3 — the AI boundary**: specified and milestoned in the companion document. A parallel track, core library + CLI + console, independent of everything Sparkplug; listed here only so the numbering in earlier discussions stays valid.
- **M4 — allowlisted commands.** Writable metrics, idempotent-only, gateway-side bounds validation, confirmation-by-state, the full command-and-confirm flow tested rather than merely the DCMD arriving.
- **M5 — Templates** from component profiles, for repeated units.
- **M6 — the relay**, in its own specification and package, only against a named paying need (§8).
- **Formal listing and trademark use** when the wording needs to change from "integration" to "compatible" — the TCK itself runs from M1. Until listing completes, the safe words are the safe words.

## 11. Open questions

Recorded, deliberately unresolved (command authority across the boundary is no longer among them — resolved as no for v1 in §5): whether Sparkplug Group IDs should mirror any level of the internal topology or stay a flat deployment label; historian expectations for transient event metrics; and whether a dev-stage Sparkplug crossing ever becomes a real request rather than a theoretical one. The AI boundary's open questions — grants format, generation depth, instance badging mechanics — live with their specification, in the companion document's §14.
