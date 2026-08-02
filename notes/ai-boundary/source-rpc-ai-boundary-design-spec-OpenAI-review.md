# Overall verdict

These are the strongest Source RPC architecture documents so far. The major decisions are sound:

* Sparkplug is a **projection**, not the definition of the Source RPC network.
* The first implementation is read-only.
* Projected components and commands are explicitly selected.
* Source RPC remains peer-to-peer internally.
* AI is represented as an authenticated principal with explicit, node-local powers.
* Security enforcement remains open source while fleet-scale administration is commercial.
* Neither document claims functional safety.

That division is clear in both executive decisions.   It also preserves the earlier, important separation between commands, events and queued work. 

I would approve the **architecture**, but not yet mark either specification final. The Sparkplug document contains one outright contradiction and several protocol-level corrections. The AI document has an excellent authorization model but needs a more precise execution, credential and data-egress model before implementation.

I also checked the current public repository. Source RPC is presently at 4.5.0, and its existing security model already covers pinned peer identities, per-frame MQTT signing, TLS, ordinary authorization and explicit warnings about unauthenticated buses. The new documents fit that foundation rather than replacing it. ([GitHub][1])

# Sparkplug projection specification

## 1. Resolve the tunnel-versus-relay contradiction

This is the only direct internal contradiction.

The document says:

* projection rather than tunnelling;
* opaque Source RPC bytes through Sparkplug are explicitly rejected;
* activating such a mechanism later would require a new decision.

But it also retains a deferred relay that carries complete self-contained Source RPC frames through two transient `Bytes` metrics. That is, by any normal description, a private Source RPC tunnel over Sparkplug.   

There are three coherent choices:

1. **Remove the relay entirely.** Sparkplug-only environments accept host-mediated state and commands.
2. **Retain it as an explicit private extension.** State plainly that this is non-native Sparkplug tunnelling and an exception to the normal boundary policy.
3. **Replace generic relay frames with an inspectable command profile.** This preserves the boundary but no longer supports arbitrary Source RPC peer-to-peer calls.

Given your earlier conclusion, I recommend option 2, but move it into a separate specification and probably a separate package:

```text
@source-repo/sparkplug
    Native projection only

@source-repo/sparkplug-relay
    Optional private Source RPC relay profile
    Requires an explicit deployment-policy exception
```

That keeps the projection’s commercial story clean:

> Standard systems see normal Sparkplug metrics and commands.

And makes the relay’s story honest:

> A constrained site can deliberately use a private Source RPC transport carried by Sparkplug Bytes metrics.

It should not be described as dormant functionality inside the standards-based projection.

## 2. Correct the staleness and DDEATH mapping

The document currently says a stale Source RPC channel maps to Sparkplug quality “uncertain.” 

Sparkplug 3.0 does not define an `UNCERTAIN` quality code. Its standard `Quality` property has:

* `0` — BAD
* `192` — GOOD
* `500` — STALE

([Eclipse Sparkplug][2])

There is a second, more important semantic distinction. Sparkplug defines DDEATH specifically for a Device that is no longer accessible, and Host Applications then mark the Device offline and all its metrics stale. ([Eclipse Sparkplug][3])

The correct mapping should distinguish **connectivity** from **data quality**:

| Source condition                                                | Sparkplug representation                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| Component reachable and snapshot current                        | Device online; quality omitted or GOOD                        |
| Component reachable, but an individual reported value is stale  | DDATA with `Quality = 500` on that metric                     |
| Source RPC peer/component becomes unreachable                   | DDEATH                                                        |
| Source RPC peer returns                                         | DBIRTH with complete current values                           |
| Projection removes a previously born Device                     | DDEATH, then omit it from the next complete BIRTH sequence    |
| Invalid or failed source data while component remains reachable | `Quality = 0` only when BAD is genuinely the intended meaning |

Assuming the Source RPC component channel’s `stale` status means “last snapshot retained after loss of the serving peer,” it should normally produce **DDEATH**, not merely a quality update. A component-level stale status and a domain value carrying stale quality are not the same event.

Also specify what happens before the first valid snapshot. The cleanest rule is:

> Do not DBIRTH the Device until the first complete snapshot exists.

That avoids publishing fabricated defaults.

## 3. Use a projection hash, not `peerShape`, as the rebirth decision

Reusing the existing shape-change event is sensible, but the peer shape itself is not the projection schema.

The projection contract can change while the Source RPC peer description remains identical:

* metric name changes;
* unit changes;
* alias changes;
* state path changes;
* bounds change;
* a metric becomes writable;
* a component is added or removed from the projection.

Conversely, an unprojected RPC method could change the peer shape while leaving every Sparkplug metric unchanged. The current text would then rebirth unnecessarily.  

Use `peerShape` as a signal to **revalidate**, then compute a dedicated normalized hash:

```ts
interface SparkplugProjectionShape {
  readonly protocolVersion: number;
  readonly groupId: string;
  readonly edgeNodeId: string;

  readonly devices: readonly {
    readonly deviceId: string;
    readonly componentRef: string;

    readonly metrics: readonly {
      readonly name: string;
      readonly alias?: bigint;
      readonly dataType: string;
      readonly sourcePath: string;
      readonly unit?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly writable?: SparkplugWritableBinding;
    }[];
  }[];
}
```

Conceptually:

```ts
const projectionHash = hashCanonical({
  sparkplugEncodingVersion,
  normalizedProjectionContract,
  relevantSourceContractFragments,
});
```

Only a changed `projectionHash` should require rebirth. A changed peer shape that does not affect projected paths should not.

## 4. Narrow the snapshot-atomicity claim and add a convergence policy

Publishing all metrics changed by one Source RPC snapshot in one DDATA is a good rule. Sparkplug explicitly permits multiple changes to be aggregated in one DDATA. ([Eclipse Sparkplug][3])

But this sentence is too strong:

> “a consumer can never observe a torn snapshot.”

The stronger, accurate statement is:

> **All projected metrics changed by one Source RPC commit are emitted in one DDATA, so a received DDATA never contains only part of that commit.**

Sparkplug requires DDATA to use QoS 0. QoS 0 receives no acknowledgement and performs no retry; a message arrives once or not at all. ([Eclipse Sparkplug][3])

Consider:

```text
Commit 1 changes A and B
  DDATA(A, B) is lost

Commit 2 changes C
  DDATA(C) arrives
```

The consumer now has new `C` but old `A` and `B`. The individual commit was not torn, but the reconstructed state has diverged.

Sparkplug addresses this through global Edge Node sequence ordering and Host-initiated rebirth after unresolved sequence gaps. Host Applications are required to validate sequence order, and the Edge Node must respond to `Node Control/Rebirth` with a complete NBIRTH/DBIRTH sequence. ([Eclipse Sparkplug][3])

The implementation specification should therefore add these invariants:

1. **One global Sparkplug output queue per Edge Node.**
   NBIRTH, DBIRTH, NDATA, DDATA and DDEATH all share the same `seq` stream.

2. **Diff against the last successfully handed-off publication state, not the last observed Source RPC state.**
   An incoming component snapshot must not advance the projection baseline before its DDATA has been accepted by the local MQTT client.

3. **Bound and coalesce.**
   “One DDATA per commit” must not imply an unbounded queue when a component updates at 5 kHz. Add per-device `maxPublishHz`, deadband and latest-wins coalescing. The coalesced diff must be calculated against the last published state.

4. **Publish complete values on quality transitions.**
   When a Device returns to live state, publish every projected value through DBIRTH rather than only fields changed while it was absent.

5. **Enforce a one-packet atomicity limit.**
   If a projected snapshot cannot fit within the configured MQTT packet limit, reject the projection contract or explicitly map the large value to a Dataset/Bytes metric. Multipart publishing would invalidate the simple atomicity claim.

6. **Implement and test full rebirth early.**
   Rebirth is not an ancillary feature; it is part of the QoS 0 recovery mechanism.

## 5. The gateway cannot normally see the publisher’s MQTT client ID

The identity-flattening section is correct in principle but contains one factual problem:

> “The gateway records the Sparkplug-side origin it can see (client id, topic).”

A standard MQTT PUBLISH delivered to a subscriber contains the topic, packet identifier where applicable, properties and payload. It does not contain the publisher’s Client ID. ([OASIS Open][4])

The gateway can reliably record:

* DCMD/NCMD topic;
* payload timestamp;
* metric aliases/names and values;
* the gateway’s own broker/session identity;
* local receive time.

It cannot reliably record the publishing Host’s Client ID unless the deployment supplies an additional trusted mechanism, such as:

* broker audit logs;
* a broker-injected authenticated property;
* a vendor-specific extension;
* a dedicated broker-side command proxy;
* a separately authenticated Source RPC channel.

A user property named `originClientId` is self-asserted and must not be treated as authentication.

Replace the paragraph with something like:

> Standard Sparkplug flattens command origin to “a publisher authorized by the broker to write this command topic.” The gateway cannot identify the originating MQTT Client from a normal delivered PUBLISH. It records the command topic and payload and, where configured, correlates them with trusted broker-side audit data. On the Source RPC side, the caller is always the projection gateway.

This is especially important because the AI sponsorship chain cannot survive an ordinary DCMD boundary.

## 6. State confirmation is not an RPC acknowledgement

The command restriction is well chosen: explicit allowlist, idempotent methods, validated range and units, with resulting state reported through DDATA.  Sparkplug itself uses this pattern: a DCMD writes output metrics and the resulting values are expected back in DDATA. ([Eclipse Sparkplug][3])

But three ambiguities remain.

### Same-value commands

Suppose the current setpoint is already `6` and a Host sends `6`. The Source RPC component may emit no new snapshot because nothing changed. The Host then receives no confirmation.

The gateway should republish the reported metric after the mapped method returns successfully, even when its value is unchanged.

That confirms:

> The gateway processed a command and the current reported value is six.

It still does not prove which Host request caused the state, because Sparkplug supplies no command correlation.

### Failed commands

If validation or method execution fails, there is no standard Sparkplug result channel. The Host sees only an absent state confirmation. The rejected `Command/Last/*` profile is therefore defensible, but the specification must say plainly:

> A Sparkplug Host cannot distinguish command loss, gateway refusal, method failure and delayed state convergence from the standard metric surface alone.

`UnknownOutcome` can be recorded in the gateway audit, but it cannot be returned as a typed Source RPC error to an ordinary Sparkplug Host.

### Multi-metric DCMD

Sparkplug permits several metrics in one DCMD. ([Eclipse Sparkplug][3]) The specification must choose one of these semantics:

* reject DCMD payloads containing more than one mapped writable metric;
* process them independently and explicitly state that the operation is non-atomic;
* define a deliberately grouped Source RPC method for a declared metric set.

I recommend prevalidating all values, then processing mapped metrics sequentially with explicitly non-atomic semantics. A real grouped transaction should map to one grouped method, not be inferred because two metrics happened to arrive in the same MQTT packet.

For M4, also reject projection of:

* methods requiring owner or command-authority leases;
* non-repeatable commands;
* methods without a corresponding reported-state metric;
* commands whose useful outcome cannot be represented as current state.

The command-authority question in §5 should probably be resolved as **no for v1**, rather than left open.

## 7. Move TCK execution earlier; defer only the branding process

The distinction should be:

* **TCK testing:** part of M1/M2 engineering.
* **Formal compatibility listing and trademark use:** later commercial/certification decision.

The TCK exists precisely to catch the fiddly state-machine errors that the document correctly identifies as the main cost centre. The Eclipse process permits implementations and testing, while formal “Sparkplug Compatible” claims and listing have additional licensing, membership and trademark requirements. ([Eclipse Sparkplug][5])

I would make this an M1 exit criterion:

> The Edge Node session implementation passes all applicable Sparkplug 3.0 TCK tests in CI against a real MQTT broker.

Formal listing can remain later.

The package also needs:

* Eclipse specification attribution;
* retained copyright and licence information for the vendored proto;
* Sparkplug trademark attribution;
* a review of whether `@source-repo/sparkplug` is acceptable naming under Eclipse’s trademark guidance.

## 8. Strengthen the projection contract

The committed projection file is one of the best design choices in the document.  It should additionally define:

* its own schema version;
* Group ID and Edge Node ID validation;
* stable Device IDs;
* deterministic aliases;
* global alias uniqueness across the complete Edge Node, not merely within one Device;
* Sparkplug datatype conversion;
* nullable-value handling;
* numeric range and unit metadata;
* array/map restrictions;
* packet-size estimate;
* per-metric publish rate/deadband;
* command deadline and rate limit;
* reported-state path for every writable metric;
* whether a metric is historical or transient;
* custom property namespace rules.

Sparkplug aliases, when used, must be unique across the Edge Node’s complete metric set. ([Eclipse Sparkplug][2])

The two MQTT clients should also use:

* different Client IDs;
* different credentials where possible;
* separate least-privilege ACLs;
* no shared private key merely because they run in one process.

# AI boundary specification

## 1. The conceptual model is excellent

The strongest ideas are:

* authorization status rather than an argument about AI competence;
* node-local grants at the point where consequences occur;
* separate tool-origin and program-origin provenance;
* separate write and programming powers;
* sponsorship as the issuance-side complement to target-side grants;
* lease-shaped grants;
* open enforcement with commercial administration;
* one `RpcServer`, with richer hook implementations rather than commercial subclasses.

  

The badge analogy is also commercially strong because it turns an abstract capability system into an operating model that plant staff already understand.

## 2. RPC repeat semantics and authorization effect are orthogonal

The write grant can use current Source RPC semantics to distinguish `query` from commands. But the programming grants cannot be inferred from:

```ts
'query'
'idempotent-command'
'non-repeatable-command'
```

A method that uploads a program and a method that sets a pump setpoint may both be idempotent commands. They need different AI grants. The document currently defines the distinction but not the metadata that mechanically enforces it.  

Add an orthogonal method classification:

```ts
export type RpcEffect =
  | 'observe'
  | 'operate'
  | 'program'
  | 'security-admin';

@rpc({
  semantics: 'idempotent-command',
  effect: 'operate',
})
async setSetpoint(value: number): Promise<void>;

@rpc({
  semantics: 'idempotent-command',
  effect: 'program',
})
async deployProgram(program: ProgramBundle): Promise<void>;
```

Then:

| Provenance   | Effect           | Required AI grant                 |
| ------------ | ---------------- | --------------------------------- |
| `ai-tool`    | `observe`        | ordinary scoped authorization     |
| `ai-tool`    | `operate`        | `ai.tool.write`                   |
| `ai-tool`    | `program`        | `ai.tool.program`                 |
| `ai-program` | `operate`        | `ai.program.write`                |
| `ai-program` | `program`        | `ai.program.program`              |
| any AI       | `security-admin` | dedicated sponsorship/admin grant |

Important defaults:

* an exposed command with no explicit effect is treated as `operate`;
* known program-management APIs explicitly declare `program`;
* an unknown or unclassifiable effect is denied to AI;
* method semantics continue to determine retry/idempotency behaviour, not permission class.

## 3. Observation needs explicit scope even if it does not need two more grants

The document insightfully explains that observation-only AI can still be a major data-egress path.  But its default ladder says a credentialed AI may make query calls wherever ordinary authorization allows. 

That is safe only if the derived AI credential begins with a deliberately narrow ordinary authorization scope.

I would preserve the four principal grants rather than add `ai.tool.read` and `ai.program.read`, but make this normative:

> **A derived AI credential inherits no usable permissions automatically. Its query, event and introspection scope is explicitly selected during sponsorship and must be an attenuation of the sponsor’s own rights.**

For example:

```ts
export interface RpcCredentialScope {
  readonly peers?: readonly string[];
  readonly namespaces?: readonly string[];
  readonly methods?: readonly string[];
  readonly events?: readonly string[];

  readonly maxResponseBytes?: number;
  readonly expiresAt: number;
}
```

The badge desk should also be able to express data-handling constraints:

```ts
export interface RpcAiDataPolicy {
  readonly allowedClassifications:
    | readonly ['public']
    | readonly ['public', 'internal']
    | readonly ['public', 'internal', 'confidential'];

  readonly modelDestination?: {
    readonly provider: string;
    readonly region?: string;
    readonly retentionPolicy?: string;
  };
}
```

The RPC library need not implement enterprise data classification, but the credential and authorizer interfaces should leave room for it.

## 4. Provenance is issuer-vouched metadata, not AI detection

The specification understands that roles must be issued rather than self-declared.  It should state one further limitation explicitly:

> Source RPC does not detect whether a caller, model or program is AI-generated. It enforces provenance asserted by a trusted credential issuer.

This matters in several cases:

* an AI tool using a stolen human token appears human;
* a person can paste generated code into an ordinary deployment path;
* an AI-authored program can be copied and launched under a service credential;
* the recorded model name may not be the model actually used.

The design remains useful; its assurance depends on issuance discipline and process isolation, not semantic AI detection.

A program should remain `ai-program` until a deliberate promotion operation occurs:

```text
AI-generated artifact
    ↓ named human review
approved artifact hash
    ↓ new deployment identity
human-approved program
```

Reviewing the source must not silently strip provenance. Promotion should produce a signed audit record and a new artifact identity.

## 5. Derived credentials need a normative claim set

DEV-361 is the right prerequisite, but “derived per-script credential” is not yet specific enough. 

A derived identity should minimally contain:

```ts
export interface RpcDerivedIdentityClaims {
  readonly credentialId: string;
  readonly subject: string;
  readonly roles: readonly (
    | 'ai-tool'
    | 'ai-program'
  )[];

  readonly issuer: string;
  readonly sponsorSubject: string;
  readonly sponsorSessionId: string;
  readonly parentCredentialId?: string;

  readonly generation: number;
  readonly issuedAt: number;
  readonly expiresAt: number;

  readonly scope: RpcCredentialScope;

  readonly model?: {
    readonly provider?: string;
    readonly id?: string;
    readonly version?: string;

    readonly assurance:
      | 'sponsor-declared'
      | 'runtime-attested'
      | 'vendor-attested';
  };

  readonly artifactDigest?: string;
  readonly deploymentId?: string;
}
```

Additional requirements:

* the parent credential is never passed into the child;
* a derived credential is pinned to its own peer name;
* program credentials should be bound to an artifact digest and deployment;
* credentials are short-lived by default;
* sponsor-session termination prevents renewal;
* standing sponsorship is an explicit lease with an owner and end date;
* revocation can invalidate a credential before natural expiry;
* where practical, use proof-of-possession rather than a freely reusable bearer secret.

The document correctly says model identity verifies nothing about the model’s nature.  The `assurance` distinction makes that honest enough for enforcement: a site may display a sponsor-declared model version while refusing to use it as a hard policy condition.

## 6. Bus authorization does not sandbox an AI-authored program

This is the largest missing security boundary.

The four grants can limit what a program does **through Source RPC**. They do not stop a locally running program from:

* reading arbitrary files;
* opening another socket;
* calling an OPC UA server directly;
* using another MQTT client;
* accessing a vendor engineering API;
* reading a stronger credential from the process environment;
* opening a local device or shared-memory interface.

The current Source RPC security documentation explicitly says whole scripts run with the privileges of the server process and that the current JavaScript/Python execution facilities are not a hostile-code security boundary. ([GitHub][6])

Therefore:

> DEV-361 solves program identity, not program isolation.

A production AI-program milestone requires a separate runtime boundary:

* WASM or another sandbox with capability-selected imports;
* no ambient filesystem or network;
* no inherited parent tokens;
* CPU, memory and wall-time limits;
* signed artifact loading;
* immutable artifact digest attached to the credential;
* explicit hardware/shared-memory capabilities;
* separate OS identity or container where native code is involved;
* kill and revoke paths.

This does not all need to live in `@source-repo/rpc`, but the AI-boundary document must name it as a prerequisite for production `ai-program` use.

## 7. Add revocation, audit and admission-control requirements

The lease approach is good, and the console concept is excellent.  The normative mechanics should include:

### Grant storage

A grant document must be:

* schema-versioned;
* atomically replaced;
* authenticated or locally protected against untrusted modification;
* denied completely when missing, malformed or unsupported;
* accompanied by a monotonic revision;
* auditable on every change.

### Emergency closure

Every node should support:

```ts
await security.revokeCredential(credentialId);
await security.closeAllAiGrants();
await security.terminateSponsoredSessions(sponsorId);
```

This is an operational-security control, not a safety function.

### Admission control

AI calls need more than visibility after repetition. Add enforceable limits:

* calls per second;
* concurrent calls;
* concurrent commands;
* response bytes;
* introspection breadth;
* repeated identical operations;
* program deployments per time window;
* maximum chain generation.

An AI can exhaust a system through valid queries even when every write grant is closed.

### Audit

The open mechanism should provide at least an append-only local audit sink containing:

* authenticated principal;
* sponsor chain;
* credential and model metadata;
* method, target and effect class;
* grant decision;
* ordinary authorization decision;
* allow or deny result;
* correlation and causation IDs;
* lease state;
* rate-limit decision.

Fleet retention, search, approval reports and compliance dashboards can remain commercial.

## 8. Three wording changes are important

### “AI as a principal, never as a threat category”

The authorization insight is right, but “never as a threat category” is broader than necessary. AI-specific prompt injection, tool-output poisoning, rapid repetition and data egress remain legitimate threat-model categories.

A safer formulation is:

> **Source RPC represents AI as an authenticated principal rather than trying to infer trust from its nature. AI-specific threats are addressed by provenance, capability bounds, isolation and data policy.**

### “RpcServer is always secure”

This is a memorable commercial doctrine, but it is not literally true. Current Source RPC intentionally permits an unauthenticated bus on a trusted network and warns that anyone who reaches it may relay or inspect traffic. ([GitHub][6])

Use:

> **Complete security enforcement is always included; administration at scale is commercial.**

Or the even stronger marketing line:

> **Security is never a paid feature. Managing it across a fleet is.**

That preserves the commercial knife without making an absolute security guarantee.

### “No AI modelling with dangerous machines”

This appears to be either a wording error or an overreach. It directly conflicts with Source Assess, whose purpose includes modelling critical industrial systems. 

Replace it with:

> **No safety function depends on Source RPC or AI, and AI-reachable systems have no route to safety-engineering interfaces.**

AI may still:

* inspect;
* model;
* explain;
* diagnose;
* simulate;
* propose;
* generate changes for review.

What it must not do is become the mechanism on which human safety relies.

## 9. Separate the normative specification from the explanatory security essay

Section 9 is powerful and memorable. The worked examples about disappeared friction, composed events, deterrence and data destination communicate the problem better than ordinary security boilerplate. 

But it mixes:

* normative architecture;
* threat-model claims;
* customer education;
* marketing doctrine;
* philosophical language about agency and deterrence.

I would retain all of it, but split the outputs:

```text
source-rpc-ai-boundary-design-spec.md
    Normative principals, credentials, grants,
    sponsorship, enforcement, revocation, audit

docs/what-changes-when-ai-joins-a-plant.md
    Human-facing explanation and worked scenarios
```

The normative specification should reference the educational chapter as a required publication deliverable. This will make the implementation review much easier without losing the strongest prose.

# Cross-document decision

The two documents meet at the Sparkplug gateway.

A standard DCMD does not preserve an authenticated human, AI or model identity. Therefore:

* every projected command reaches Source RPC as the **Sparkplug gateway principal**;
* the gateway may not reconstruct or claim the original sponsor;
* an untrusted Sparkplug property may not become `principal`;
* standard Sparkplug commands do not consume an `ai.tool.*` grant merely because the originating SCADA happens to contain AI;
* broker ACLs, SCADA-side user audit and gateway allowlists are separate security layers;
* command authority must not be acquired “on behalf of the operator” unless an additional authenticated identity channel exists.

For v1, the gateway should have a narrow service identity such as:

```text
sparkplug-gateway/site-a
```

Normal Source RPC authorization then allows only the specifically projected methods.

That produces a clean trust statement:

> The broker decides which systems may publish commands. The projection contract decides which Sparkplug metrics may become Source RPC calls. Source RPC authorization decides which calls the gateway principal may make.

# Recommended adoption status

## Adopt unchanged

* projection over native Sparkplug semantics;
* explicit projection contract;
* read-only first;
* stable Device identity independent of Source RPC owner;
* two MQTT sessions;
* explicit idempotent command allowlist;
* security-not-safety separation;
* AI sponsorship;
* per-node lease-shaped grants;
* open mechanism/commercial administration;
* no commercial `RpcServer` variants;
* relay deferred until a named paid need.

## Correct before implementation

1. Relay/tunnel contradiction.
2. `UNCERTAIN` quality wording.
3. DDEATH versus channel-stale semantics.
4. Projection-specific schema hash.
5. QoS 0 convergence and bounded coalescing.
6. MQTT publisher Client ID claim.
7. Sparkplug command confirmation limitations.
8. Multi-metric DCMD semantics.
9. Orthogonal RPC `effect` classification.
10. Explicit query/event scope for derived AI credentials.
11. Credential claim, expiry and revocation model.
12. Production sandbox boundary for AI-authored programs.
13. Literal “always secure” and “no AI modelling” wording.

## Move earlier

* TCK execution;
* projection JSON Schema and canonical hash;
* alias allocation tests;
* real-broker sequence/rebirth fault tests;
* open local audit sink;
* emergency AI revocation;
* rate and concurrency limits.

# Final assessment

The overall direction should not change.

The Sparkplug design has found the right product boundary:

> **Expose a small, standard plant surface without reducing Source RPC to Sparkplug.**

The AI design has found the right commercial and security boundary:

> **Do not charge for the lock; charge for operating the badge office across a fleet.**

The remaining work is mostly about making those two slogans technically exact: acknowledging that the optional relay really is a private tunnel, mapping Sparkplug lifecycle precisely, refusing to invent caller identity, separating method retry semantics from authorization effects, and ensuring an AI program is constrained both **on the bus and in the process where it runs**.

[1]: https://github.com/source-repo/rpc "GitHub - source-repo/rpc: Source RPC - One programming model for a network of peers · GitHub"
[2]: https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf?utm_source=chatgpt.com "Sparkplug 3.0.0: Sparkplug Specification"
[3]: https://sparkplug.eclipse.org/specification/version/3.0/documents/sparkplug-specification-3.0.0.pdf "Sparkplug 3.0.0: Sparkplug Specification"
[4]: https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html?utm_source=chatgpt.com "MQTT Version 5.0 | OASIS Standard"
[5]: https://sparkplug.eclipse.org/specification/tck-process/?utm_source=chatgpt.com "Eclipse Sparkplug TCK Process Version 1.0"
[6]: https://github.com/source-repo/rpc/blob/main/docs/security-model.md "rpc/docs/security-model.md at main · source-repo/rpc · GitHub"
