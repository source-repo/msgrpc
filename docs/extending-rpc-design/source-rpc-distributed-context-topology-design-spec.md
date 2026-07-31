# Source RPC Distributed Topology, Context, and Shared State

**Status:** Proposed design specification  
**Target:** Source RPC vNext, after the observable `RpcComponent<P, S>` foundation  
**Primary transports:** Socket.IO and MQTT 5, with identical framework semantics  
**Audience:** Source RPC maintainers, application developers, reviewers, and future non-TypeScript implementers

## 1. Executive decision

Source RPC should add a distributed, React-inspired context layer built on the component structure that already exists:

- every component has a **parent**, meaning its physical location;
- every component has an **owner**, meaning its logical location;
- a component's owner may be any component in the network;
- a host's physical root may have another host root anywhere in the network as its parent;
- `props`, `state`, `context`, and topology remain separate concepts;
- context is inherited through exactly one declared topology axis at a time;
- shared mutable state remains authoritative in a component rather than becoming transparent distributed memory;
- invocation context is explicit and separate from inherited structural context;
- queued work captures context explicitly and never inherits whatever context happens to exist when it is finally processed.

The central rule is:

> **State belongs to an authority. Context is an immutable, versioned view inherited through one explicit topology. Calls express intent. References locate authorities.**

The logical owner chain is the normal React-like context chain. The physical parent chain provides a separate environmental context. Reassigning `owner` is therefore a distributed logical remount: the component remains physically where it is, but atomically enters a new logical scope.

## 2. Source basis and explicit disposition of the extension chat

This specification deliberately incorporates the attached extension discussion rather than treating it as background only.

### 2.1 Adopted ideas

The following ideas are adopted directly:

1. **Raw remote properties are unsuitable.** A proxy assignment has no clear command intent, metadata, or asynchronous error boundary. Reads of structured `props` and `state` should instead be synchronous reads from a local cache, while writes remain explicit asynchronous methods. **[Extension chat, pp. 1–3]**
2. **Props and state use one-way flow.** `props` are host-controlled and read-only to the component; `state` is published by the component and read by remote clients. State changes propagate as observable snapshots. **[pp. 1–3]**
3. **Commands, events, and queued work are distinct.** A command asks a target to do something and reports an outcome; an event says that something happened; a work queue asks any suitable worker to process a task. **[pp. 4–5]**
4. **A local component mailbox and a distributed work queue are different things.** The mailbox protects one instance from unwanted interleaving. A work queue is a separate coordinator/resource serving competing consumers. **[pp. 7–9]**
5. **Transport-independent fallback semantics matter.** User-space RPC request/reply and long-polling can behave identically over Socket.IO and MQTT, while transport-specific optimisations remain optional. **[pp. 17–23]**
6. **Handler registration is a useful inversion-of-control shape.** Subscriptions and consumers should register callbacks or external stores rather than expose transport-specific polling loops to application code. **[pp. 26–29]**
7. **Backpressure exists at both producer and consumer boundaries.** Framework metadata and subscriptions must be bounded; slow consumers must not create unbounded memory growth. **[pp. 30–35]**
8. **Routing metadata belongs outside opaque business payloads.** The envelope pattern allows routing, context, deadlines, and other operational metadata to be processed without deserialising application data. **[pp. 46–48]**
9. **The protocol should be language-independent.** A Go or Rust implementation should be able to route and enforce the protocol without depending on TypeScript object semantics. **[pp. 49–50]**

### 2.2 Refinements made by this specification

The following chat ideas are retained in spirit but narrowed for correctness:

- The chat groups configuration and desired state together under `props`. This specification restricts `props` to host-controlled structural configuration. Mutable desired state belongs in component `state` or an authoritative state component and is changed through typed methods.
- The chat proposes a generic `dispatchCommand(command: string, payload: any)`. Source RPC should retain typed class methods because they preserve TypeScript contracts, method semantics, validation, authorisation, deadlines, and introspection.
- The chat sometimes calls every component an Actor. Source RPC components may be actor-like when their command execution is serialised, but the framework should describe them more precisely as **long-lived observable service objects**.
- The chat proposes a generic industrial `ControlValue<T>` in the base framework. Quality, source timestamp, server timestamp, and status-code models differ between industries and protocols. Such value types belong in domain packages, not in generic Source RPC core.
- The chat uses “zero-copy” broadly. This specification promises **opaque payload transport with no framework-level deserialisation**, not end-to-end zero-copy, because runtimes, codecs, sockets, brokers, and stores may still copy buffers.
- The chat occasionally attributes stronger queue guarantees to brokers than can be portably guaranteed. Queue processing remains explicitly at least once unless a durable idempotency mechanism says otherwise.

## 3. Goals

The update shall:

1. Represent a distributed physical hierarchy and an independent distributed logical ownership hierarchy.
2. Preserve stable component identity when either hierarchy changes.
3. Provide React-like inherited context without pretending that the network is shared memory.
4. Keep physical and logical context separate and unambiguous.
5. Make context synchronously readable from a local immutable cache.
6. Include provenance, freshness, epochs, and revisions in every resolved context value.
7. Make owner changes atomic from the consumer's perspective.
8. Support Socket.IO and MQTT with identical observable semantics.
9. Expose an external-store interface suitable for React `useSyncExternalStore`, without adding a React dependency to core.
10. Carry per-invocation identity, tracing, causation, deadlines, and explicitly captured context.
11. Define how queued work captures context and owner fencing.
12. Keep all new functionality additive for ordinary `client.proxy()` users.
13. Specify a protocol that can later be implemented in Rust, Go, C#, or another language.

## 4. Non-goals

The update shall not:

- create transparent distributed shared memory;
- provide automatic multi-master conflict resolution;
- implement Raft, a replicated database, or a general-purpose broker;
- make an `RpcRef` an authorisation capability;
- copy every context value into every component eagerly;
- send high-rate telemetry through context;
- infer context by mixing the physical and logical hierarchies;
- automatically propagate all ambient context through every RPC call;
- make topology paths part of component identity;
- expose raw MQTT topics or Socket.IO implementation details in the context API;
- integrate a distributed work queue into every component's base class.

## 5. Terminology

### Component

A long-lived RPC instance with typed methods, optional events, cached `props`, and cached observable `state`.

### Host

A Source RPC runtime that owns one or more local components and has exactly one registered physical root component.

### Parent

The component's **physical parent**. The public field remains named `parent` because this is the terminology already used in the component structure.

### Owner

The component's **logical parent**. The public field remains named `owner`. By default this relationship defines logical placement and context inheritance, not authorisation.

### Host root

The top physical component of a host. It may have no parent or another host root anywhere in the network as its parent.

### Structural context

Read-only ambient data resolved from either the physical parent chain or the logical owner chain.

### Invocation context

Immutable metadata belonging to one RPC call, event delivery, or queue attempt: request identity, correlation, causation, deadline, authenticated principal, tracing, and explicitly captured context.

### Shared authoritative state

Mutable state owned by one component or an external transactional store and observed by many readers.

### Mount epoch

An opaque identifier representing one complete resolved context chain. It changes whenever the effective chain is replaced.

### Fencing epoch

An opaque identifier that invalidates delayed commands from an earlier ownership generation.

## 6. Component identity and references

Component identity must not depend on its physical or logical path. Reparenting or changing owner must not invalidate references.

The exact field names may be adapted to the current Source RPC identity model, but the normative information is:

```ts
export interface RpcComponentRef<
  TContract extends object = object,
> {
  /** Stable Source RPC peer/host identity. */
  readonly peerId: string;

  /** Stable instance identity within that peer. */
  readonly instanceId: string;

  /** Optional runtime contract identifier. */
  readonly contractId?: string;

  /** TypeScript-only phantom type. */
  readonly __contract?: TContract;
}
```

An `RpcComponentRef` is:

- serialisable;
- stable across reconnects;
- resolvable through normal Source RPC discovery/routing;
- not a secret;
- not proof of permission to access the component.

Physical and logical paths are derived display data only. They may be cached and indexed, but they are never wire addresses or durable foreign keys.

## 7. Topology model

### 7.1 Topology snapshot

```ts
export interface RpcVersion {
  readonly epoch: string;
  readonly revision: number;
}

export interface RpcComponentTopology {
  readonly component: RpcComponentRef;
  readonly hostRoot: RpcComponentRef;

  /** Physical location. */
  readonly parent: RpcComponentRef | null;

  /** Logical location. */
  readonly owner: RpcComponentRef | null;

  /** Changes on every committed topology mutation for this component. */
  readonly version: RpcVersion;

  /** Changes whenever the direct physical parent changes. */
  readonly parentEpoch: string;

  /** Changes whenever the direct logical owner changes. */
  readonly ownerEpoch: string;
}
```

### 7.2 Physical hierarchy invariants

1. Every visible component belongs to exactly one host.
2. Every host has exactly one registered host root.
3. Every non-root component must have a parent on the same host.
4. A host root may have:
   - `parent === null`; or
   - another host root on any Source RPC host as its parent.
5. A non-root component may not have a remote physical parent.
6. The physical graph must be acyclic.
7. A component may not be its own parent.
8. Reparenting does not change component identity.

The root-to-root rule makes the distributed physical hierarchy understandable and limits cross-host subscription fan-out while still allowing complete plants, areas, machines, gateways, and remote installations to form one physical tree or forest.

### 7.3 Logical hierarchy invariants

1. `owner` may reference any component in the network.
2. `owner` may be `null`.
3. A component may not own itself.
4. The logical owner graph must be acyclic.
5. Reassigning owner does not change component identity or physical placement.
6. Parent and owner may reference the same component.
7. A missing owner never falls back implicitly to the physical parent.

The owner chain is followed as:

```text
component -> owner -> owner's owner -> ... -> null
```

### 7.4 Independent graphs

The physical and logical graphs are validated independently. Context resolution never jumps from one graph to the other, so a cross-axis cycle such as “A physically contains B while B logically owns A” is not itself a traversal cycle.

### 7.5 Derived child indexes

`physicalChildren` and `ownedComponents` are derived indexes maintained by the topology authority. They are not independently authoritative fields. This prevents two-sided edge records from diverging.

## 8. Topology authority and mutation protocol

Topology is control-plane state. Ordinary component methods and state updates must continue while the topology authority is temporarily unavailable, but structural changes must not proceed without an authoritative commit.

### 8.1 Logical single writer

Each administrative topology domain has one logical `TopologyAuthority`. It may be implemented initially as one Source RPC component and later backed by a transactional or leader-elected store. The protocol depends on single-writer semantics, not on one process forever.

### 8.2 API

```ts
export interface RpcTopologyPatch {
  /** `undefined` means unchanged. */
  readonly parent?: RpcComponentRef | null;

  /** `undefined` means unchanged. */
  readonly owner?: RpcComponentRef | null;
}

export interface RpcTopologyMutationOptions {
  readonly expectedVersion: RpcVersion;
  readonly reason?: string;
}

export interface RpcTopologyService {
  get(
    component: RpcComponentRef,
  ): Promise<RpcComponentTopology>;

  update(
    component: RpcComponentRef,
    patch: RpcTopologyPatch,
    options: RpcTopologyMutationOptions,
  ): Promise<RpcComponentTopology>;

  watch(
    component: RpcComponentRef,
  ): RpcExternalStore<RpcComponentTopology>;
}
```

Both links may be changed in one atomic `update()` operation. Separate convenience methods may call the same transaction internally.

### 8.3 Commit sequence

For every mutation, the authority must:

1. authenticate and authorise the caller;
2. resolve the target and new references;
3. compare `expectedVersion` with the current target version;
4. enforce the host-root physical-parent rule;
5. enforce administrative-domain restrictions;
6. run a cycle check on each changed graph;
7. atomically commit the outgoing edge or edges;
8. update reverse indexes;
9. increment the target topology revision;
10. create new `parentEpoch` and/or `ownerEpoch` values for changed links;
11. persist an audit record;
12. publish a complete topology snapshot.

### 8.4 Errors

```ts
export class RpcTopologyConflictError extends Error {}
export class RpcTopologyCycleError extends Error {}
export class RpcInvalidPhysicalParentError extends Error {}
export class RpcTopologyForbiddenError extends Error {}
export class RpcTopologyReferenceError extends Error {}
```

### 8.5 Deletion

Deletion must never silently cascade through the distributed graph.

- A component with physical children cannot be deleted until they are reparented or explicitly removed in the same administrative transaction.
- A component with logical dependants cannot be deleted until they are reassigned or explicitly made unowned.
- Force deletion may exist as an administrative operation, but it must emit explicit orphaning events and audit records.

## 9. Structural context

### 9.1 Two explicit axes

Every context token declares one axis:

```ts
export type RpcContextAxis =
  | 'physical'
  | 'logical';
```

Examples:

- physical: site identity, cabinet, network zone, time zone, safety classification, engineering-unit conventions;
- logical: batch, recipe, work order, operating campaign, maintenance operation, orchestration policy.

There is no “logical first, then physical” search. A token belongs to exactly one axis.

### 9.2 Context definitions

```ts
export type RpcContextResolution =
  | 'nearest'
  | 'collect';

export type RpcContextStalePolicy =
  | 'allow'
  | 'reject';

export type RpcContextCapturePolicy =
  | 'never'
  | 'explicit';

export interface RpcContextDefinition<
  TValue,
  TResolution extends RpcContextResolution = 'nearest',
> {
  /** Globally stable, namespaced identifier. */
  readonly id: string;

  readonly schemaVersion: string;
  readonly axis: RpcContextAxis;
  readonly resolution?: TResolution;
  readonly stalePolicy?: RpcContextStalePolicy;
  readonly capture?: RpcContextCapturePolicy;

  /** Local-only values are never serialised to remote subscribers. */
  readonly exposure?: 'local' | 'remote';

  /** Configurable upper bound; checked after serialisation. */
  readonly maxSerializedBytes?: number;

  /** Source RPC's schema abstraction or generated JSON Schema. */
  readonly schema?: unknown;
}

export interface RpcContextToken<
  TValue,
  TResolution extends RpcContextResolution = 'nearest',
> extends RpcContextDefinition<TValue, TResolution> {
  readonly __value?: TValue;
}

export function defineRpcContext<
  TValue,
  TResolution extends RpcContextResolution = 'nearest',
>(
  definition: RpcContextDefinition<TValue, TResolution>,
): RpcContextToken<TValue, TResolution>;
```

Example:

```ts
export interface PlantContextValue {
  readonly plantId: string;
  readonly timezone: string;
  readonly pressureUnit: 'bar' | 'kPa';
}

export const PlantContext =
  defineRpcContext<PlantContextValue>({
    id: 'example.plant',
    schemaVersion: '1',
    axis: 'physical',
    resolution: 'nearest',
    stalePolicy: 'allow',
    capture: 'explicit',
    exposure: 'remote',
  });

export interface WorkOrderContextValue {
  readonly workOrderId: string;
  readonly recipeRevision: string;
}

export const WorkOrderContext =
  defineRpcContext<WorkOrderContextValue>({
    id: 'example.work-order',
    schemaVersion: '1',
    axis: 'logical',
    resolution: 'nearest',
    stalePolicy: 'reject',
    capture: 'explicit',
    exposure: 'remote',
  });
```

### 9.3 Providers

A component may provide at most one value for a given token. The provider owns that value and may update or remove it locally.

```ts
export interface RpcContextProviderHandle<T> {
  readonly version: RpcVersion;

  set(value: DeepReadonly<T>): void;
  clear(): void;
}

abstract class RpcComponent<P, S> {
  protected provideContext<T>(
    token: RpcContextToken<T>,
    initialValue: DeepReadonly<T>,
  ): RpcContextProviderHandle<T>;
}
```

Remote callers cannot assign context values. They invoke typed component methods, and the authoritative component decides whether to update its provided context.

Example:

```ts
class BatchComponent extends RpcComponent<
  BatchProps,
  BatchState
> {
  readonly #workOrder = this.provideContext(
    WorkOrderContext,
    {
      workOrderId: this.props.workOrderId,
      recipeRevision: this.props.recipeRevision,
    },
  );

  async changeRecipe(
    recipeRevision: string,
  ): Promise<void> {
    await this.validateRecipe(recipeRevision);

    this.#workOrder.set({
      workOrderId: this.props.workOrderId,
      recipeRevision,
    });
  }
}
```

### 9.4 Resolution rules

For a token with `resolution: 'nearest'`:

1. inspect the target component itself;
2. if no provider exists, follow the token's selected axis;
3. stop at the first provider;
4. stop with `missing` when the chain ends cleanly;
5. never inspect the other axis.

For `resolution: 'collect'`:

- collect all providers from nearest to farthest;
- preserve provider identity and version for each entry;
- do not merge values automatically;
- application code may apply a domain-specific reduction locally.

Arbitrary framework-level merge functions are intentionally excluded from v1 because they complicate determinism, compatibility, and cross-language implementations.

## 10. Context snapshots, provenance, and freshness

### 10.1 Status model

```ts
export type RpcContextStatus =
  | 'resolving'
  | 'live'
  | 'stale'
  | 'missing'
  | 'closed';
```

- `resolving`: topology changed and a complete new chain has not yet been established;
- `live`: the resolved chain and provider are current;
- `stale`: the last complete value is retained, but one or more upstream authorities are unreachable;
- `missing`: the complete current chain is known and no provider exists;
- `closed`: the local component/proxy has been disposed.

### 10.2 Resolved entries

```ts
export interface RpcResolvedContextEntry<T> {
  readonly value: DeepReadonly<T>;
  readonly provider: RpcComponentRef;
  readonly providerVersion: RpcVersion;
}

export interface RpcContextSnapshotBase {
  readonly tokenId: string;
  readonly axis: RpcContextAxis;
  readonly status: RpcContextStatus;

  /** Identifies one complete effective chain. */
  readonly mountEpoch: string;

  /** Topology snapshot used to resolve this value. */
  readonly topologyVersion: RpcVersion;

  readonly resolvedAt: number;
  readonly staleSince?: number;
}

export interface RpcNearestContextSnapshot<T>
  extends RpcContextSnapshotBase {
  readonly entry?: RpcResolvedContextEntry<T>;

  /** Last complete old mount while a new mount is resolving. */
  readonly previous?: RpcResolvedContextEntry<T>;
}

export interface RpcCollectedContextSnapshot<T>
  extends RpcContextSnapshotBase {
  readonly entries: readonly RpcResolvedContextEntry<T>[];
  readonly previous?: readonly RpcResolvedContextEntry<T>[];
}
```

### 10.3 Atomic owner remount

Changing owner must never produce a mixture of old and new logical context.

The observable sequence is:

1. the topology snapshot changes and `ownerEpoch` is replaced;
2. every affected logical-context store moves to `resolving`;
3. the old complete value may be exposed only under `previous`;
4. the resolver establishes the complete new owner chain;
5. one full snapshot replaces all logical values for the new `mountEpoch`;
6. late frames from the old mount are discarded.

A consumer must never observe, for example, the tenant from the old owner and the recipe from the new owner in the same effective snapshot.

### 10.4 Stale policy

`read()` always returns the full snapshot and therefore permits diagnostics and UI display.

`require()` applies the token's policy:

- `allow`: return the last complete value when `live` or `stale`;
- `reject`: return only when `live`; otherwise throw an `RpcContextUnavailableError`.

Security or safety decisions should normally use `reject` and fail closed.

## 11. Component and client API

### 11.1 Component-side API

```ts
export interface RpcContextReader {
  read<
    T,
    R extends RpcContextResolution,
  >(
    token: RpcContextToken<T, R>,
  ): R extends 'collect'
    ? RpcCollectedContextSnapshot<T>
    : RpcNearestContextSnapshot<T>;

  require<T>(
    token: RpcContextToken<T, 'nearest'>,
    options?: {
      readonly requireLive?: boolean;
    },
  ): DeepReadonly<T>;

  store<
    T,
    R extends RpcContextResolution,
  >(
    token: RpcContextToken<T, R>,
  ): RpcExternalStore<
    R extends 'collect'
      ? RpcCollectedContextSnapshot<T>
      : RpcNearestContextSnapshot<T>
  >;

  capture(
    tokens: readonly RpcContextToken<unknown>[],
    options?: RpcContextCaptureOptions,
  ): RpcCapturedContext;
}

abstract class RpcComponent<P, S> {
  readonly props: DeepReadonly<P>;
  readonly state: DeepReadonly<S>;
  readonly topology: RpcExternalStore<RpcComponentTopology>;
  readonly context: RpcContextReader;

  protected setState(update: Partial<S>): void;
  protected provideContext<T>(
    token: RpcContextToken<T>,
    initialValue: DeepReadonly<T>,
  ): RpcContextProviderHandle<T>;
}
```

### 11.2 Client-side proxy

```ts
const pump = await client.component<PumpComponent>(
  'pump-7',
  'edge-gateway',
);

console.log(pump.props.maximumPressureBar);
console.log(pump.state.actualPressureBar);
console.log(pump.topology.getSnapshot().parent);
console.log(pump.topology.getSnapshot().owner);

const workOrder =
  pump.context.read(WorkOrderContext);

if (workOrder.status === 'live') {
  console.log(workOrder.entry?.value.workOrderId);
}
```

### 11.3 External store

```ts
export interface RpcExternalStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
```

This is intentionally compatible with React's `useSyncExternalStore`:

```ts
const store = pump.context.store(WorkOrderContext);

const snapshot = useSyncExternalStore(
  store.subscribe,
  store.getSnapshot,
  store.getSnapshot,
);
```

Core has no React dependency. A small optional `@source-repo/rpc/react` adapter may expose `useRpcComponentState`, `useRpcTopology`, and `useRpcContext`.

## 12. Distributed context resolver

Each host runs one resolver responsible for local components.

### 12.1 Responsibilities

The resolver shall:

- watch local component topology;
- maintain local provider tables;
- subscribe to remote parent/owner frontiers;
- resolve nearest or collected values;
- cache immutable snapshots;
- share identical upstream subscriptions among local consumers;
- coalesce redundant updates;
- mark values stale on upstream loss;
- replay subscriptions after reconnect;
- discard old epochs and out-of-order revisions;
- publish full snapshots rather than fragile patch chains.

### 12.2 Incremental resolution

For local descendants, resolution is incremental:

```text
child effective physical context
    = child local providers
      overlaid on parent effective physical context

child effective logical context
    = child local providers
      overlaid on owner effective logical context
```

“Overlaid” here means nearest-provider selection per token, not object merging.

### 12.3 Cross-host physical roots

When host root `B` has remote host root `A` as parent, host `B` subscribes once to the physical context frontier of `A`. All local descendants of `B` reuse that upstream subscription.

### 12.4 Arbitrary remote owners

When local components have remote owners, subscriptions are keyed by:

```text
(remote component ref, token set, authorisation identity)
```

Twenty local components with the same remote owner and access policy should normally share one upstream subscription.

## 13. Ownership semantics and fencing

The base meaning of `owner` is logical placement. It does not automatically grant command authority.

Applications may opt into owner-authorised methods. In that profile, an owner change must fence delayed commands from the previous owner generation.

### 13.1 Owner fence

```ts
export interface RpcOwnerFence {
  readonly component: RpcComponentRef;
  readonly owner: RpcComponentRef | null;
  readonly ownerEpoch: string;
}
```

A call made under owner authority carries the target's observed `ownerEpoch`. The target rejects it when the current epoch differs.

```ts
export class RpcOwnershipChangedError extends Error {}
```

This prevents an old owner, a delayed MQTT message, a retried queue task, or a partitioned coordinator from continuing to control the component after reassignment.

### 13.2 Authorisation remains separate

Matching `ownerEpoch` proves freshness, not permission. A normal authorisation hook must still verify the caller or a delegated capability.

## 14. Shared mutable state

### 14.1 No generic network-wide mutable dictionary

The framework must not provide an API such as:

```ts
sharedState.set('plantMode', 'maintenance');
```

Such an API would hide authority, concurrent writers, durability, split-brain behavior, retries, and conflict resolution.

### 14.2 Preferred model: authoritative state component

Shared state is represented by a normal component whose state is observed by many readers and changed through typed methods.

```ts
interface PlantModeState {
  readonly mode:
    | 'production'
    | 'maintenance'
    | 'shutdown';

  readonly revision: number;
}

class PlantModeComponent extends RpcComponent<
  Record<string, never>,
  PlantModeState
> {
  async setMode(
    mode: PlantModeState['mode'],
    expectedRevision: number,
  ): Promise<void> {
    if (this.state.revision !== expectedRevision) {
      throw new RpcStateConflictError();
    }

    await this.applyMode(mode);

    this.setState({
      mode,
      revision: this.state.revision + 1,
    });
  }
}
```

Context should normally provide a reference to this authority, not duplicate its entire changing state:

```ts
export const PlantModeContext =
  defineRpcContext<
    RpcComponentRef<PlantModeComponent>
  >({
    id: 'example.plant-mode-service',
    schemaVersion: '1',
    axis: 'physical',
    capture: 'explicit',
  });
```

### 14.3 Consistency model

The default is:

```text
many callers -> one state authority -> many immutable replicas
```

This provides:

- one serial action order;
- monotonic revisions within one component epoch;
- explicit stale status;
- optimistic concurrency checks;
- durable idempotency where configured;
- straightforward audit records.

### 14.4 High availability

A stateful component must not be naively deployed as several independent in-memory replicas behind an MQTT shared subscription.

High availability requires one of:

- an active leader and fencing token;
- a transactional shared store with compare-and-set;
- a consensus-backed external service;
- an application-specific commutative merge model.

Source RPC may expose a persistence adapter, but it does not implement consensus in this update.

### 14.5 Multi-writer and CRDT state

Offline multi-writer state is deferred to a specialised extension. It may later suit counters, tags, presence, or append-only observations. It must not be the default for setpoints, safety overrides, recipes, or ownership.

## 15. Invocation context

Structural context belongs to a component. Invocation context belongs to one operation.

```ts
export interface RpcPrincipal {
  readonly subject: string;
  readonly tenantId?: string;
  readonly roles?: readonly string[];
}

export interface RpcInvocationContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId?: string;

  readonly traceId?: string;
  readonly parentSpanId?: string;

  readonly deadline?: number;

  readonly caller?: RpcComponentRef;
  readonly target: RpcComponentRef;

  /** Derived by trusted authentication, not accepted blindly. */
  readonly principal?: RpcPrincipal;

  readonly baggage: Readonly<Record<string, string>>;
  readonly capturedContext?: RpcCapturedContext;
  readonly ownerFence?: RpcOwnerFence;
}
```

### 15.1 Propagation

A child RPC call inherits by default:

- `correlationId`;
- tracing identifiers;
- the minimum remaining deadline;
- `causationId` set to the parent's `requestId`;
- explicitly allow-listed baggage.

It receives a new `requestId`.

Structural context is not inherited automatically by the callee. The callee always retains its own physical and logical context.

### 15.2 Runtime access

Node.js handlers may use `AsyncLocalStorage`:

```ts
export function currentRpcInvocation():
  RpcInvocationContext;
```

Other runtimes may use an internal lexical execution scope while exposing the same API where technically possible.

### 15.3 Principal forwarding

The receiver derives `principal` from the authenticated connection or verified delegated credentials. A caller-provided object named `principal` is untrusted baggage and must never replace receiver-derived identity.

## 16. Explicit context capture

A caller may deliberately attach selected structural context to an invocation.

```ts
export interface RpcContextCaptureOptions {
  readonly mode?: 'snapshot';
}

export interface RpcCapturedContextEntry {
  readonly tokenId: string;
  readonly schemaVersion: string;
  readonly axis: RpcContextAxis;
  readonly provider: RpcComponentRef;
  readonly providerVersion: RpcVersion;
  readonly mountEpoch: string;
  readonly value: unknown;
}

export interface RpcCapturedContext {
  readonly capturedAt: number;
  readonly source: RpcComponentRef;
  readonly entries: readonly RpcCapturedContextEntry[];
}
```

Example:

```ts
await analyzer
  .$with({
    context: this.context.capture([
      WorkOrderContext,
      PlantContext,
    ]),
  })
  .analyze(sample);
```

The callee sees both:

- its own current `component.context`;
- the immutable `invocation.capturedContext` chosen by the caller.

Capture rules:

- only tokens with `capture: 'explicit'` may be captured;
- local-only tokens may not be captured remotely;
- captured values are schema-validated and size-bounded;
- captured context is included in frame signatures;
- captured values are evidence/audit data, not authorisation by themselves.

## 17. Queue integration

The attached chat correctly separates a component's local mailbox from a distributed work queue **[pp. 7–9]**. That distinction remains normative.

### 17.1 Worker context versus task context

A worker handling a task has two independent contexts:

```ts
export interface RpcWorkHandlerContext {
  /** Context captured when the task was submitted. */
  readonly taskContext?: RpcQueuedContext;

  /** The worker component's current inherited context. */
  readonly workerContext: RpcContextReader;

  readonly signal: AbortSignal;
  readonly attempt: number;
}
```

The task never silently inherits the worker's batch, tenant, or owner identity.

### 17.2 Snapshot versus latest semantics

A task submitted under recipe revision 12 may execute after revision 13 exists. Both behaviors are valid, but they must be explicit.

```ts
export type RpcQueuedContext =
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

- `snapshot`: process under the context that existed at enqueue time;
- `latest`: resolve the named tokens from the source component when execution starts.

Critical tasks may additionally carry an owner fence. If ownership changed, the task is rejected or dead-lettered according to queue policy rather than executed under stale authority.

### 17.3 Envelope separation

The extension chat's envelope pattern **[pp. 46–48]** is adopted:

```ts
export interface RpcTaskEnvelope<TPayload> {
  readonly taskId: string;
  readonly routingKey?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly context?: RpcQueuedContext;
  readonly ownerFence?: RpcOwnerFence;
  readonly payload: TPayload;
}
```

Routing, context, task identity, deadlines, and retry metadata remain outside an opaque `Uint8Array` payload. Source RPC need not deserialize MessagePack, FlatBuffers, Protobuf, or another application encoding merely to route the task.

### 17.4 Backpressure

Context metadata is subject to the same producer/consumer boundary principle discussed on chat pages 30–35:

- captured context has a strict aggregate byte limit;
- header counts and lengths are bounded;
- the queue may reject an oversized task before accepting it;
- slow workers do not cause unbounded context copies;
- spoolers persist the envelope and payload together so meaning is not lost during recovery.

## 18. Internal protocol

The feature should be implemented using hidden Source RPC protocol components rather than transport-specific application APIs.

### 18.1 Protocol components

Suggested internal contracts:

```ts
interface RpcTopologyProtocol {
  get(
    component: RpcComponentRef,
  ): Promise<RpcComponentTopology>;

  update(
    component: RpcComponentRef,
    patch: RpcTopologyPatch,
    options: RpcTopologyMutationOptions,
  ): Promise<RpcComponentTopology>;

  subscribe(
    request: RpcTopologySubscribeRequest,
  ): Promise<RpcTopologySubscriptionStart>;

  unsubscribe(subscriptionId: string): Promise<void>;
}

interface RpcContextProtocol {
  subscribe(
    request: RpcContextSubscribeRequest,
  ): Promise<RpcContextSubscriptionStart>;

  unsubscribe(subscriptionId: string): Promise<void>;
}
```

### 18.2 Race-free initial subscription

The subscription RPC must register the subscriber before it captures the initial snapshot. Its response contains:

- `subscriptionId`;
- initial complete snapshot;
- initial sequence number.

Subsequent events have strictly larger sequence numbers. This avoids the common “fetch, then subscribe” race.

### 18.3 Full snapshots

Topology and context updates use full immutable snapshots rather than patches. Full snapshots make duplicate MQTT QoS 1 deliveries and reconnect replay harmless and avoid broken patch chains.

### 18.4 Ordering

Clients discard:

- a sequence number not greater than the last accepted sequence for that subscription;
- an older revision within the same epoch;
- any frame belonging to an obsolete mount epoch;
- any frame with an unsupported protocol version.

### 18.5 Reconnect

After reconnect:

1. the client re-establishes subscriptions;
2. the server returns current full snapshots;
3. local status changes from `stale` or `resolving` to `live`/`missing` only after those snapshots are accepted.

### 18.6 Transport mapping

The observable protocol is identical over Socket.IO and MQTT.

MQTT 5 properties may carry correlation data, response topics, expiry, and selected signed metadata as an optimisation. Socket.IO carries the same logical fields in its framework envelope. Neither transport changes context semantics.

## 19. Protocol security

### 19.1 Context is data, not authority

A context value, captured context entry, or `RpcComponentRef` does not grant access. Normal authentication and authorisation remain mandatory.

### 19.2 Topology mutation

Topology mutation requires a dedicated authorisation decision. Default policy should reject:

- cross-tenant parent or owner links;
- links outside the caller's administrative domain;
- browser-originated topology mutations unless explicitly enabled;
- changes lacking an expected version;
- changes without an auditable principal.

### 19.3 Context exposure

A remote context subscription is authorised using:

- caller identity;
- target component;
- token ID;
- provider exposure policy;
- tenant/domain boundaries.

Sensitive values such as credentials, signing keys, database URLs, or internal network secrets must use `exposure: 'local'` and never appear in remote snapshots.

### 19.4 Signing

For signed MQTT frames, signatures must cover all authoritative context fields, including:

- target and source references;
- token IDs and schema versions;
- provider references and versions;
- topology/mount epochs;
- invocation IDs, deadline, baggage, and owner fence;
- payload digest or payload bytes according to the existing frame specification.

### 19.5 Resource limits

The implementation must enforce limits before allocation wherever possible:

- maximum topology depth;
- maximum context tokens per subscription;
- maximum serialised value size;
- maximum captured-context size;
- maximum header count and header length;
- maximum simultaneous subscriptions per peer;
- maximum topology mutations per unit time.

## 20. Performance and backpressure

Context is for low-frequency ambient information, not telemetry streams.

Suitable context:

- plant/site identity;
- work order and recipe references;
- time zone and engineering units;
- policy and feature flags;
- service/store references;
- current maintenance or orchestration scope.

Unsuitable context:

- vibration waveforms;
- rapid process values;
- unbounded log data;
- event history;
- child-state aggregation.

### 20.1 Latest-wins coalescing

When several provider updates are pending for the same token and subscriber, the resolver may replace unsent older snapshots with the newest full snapshot. Context is state-like, so preserving every intermediate revision is not required unless the application also emits a separate audit event.

### 20.2 Slow subscribers

Each `(subscription, token)` channel keeps at most one pending full snapshot. Slow subscribers become stale or disconnected according to transport policy; they do not cause an unbounded update queue.

### 20.3 Suggested configurable defaults

Initial conservative defaults may be:

- 16 KiB per context value;
- 64 tokens per subscription;
- 64 KiB captured context per invocation/task;
- 256 KiB aggregate context snapshot;
- topology depth 128;
- one pending snapshot per token/subscriber.

These are framework defaults, not protocol maxima, and must be configurable downward for constrained devices.

## 21. Schema, compatibility, and introspection

### 21.1 Stable token identity

Compatibility is based on:

- token `id`;
- `schemaVersion`;
- axis;
- resolution mode;
- serialisation schema.

Changing physical to logical axis or nearest to collect is a breaking token change and requires a new ID or major schema version.

### 21.2 Component metadata

Static decorators or class metadata may optionally declare expected providers and consumers:

```ts
@providesContext(PlantContext)
@consumesContext(WorkOrderContext, {
  required: true,
})
class PumpComponent extends RpcComponent<
  PumpProps,
  PumpState
> {}
```

Runtime dynamic access remains possible, but declarations improve generated schema, documentation, deployment validation, and the graph viewer.

### 21.3 Introspection

Introspection should expose, subject to authorisation:

- current parent and owner refs;
- topology version and epochs;
- context tokens provided locally;
- declared consumed tokens;
- current resolution status and provider refs;
- value schemas, but not necessarily sensitive values;
- owner-authority requirements on methods.

## 22. Implementation layout

Suggested source organisation:

```text
src/
  Component/
    RpcComponent.ts
    RpcComponentClient.ts
    RpcExternalStore.ts

  Topology/
    RpcComponentRef.ts
    RpcTopologyTypes.ts
    RpcTopologyAuthority.ts
    RpcTopologyClient.ts
    RpcTopologyErrors.ts

  Context/
    defineRpcContext.ts
    RpcContextTypes.ts
    RpcContextProvider.ts
    RpcContextResolver.ts
    RpcContextClient.ts
    RpcContextCapture.ts

  Invocation/
    RpcInvocationContext.ts
    currentRpcInvocation.ts
    RpcInvocationPropagation.ts

  Protocol/
    RpcTopologyProtocol.ts
    RpcContextProtocol.ts
```

Suggested package exports:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./context": "./dist/context.js",
    "./topology": "./dist/topology.js",
    "./react": "./dist/react.js"
  }
}
```

The `/react` export is optional and must not be imported by core.

## 23. Test plan

### 23.1 Topology unit tests

- local non-root parent accepted;
- remote non-root parent rejected;
- remote root-to-root parent accepted;
- physical cycle rejected;
- logical owner cycle rejected;
- self-parent and self-owner rejected;
- parent and owner may be equal;
- owner may be arbitrary remote component;
- compare-and-set conflict detected;
- atomic parent+owner update produces one revision;
- deletion with dependants rejected;
- stable refs survive reparenting.

### 23.2 Context resolution tests

- local provider wins;
- nearest physical provider resolves;
- nearest logical provider resolves;
- no cross-axis fallback;
- collect order is nearest-to-farthest;
- missing chain produces `missing`;
- disconnected provider produces `stale`;
- new chain produces `resolving`;
- owner change never exposes mixed old/new values;
- old mount frames are discarded;
- provider restart changes provider epoch;
- identical upstream subscriptions are deduplicated;
- slow subscriber retains only latest pending snapshot.

### 23.3 Invocation tests

- correlation and causation propagation;
- deadline never extends in child calls;
- baggage allow-list and byte limit;
- receiver-derived principal cannot be spoofed;
- explicit context capture succeeds;
- non-capturable/local token is rejected;
- captured context signature tampering is rejected;
- stale owner fence is rejected.

### 23.4 Shared state tests

- component state remains one-authority/many-reader;
- optimistic revision conflict;
- duplicate idempotent command behavior;
- stateful replicas are not activated without an authority adapter;
- stale state is distinguishable from live state.

### 23.5 Queue integration tests

- snapshot context remains unchanged after owner/recipe change;
- latest context resolves at execution time;
- owner-fenced task is rejected after reassignment;
- spooled envelope preserves context and routing metadata;
- oversized captured context is rejected before acceptance;
- worker structural context remains separate from task context.

### 23.6 Transport parity tests

Run the same behavioral suite over:

- Socket.IO Node client/server;
- Socket.IO browser/Vite client;
- MQTT 5 with a real broker;
- reconnect, duplicate, out-of-order, and delayed-frame fault injection.

### 23.7 Cross-language vectors

Publish canonical fixtures for:

- component refs;
- topology snapshots;
- context tokens and snapshots;
- captured invocation context;
- owner fences;
- signatures and malformed frames.

A small Rust or Go decoder should validate the fixtures without using the TypeScript runtime.

## 24. Rollout plan

### Phase 0 — prerequisites

- observable component full snapshots with epoch/revision;
- reference-counted event subscriptions;
- peer-specific online/gone lifecycle;
- per-call deadline/timeout override;
- strict signed-envelope coverage.

### Phase 1 — topology core

- stable component refs;
- host-root registration;
- topology authority and client;
- parent/owner snapshots;
- validation, CAS, audit, and events;
- client topology external store.

### Phase 2 — structural context

- context tokens;
- local providers;
- host resolver;
- remote frontier subscriptions;
- physical/logical resolution;
- live/stale/resolving lifecycle;
- client external stores;
- schema and introspection.

### Phase 3 — invocation and fencing

- invocation context;
- correlation/causation propagation;
- explicit context capture;
- owner fencing;
- transport signatures and limits.

### Phase 4 — queue integration

- snapshot/latest queued context;
- task/worker context separation;
- envelope persistence;
- dead-letter diagnostics for stale ownership or unresolved latest context.

No phase changes ordinary typed method invocation or `client.proxy()` semantics.

## 25. Acceptance criteria

The feature is ready when all of the following are true:

1. A host root can be attached below a remote host root and all descendants receive the correct physical context.
2. Any component can be assigned an arbitrary remote owner without changing its identity or physical state.
3. Physical and logical context values can coexist without ambiguous fallback.
4. An owner change produces no mixed context snapshot.
5. Context remains synchronously readable from immutable local cache.
6. Every value exposes provider, epoch, revision, and freshness.
7. Loss of a remote ancestor marks dependent context stale rather than silently live.
8. Reconnect converges through a full snapshot.
9. Stale owner commands can be fenced.
10. Shared mutable state remains owned by an explicit authority.
11. Queued work can choose snapshot or latest context deliberately.
12. All behavior is equivalent over Socket.IO and MQTT.
13. Context metadata and subscriptions are strictly bounded.
14. A non-TypeScript decoder can process the normative wire fixtures.
15. Existing non-component RPC users require no code changes.

## 26. Decision summary

The framework surface should converge on:

```ts
component.props;
component.state;
component.topology; // parent + owner
component.context;  // inherited, cached, versioned
```

with three distinct kinds of context:

```text
structural context   inherited through parent or owner
invocation context   attached to one operation
shared state         owned by an explicit component/store
```

The two topology links have precise meanings:

```text
parent = where the component physically exists
owner  = which logical scope currently owns/organises it
```

The design preserves the strongest idea from the extension chat—React-like one-way data flow over a distributed RPC network—while adding the epochs, provenance, authority, failure semantics, and explicit boundaries required for browsers and industrial networks.

---

# Appendix A — Worked example

```ts
export const PlantContext =
  defineRpcContext<PlantContextValue>({
    id: 'acme.plant',
    schemaVersion: '1',
    axis: 'physical',
    stalePolicy: 'allow',
    capture: 'explicit',
  });

export const BatchContext =
  defineRpcContext<BatchContextValue>({
    id: 'acme.batch',
    schemaVersion: '1',
    axis: 'logical',
    stalePolicy: 'reject',
    capture: 'explicit',
  });

class PlantRoot extends RpcComponent<
  PlantProps,
  PlantState
> {
  readonly #plant = this.provideContext(
    PlantContext,
    {
      plantId: this.props.plantId,
      timezone: this.props.timezone,
      pressureUnit: 'bar',
    },
  );
}

class Batch extends RpcComponent<
  BatchProps,
  BatchState
> {
  readonly #batch = this.provideContext(
    BatchContext,
    {
      batchId: this.props.batchId,
      recipeRevision: this.props.recipeRevision,
    },
  );
}

class Pump extends RpcComponent<
  PumpProps,
  PumpState
> {
  async start(): Promise<void> {
    const plant = this.context.require(PlantContext);
    const batch = this.context.require(BatchContext, {
      requireLive: true,
    });

    const invocation = currentRpcInvocation();

    await this.audit.record({
      requestId: invocation.requestId,
      plantId: plant.plantId,
      batchId: batch.batchId,
      operation: 'pump.start',
    });

    await this.drive.start();
    this.setState({ running: true });
  }
}
```

Initial topology:

```text
Physical                           Logical

PlantRoot-A                        Batch-4711
└─ HostRoot-B                      └─ Pump-7
   └─ Pump-7
```

The pump receives `PlantContext` through `parent` and `BatchContext` through `owner`.

During maintenance:

```ts
await topology.update(
  pumpRef,
  {
    owner: maintenanceJobRef,
  },
  {
    expectedVersion:
      pump.topology.getSnapshot().version,
    reason: 'Begin bearing replacement',
  },
);
```

The pump remains under the same physical host and retains its hardware state. Its logical context enters `resolving`, then atomically changes from the batch scope to the maintenance scope. Calls carrying the earlier `ownerEpoch` are rejected.

# Appendix B — Chat-page traceability matrix

| Extension chat pages | Referenced idea | Disposition in this specification |
|---|---|---|
| 1–3 | Raw proxy properties lack intent, metadata, and async boundaries; cached props/state and one-way updates | Adopted. Typed methods replace generic string dispatch. Props narrowed to structural configuration. |
| 4–5 | Command versus event versus work queue | Adopted as three separate interaction semantics. Context snapshots use observable state/events; writes use commands. |
| 7–9 | Per-component mailbox versus separate work-queue coordinator | Adopted. Topology/context are framework services; queues remain separate resources. |
| 10–14 | Queue coordinator state, retries, persistence, poison tasks, broker complexity | Used to define non-goals and to avoid turning context/state into a broker or consensus system. |
| 15–16 | MQTT shared routing hidden behind developer API | Partially adopted: transport details remain hidden, but context semantics never depend on a broker extension. |
| 17–21 | Transport-neutral RPC pull and lease/ack behavior over MQTT and WebSocket | Adopted for queue integration and the general rule that Source RPC semantics are transport-independent. |
| 22–23 | MQTT 5 optimisation path | Adopted only as optional transport optimisation; no observable context behavior changes. |
| 24–29 | Explicit push/pull implementations and handler-registration interface | Handler/external-store inversion of control adopted. A single portable context protocol is used because its semantics can actually be equivalent. |
| 30–35 | Consumer and producer backpressure; bounded preservation strategies | Adopted as strict metadata limits, latest-wins snapshot coalescing, and queue capture limits. |
| 36–39 | Durable spooling and envelope preservation | Queue integration requires context/routing envelope to be persisted with payload. Storage implementation remains outside core context. |
| 40–45 | Opaque binary payloads and MessagePack/FlatBuffers discussion | Adopted as no framework-level deserialisation. “Zero-copy” is not promised. |
| 46–48 | Routing key and headers outside opaque payload | Adopted directly for invocation/task envelopes and captured context metadata. |
| 49–50 | Polyglot opaque router in Go or Rust | Adopted as a protocol requirement: canonical language-independent schemas and test vectors. |
