# Overall verdict

The developer review is strong and should substantially guide the next revision. I would:

* **accept pushbacks 2, 3, and 4;**
* **accept the durability note fully;**
* **unify the lifecycle vocabulary, with one refinement;**
* **accept that pushback 1 identifies the main architectural fork, but revise its diagnosis and proposed outcome.**

The review correctly recognises that the specification has preserved the best ideas from the extension discussion: cached one-way `props`/`state`, typed asynchronous methods instead of remote property writes, snapshot replacement rather than patch chains, and retained-but-stale values rather than blanking the client. The original discussion’s central motivation was precisely that proxy assignments lack intent, metadata, and an asynchronous failure boundary.  The specification also explicitly refined the weaker ideas from that chat rather than copying them uncritically. 

My disposition is:

| Review point                                      | Verdict                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Central authority versus host-local topology      | Right fork, but incomplete analysis. Use host-authoritative topology by default and an optional coordinated profile for strict guarantees. |
| Explicit invocation handle instead of ambient ALS | Fully agree. This should be the portable normative API.                                                                                    |
| Context resolver should come later                | Agree. Topology and fencing should prove themselves first.                                                                                 |
| Mandatory registered host root                    | Agree. Require one **effective** root, not one explicitly registered application component.                                                |
| `resolving` versus `initializing`                 | Unify the public vocabulary, but retain a reason distinguishing initial load from remount.                                                 |
| Durable `ownerEpoch`                              | Strongly agree. The topology record and epochs must be durable, not merely the audit record.                                               |

---

# 1. The authority pushback is right—but centrality is buying more than cycle prevention

The review says the only thing forcing a central authority is prevention of cycles in the arbitrary logical owner graph. That is not quite complete.

The specification currently gives the authority four globally strong responsibilities:

1. Prevent logical owner cycles.
2. Prevent cycles among cross-host physical roots.
3. Maintain complete reverse indexes such as `ownedComponents`.
4. Reject deletion while any physical or logical dependants exist.

Those guarantees are visible in the physical/logical invariants, authority commit sequence, reverse-index rule, and deletion rules.  

## Physical cycles are also distributed

The review correctly observes that ordinary physical links are host-local, but root-to-root physical links are not. This race is possible:

```text
Host A reads: rootB.parent !== rootA
Host B reads: rootA.parent !== rootB

Host A commits: rootA.parent = rootB
Host B commits: rootB.parent = rootA
```

Each mutation can pass its own preflight check, yet the combined result is a physical cycle.

The same race exists for logical ownership:

```text
A.owner = B
B.owner = A
```

Strict prevention under concurrent commits requires some form of coordination:

* one serialising committer;
* a distributed transaction or lock;
* consensus-backed graph state;
* or a structural restriction that makes cycles impossible.

Because the model deliberately permits arbitrary remote owners and arbitrary root-to-root placement, the last option is unavailable.

## Reverse indexes and strict deletion are also global

In a host-authoritative model, host A owns component A’s outgoing `owner` edge. If A points to component B on host B, host B may not immediately know that it has a new logical dependant.

Consequently, without coordination:

* `ownedComponents` can only be an eventually consistent projection;
* B cannot prove that no remote components still refer to it;
* deletion cannot strictly reject every component with dependants;
* deleting B may temporarily leave dangling or orphaned refs.

That may be perfectly acceptable, but it is a weaker and different contract. The spec cannot remove the authority while retaining all its current invariants.

## The review also slightly overstates the central service

The specification does not require one immortal plant-wide process. It says one logical authority **per administrative topology domain**, initially implementable as a component and later backable by a transactional or leader-elected store. Ordinary component operations continue while it is unavailable; only topology mutations stop. 

So the availability cost is less serious than “the plant depends on a central server” suggests. Nevertheless, making such a service mandatory is still a substantial deployment and persistence requirement for a generic RPC framework.

# Recommended resolution: two explicit consistency profiles

I would not choose simply between “central authority” and “cycles are tolerated.” Instead, distinguish two supported topology profiles.

```ts
export type RpcTopologyConsistency =
  | {
      readonly mode: 'federated';
      readonly cycleHandling: 'detect';
      readonly reverseIndexes: 'eventual';
      readonly deletion: 'tombstone';
    }
  | {
      readonly mode: 'coordinated';
      readonly cycleHandling: 'prevent';
      readonly reverseIndexes: 'authoritative';
      readonly deletion: 'strict';
    };
```

## Federated profile

This should be the default framework profile:

* Each component’s home host is the sole writer of its outgoing `parent` and `owner` links.
* The home host owns and persists the component’s topology revision and epochs.
* Local physical-parent constraints are enforced synchronously.
* Cross-host cycle checks are best-effort before commit.
* Every traversal maintains a visited set and detects actual cycles.
* Reverse indexes are projections, not authoritative records.
* Deletion creates a durable tombstone; remote dependants become explicitly orphaned.
* A background administrative scanner may report and repair invalid topology.

This preserves the essential single-writer property without requiring a new network-wide service.

## Coordinated profile

An application can opt into a domain `TopologyAuthority` when it requires:

* guaranteed acyclicity;
* authoritative reverse indexes;
* strict no-orphan deletion;
* globally serialised structural mutations;
* stronger administrative-domain validation.

Daritas may reasonably choose this profile for a managed plant model because topology changes are rare control-plane operations. Source RPC itself should not make it compulsory for a browser, a small device, or a self-contained industrial host.

## Cycles must be “detected invalid topology,” not normal tolerated topology

The review’s detection-at-resolution proposal is sound, but “tolerated cycle” is too permissive a term. Ordinary RPC execution may continue, but the affected topology axis must become explicitly invalid:

```ts
export type RpcTopologyValidity =
  | {
      readonly status: 'valid';
    }
  | {
      readonly status: 'unresolved';
      readonly at: RpcComponentRef;
    }
  | {
      readonly status: 'cycle';
      readonly path: readonly RpcComponentRef[];
    }
  | {
      readonly status: 'depth-exceeded';
      readonly maxDepth: number;
    };
```

A depth limit of 128 is only a resource guard. It cannot distinguish a cycle from a legitimate but excessively deep hierarchy. The resolver needs a visited set and should report `cycle` separately from `depth-exceeded`.

On a cycle:

* no new logical or physical context becomes `live`;
* the previous complete snapshot may remain available only for diagnostics;
* `require()` fails regardless of the token’s ordinary stale policy;
* topology-dependent safety or authorisation decisions fail closed;
* ordinary methods that do not depend on topology may continue.

Owner fencing itself validates a direct owner generation. A logical cycle does not make an equality check on that direct generation mathematically impossible, but industrial methods that depend on inherited logical policy should normally also require `logicalTopology.status === 'valid'`.

---

# 2. The invocation-context pushback is fully correct

The specification currently makes `currentRpcInvocation()` the visible access pattern and says non-Node runtimes may expose it “where technically possible.” 

That is too weak for Source RPC because a browser is not merely a client. It may host real services. A core service API must not:

* work reliably in Node through `AsyncLocalStorage`;
* appear to exist in browser builds;
* then lose context under asynchronous execution or fail at runtime.

It also conflicts with Source RPC’s otherwise explicit style.

## Do not expose invocation as a mutable component property

A tempting alternative would be:

```ts
this.invocation
```

That is unsafe for a shared component instance when two methods execute concurrently and await different operations. The value could change underneath a suspended handler.

The portable solution is an explicit per-call handle.

## Recommended API

Separate the immutable serialisable metadata from the local execution handle:

```ts
export interface RpcInvocationContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId?: string;

  readonly traceId?: string;
  readonly parentSpanId?: string;

  readonly deadline?: number;
  readonly caller?: RpcComponentRef;
  readonly target: RpcComponentRef;

  readonly principal?: RpcPrincipal;
  readonly baggage: Readonly<Record<string, string>>;

  readonly capturedContext?: RpcCapturedContext;
  readonly ownerFence?: RpcOwnerFence;
}

declare const rpcInvocationBrand: unique symbol;

export interface RpcInvocation {
  readonly [rpcInvocationBrand]: true;

  readonly context: RpcInvocationContext;
  readonly signal: AbortSignal;

  /**
   * Creates a proxy whose child calls inherit correlation,
   * causation, tracing and the remaining deadline.
   */
  call<TContract extends object>(
    target: RpcComponentRef<TContract>,
  ): RpcInvocationProxy<TContract>;
}
```

A method explicitly opts into injection:

```ts
class Pump extends RpcComponent<PumpProps, PumpState> {
  @rpc({ injectInvocation: true })
  async start(
    request: StartRequest,
    invocation: RpcInvocation,
  ): Promise<void> {
    await invocation
      .call(this.auditService)
      .record({
        requestId: invocation.context.requestId,
        operation: 'pump.start',
      });

    await this.drive.start();
    this.setState({ running: true });
  }
}
```

The remote client still sees:

```ts
await pump.start(request);
```

The framework’s proxy type removes a trailing branded invocation parameter:

```ts
type RemoteMethod<TMethod> =
  TMethod extends (
    ...args: [...infer TArgs, RpcInvocation]
  ) => infer TResult
    ? (...args: TArgs) => TResult
    : TMethod;
```

The decorator flag is useful even though the type is branded:

* it makes injection explicit in schema generation;
* it avoids accidental interpretation of an application argument;
* it lets runtime validation reject malformed handler declarations;
* it tells the contract extractor to omit the final parameter from the wire schema.

## Is a final parameter ergonomically acceptable?

Yes. It is a better trade-off than ambient context because:

* only methods needing operational context declare it;
* normal method arguments retain their natural ordering;
* application tests can construct an invocation explicitly;
* browser and Node handlers behave identically;
* nested propagation is visible through `invocation.call(...)`;
* there is no hidden dependency on runtime-specific async-local machinery.

For direct in-process testing, provide:

```ts
const invocation = RpcInvocation.local({
  target: pumpRef,
  principal: testPrincipal,
});
```

or invoke through a lightweight test dispatcher.

`AsyncLocalStorage` can remain optional Node-only sugar, ideally in:

```ts
@source-repo/rpc/node
```

It should not be used in portable examples or required by framework extensions. Core libraries should receive the explicit handle.

---

# 3. The resolver should be implemented after topology and fencing

The review is right here.

The current rollout puts the complete distributed context resolver in Phase 2 and invocation/fencing in Phase 3.  Yet owner fencing only requires:

* a stable component ref;
* the direct owner ref;
* a durable `ownerEpoch`;
* an invocation envelope;
* authorisation;
* a target-side equality check.

It does not need:

* token inheritance;
* remote frontier subscriptions;
* `nearest` or `collect`;
* mount overlays;
* upstream subscription deduplication;
* atomic replacement of a full inherited context.

The resolver is substantial machinery: it watches local topology, subscribes to remote frontiers, deduplicates subscriptions, coalesces updates, replays after reconnect, and publishes complete cached snapshots.  It is sensible to prove the graph and fencing model before introducing that layer.

The spec itself recommends that context normally contain stable references to authoritative components rather than duplicate their changing state.  That further reduces the urgency of a complete resolver.

## Revised implementation sequence

### Phase 0 — shipped prerequisites

Retain the existing Phase 0 list.

### Phase 1 — topology core

* stable component refs;
* effective host root;
* host-authoritative outgoing topology records;
* `parent`, `owner`, versions, and durable epochs;
* CAS mutations;
* topology external store;
* validity status;
* explicit `cycle`, `unresolved`, and `depth-exceeded`;
* optional coordinated-authority adapter.

### Phase 2 — invocation and owner fencing

* explicit `RpcInvocation`;
* correlation and causation;
* deadlines and `AbortSignal`;
* receiver-derived principal;
* durable owner fencing;
* authorisation kept separate from freshness;
* signature coverage and bounded baggage.

The existing specification correctly states that matching `ownerEpoch` proves freshness rather than permission. 

### Phase 3 — queue envelope integration

* task envelope;
* owner fence in queued work;
* task versus worker context separation;
* persisted operational metadata;
* rejection/dead-letter behaviour for stale owner generations.

The envelope separation remains a good adoption of the extension discussion: routing and operational metadata stay outside an opaque business payload. 

### Phase 4 — distributed structural context

* tokens and providers;
* local inheritance;
* remote frontier subscriptions;
* physical/logical resolver;
* atomic logical remount;
* client external stores;
* capture and schema introspection.

## Caveat for EME-351: `latest` needs the resolver

The queue envelope can define both modes immediately:

```ts
type RpcQueuedContext =
  | {
      readonly mode: 'snapshot';
      readonly captured: RpcCapturedContext;
    }
  | {
      readonly mode: 'latest';
      readonly source: RpcComponentRef;
      readonly tokenIds: readonly string[];
    };
```

But `latest` cannot actually resolve token IDs until the structural context resolver exists. The specification describes those two semantics correctly. 

Therefore EME-351 can adopt:

* the discriminated wire shape;
* envelope persistence;
* owner fencing;
* snapshot context supplied explicitly by the producer.

The `latest` execution capability should be marked unavailable until the later context milestone. The model can be fixed early without pretending the implementation already exists.

A useful principle is:

> **Specify the context model now; implement the distributed resolver later.**

---

# 4. The explicit host-root requirement should become an effective-root invariant

The current specification defines a host as having exactly one registered physical root and makes that a physical invariant.  

The review is right that this imposes unnecessary ceremony on:

* a browser hosting one small service;
* a device exposing one oven;
* an application that wants components but does not care about topology;
* existing component users upgrading additively.

Change the invariant to:

> **Every host has exactly one effective host root. An application may register one explicitly; otherwise the runtime synthesises a stable root.**

For example:

```ts
export interface RpcEffectiveHostRoot {
  readonly ref: RpcComponentRef;
  readonly kind: 'explicit' | 'synthetic';
}
```

The synthetic root should:

* use the durable peer identity plus a reserved instance ID such as `$host`;
* remain stable across process restarts;
* be hidden from ordinary discovery by default;
* appear in topology introspection when relevant;
* act as the default parent of otherwise top-level local components;
* carry the host’s cross-host physical-parent edge.

This preserves the structural simplification of one root per host without forcing every application to define a ceremonial component.

An explicit semantic root can still be registered where useful. Small deployments need do nothing.

---

# 5. `initializing` and `resolving` should not both be public lifecycle states

The spec currently defines:

```ts
'resolving' | 'live' | 'stale' | 'missing' | 'closed'
```

and uses `resolving` during an owner remount while retaining the old snapshot under `previous`. 

The review is right to prevent two spellings from escaping into separate public channels. However, initial connection and owner remount are not completely identical:

* initial connection has no previous complete mount;
* owner remount may retain the former complete mount for diagnostics;
* stale means the same mount remains applicable but its authority is temporarily unreachable;
* an old owner mount is no longer applicable, even though its data may still be displayed as history.

I would use one public state:

```ts
export type RpcContextStatus =
  | 'initializing'
  | 'live'
  | 'stale'
  | 'missing'
  | 'invalid'
  | 'closed';

export type RpcContextTransitionReason =
  | 'initial-load'
  | 'owner-remount'
  | 'parent-remount'
  | 'reconnect';

export type RpcContextInvalidReason =
  | 'cycle'
  | 'depth-exceeded'
  | 'invalid-reference';
```

A snapshot can contain:

```ts
interface RpcContextSnapshotBase {
  readonly status: RpcContextStatus;
  readonly transitionReason?: RpcContextTransitionReason;
  readonly invalidReason?: RpcContextInvalidReason;

  /**
   * Previous completed mount for display and diagnostics only.
   * It is not returned by require().
   */
  readonly previous?: RpcResolvedContextEntry<unknown>;
}
```

Internally, `resolving` remains an accurate name for the resolver algorithm. Publicly, `initializing` is the one lifecycle state.

`stale` should retain its narrower and valuable meaning: the current mount is still the same mount, but its freshness can no longer be established.

---

# 6. `ownerEpoch` durability must become a normative requirement

This is the most important smaller note in the review.

The spec defines `ownerEpoch` as changing when the direct owner changes and says the mutation sequence creates a new value. But the sequence explicitly says to persist the **audit record**, not that the complete topology record and epochs must be durably committed before acknowledging the update.  

That is insufficient.

The normative requirement should be:

> A committed topology mutation is acknowledged only after `parent`, `owner`, topology version, `parentEpoch`, and `ownerEpoch` have been atomically stored in the authority’s declared durable topology store.

Additional rules:

1. **Process restart does not change an epoch.**
   The host reloads the exact committed owner and epoch.

2. **Owner mutation always changes the epoch.**
   Reassigning away and later back to the same owner still produces a new generation.

3. **Recovery from lost or rolled-back state rotates epochs.**
   Restoring a backup containing an earlier epoch must not make delayed commands from that former generation valid again.

4. **Fenced methods remain unavailable during uncertain recovery.**
   The target should not accept an owner-fenced command until its durable topology state is loaded and marked live.

5. **Volatile topology must advertise weaker capabilities.**
   A test or ephemeral runtime may support volatile topology, but restart then deliberately invalidates every outstanding fence. That profile should not masquerade as durable industrial fencing.

An opaque random epoch is sufficient for direct equality-based stale-command rejection, provided it is unique and persisted. If epochs are later used as storage-leader fencing tokens, a monotonically increasing durable generation may be preferable.

The same durability treatment should apply to `parentEpoch` and the topology record version, not only `ownerEpoch`.

---

# Recommended outcome for the two main forks

## Central authority versus host-local topology

For the **generic Source RPC framework**:

> Use a host-authoritative topology core with mandatory cycle detection and explicit invalid status. Make coordinated strict topology an optional profile or adapter.

For a **Daritas deployment where the graph is centrally administered or ownership affects control authority**:

> Use the coordinated profile, because strict acyclicity, complete reverse indexes, and no-orphan deletion are worth the rare control-plane mutation dependency.

The framework should expose which guarantees are active:

```ts
export interface RpcTopologyCapabilities {
  readonly authorityScope:
    | 'host'
    | 'administrative-domain';

  readonly cycleGuarantee:
    | 'detected'
    | 'prevented';

  readonly reverseIndex:
    | 'eventual'
    | 'authoritative';

  readonly deletion:
    | 'tombstone'
    | 'strict';

  readonly durability:
    | 'volatile'
    | 'durable';
}
```

That is clearer than silently letting one implementation promise stronger semantics than another.

## Explicit invocation handle versus ALS

> Make the explicit injected `RpcInvocation` parameter normative. Keep ALS, at most, as optional Node-only convenience.

A final injected parameter is acceptable ergonomically when:

* it is opt-in per method;
* it is branded;
* the decorator explicitly declares injection;
* the remote proxy strips it from the caller-visible signature;
* the contract schema excludes it;
* child calls propagate through the handle;
* browser and Node execution are identical.

That is more consistent with Source RPC’s design than an ambient function whose correctness depends on the host runtime.

# Revised adoption record

The proposed adoption move is sound with these refinements:

* **EME-332 / M4 Structure:** stable refs, one effective root, host-owned topology records, topology external store, validity/cycle status, optional coordinated profile.
* **EME-348:** explicit invocation handle, durable `ownerEpoch`, owner-fence wire field, target-side fence validation, separate authorisation.
* **EME-351:** task envelope, owner fence, task/worker separation, snapshot/latest discriminant; actual `latest` resolution remains capability-gated.
* **Late M4 milestone:** context tokens, providers, distributed frontier resolver, atomic remount, explicit capture, React external stores.
* **Cross-cutting:** public `initializing` vocabulary, explicit invalid-topology reasons, durable epoch recovery semantics.

The developer review is therefore not merely broadly correct—it catches the right simplifications. Its only material weakness is describing central authority as if global owner-cycle prevention were its sole justification. Once physical-root races, reverse indexes, and deletion guarantees are included, the real choice becomes much clearer:

> **Federated topology gives availability and additivity; coordinated topology gives global invariants. Source RPC should describe both honestly rather than forcing either one on every deployment.**
