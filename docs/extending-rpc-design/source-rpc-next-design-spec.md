# Source RPC 4.1–4.2 Design Specification

## Observable components and transport-neutral work queues

**Status:** Proposed  
**Basis reviewed:** `@source-repo/rpc` 4.0.0, current public repository, MQTT 5.0 specification, MQTT.js behavior, and the attached *Extending Source RPC* discussion  
**Primary implementation language:** TypeScript, ESM, Node.js 22+, browser-compatible where noted

---

## 1. Executive decision

The next development cycle should add two related but distinct capabilities:

1. **Observable RPC components**: an opt-in extension for long-lived RPC instances with React-inspired, cached `props` and `state`, while preserving typed RPC methods as the only remote mutation mechanism.
2. **Work queues**: a separate, transport-neutral queue service with competing consumers, bounded capacity, leases, retries, and dead-letter handling. It must work with the same semantics over Socket.IO and MQTT 5.

The work should be staged:

- **4.1.0 — Observable components and prerequisites**
- **4.2.0 — Work queue package surface and in-memory reference store**

Neither release requires a wire-protocol break. A 5.0 release is only justified if `props` or `state` become reserved on every ordinary proxy, or if the MQTT frame format changes. This proposal does neither.

### Core architectural rule

Source RPC should continue to be an RPC framework, not grow into a general actor runtime or a replacement for RabbitMQ, Kafka, NATS, or an MQTT broker.

The new features should build on the strengths already present in 4.0:

- classes as contracts;
- typed method calls;
- declared command semantics;
- meaningful deadlines and unknown outcomes;
- serial/keyed execution and bounded mailboxes;
- events with reconnect replay;
- MQTT 5 request/reply and shared RPC replicas;
- schema extraction, compatibility checking, and introspection.

---

## 2. Review of the current 4.0 foundation

The current package is a good base for this work. In particular:

- `proxy()` now returns the typed remote instance directly, so a component facade can remain visually close to an ordinary object.
- Long-lived instances already hold local implementation state.
- `query`, `idempotent-command`, and `non-repeatable-command` semantics already distinguish reads from physical or otherwise consequential commands.
- Deadlines are carried to the server and checked after queueing.
- Serial and keyed execution already provide the local-mailbox behavior that the extension discussion was trying to introduce.
- The existing mailbox is bounded and supports safe conflation of queued idempotent commands.
- Events are scoped by peer and namespace and subscriptions are replayed after reconnect.
- MQTT 5 shared subscriptions are already exposed through `sharedGroup`/`replicaId` for replicated RPC servers.
- MsgPack already carries `Uint8Array` natively.
- The schema and introspection formats provide natural extension points for component data.

This means the update should be **additive**. It should not replace typed methods with a stringly typed `dispatchCommand(command, payload)` API, and it should not build a second competing dispatch system inside every instance.

### 2.1 Prerequisite fixes found during review

These should be included in 4.1 before component or queue behavior depends on them.

#### Per-call timeout

Extend the existing `$with()` options:

```ts
export interface RpcCallOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
}
```

The effective timeout is:

```ts
const timeoutMs = options.timeoutMs ?? this.callTimeout;
```

Rules:

- It must be a finite, non-negative integer.
- `timeoutMs > 0` arms the local timer and becomes the transmitted TTL.
- `timeoutMs === 0` means no local timeout and no transmitted TTL, matching the existing internal comment.
- The timer must not be created at all when the value is zero.

The current implementation omits the transmitted TTL when `callTimeout` is zero but still creates `setTimeout(..., 0)`, so it times out immediately rather than waiting indefinitely. Fix this at the same time.

The queue consumer will use bounded long polls such as `waitMs: 20_000` with an RPC timeout of `25_000`.

#### Event-subscription reference counting

A remote event subscription is keyed by target, namespace, and event, while the local emitter may have several handlers under that key. Removing one local handler must not unsubscribe the remaining handlers remotely.

For each key, track:

```ts
interface HeldSubscription {
  remote?: string;
  instanceName: string;
  event: string;
  remoteSubscribed: boolean;
}
```

After `off(event, handler)`, call the remote `off` only when the local listener count for that key reaches zero. This is especially important because several UI consumers may observe the same component channel.

The component implementation should additionally share one channel per `(target, namespace)` and reference-count facade users.

#### Forward peer lifecycle events through `RpcClient`

`RpcClient` currently forwards transport-level connected/disconnected events. It should also forward:

- `TransportEvent.peerOnline`
- `TransportEvent.peerGone`
- `TransportEvent.peerDisplaced`

This lets a component aimed at one named peer distinguish “the link is up but that peer is gone” from “the whole link is down.”

---

## 3. Terminology

The framework should use these terms consistently.

### RPC instance

A long-lived object exposed under a namespace. Its typed methods are remotely callable.

### Mailbox

The existing Source RPC execution queue for one instance or execution key. It controls method overlap, bounds waiting calls, and optionally conflates stale idempotent commands. It is not a distributed work queue.

### Observable component

An RPC instance with two additional public snapshots:

- `props`: host-controlled, read-only inputs or configuration;
- `state`: instance-controlled, read-only public observable state.

An observable component still uses ordinary typed methods for commands and queries.

### Event

A fact delivered to every subscriber to that event. It is fan-out, not competing consumption.

### RPC replica group

The existing MQTT `sharedGroup`/`replicaId` mode. Several servers expose the same RPC peer identity and MQTT distributes requests between them. The caller still waits for the RPC result.

### Work queue

A named service that accepts work independently of its completion and distributes each task to one consumer using leases. It is separate from the per-instance mailbox and from an RPC replica group.

### Store

The authoritative queue-state implementation. The first release ships an explicitly ephemeral memory store and a persistence interface, not a database dependency.

---

## 4. Choosing the correct primitive

| Need | Use |
|---|---|
| Call a known instance and receive its result | Ordinary RPC method |
| Call any one of several equivalent MQTT workers and wait for the result | Existing RPC `sharedGroup` replicas |
| Broadcast that something happened | Event |
| Observe the latest public configuration and state | Observable component |
| Submit work, disconnect, and let any worker process it later | Work queue |
| Broker-grade clustering, retained logs, complex routing, or very large durable backlogs | A dedicated broker/system, integrated with Source RPC rather than reimplemented inside it |

This distinction is important. The current replica feature already solves many “load balance this calculation” cases. A work queue is justified only when **acceptance and completion are decoupled** or when queue-specific lifecycle semantics are required.

---

# Part I — Observable components

## 5. Goals

An observable component must provide:

- typed, synchronous reads of the latest cached `props` and `state` on the client;
- no network request for each read;
- read-only client behavior;
- explicit initialization and staleness status;
- a race-free initial snapshot;
- healing after disconnect through a fresh full snapshot;
- duplicate and out-of-order suppression;
- optional update coalescing for telemetry-like state;
- schema extraction, compatibility checking, and introspection;
- no React runtime dependency;
- no change to ordinary `client.proxy()` behavior.

## 6. Non-goals

Observable components do not provide:

- transparent remote property assignment;
- distributed shared memory;
- event history or a time-series database;
- automatic conflict resolution between writers;
- high-rate waveform streaming;
- deep reactive tracking of nested mutations;
- a Redux-like action framework;
- an actor scheduler separate from the existing method-execution controls.

Use methods for mutation, events for facts, and queues or specialist streaming systems for high-volume streams.

---

## 7. Semantics of `props` and `state`

### 7.1 Props

`props` are the component host's current inputs to the instance.

Examples include:

- configuration;
- engineering units;
- physical location;
- capability limits;
- connection parameters;
- an application-level desired state.

The framework must **not** define props as desired state in all domains. Desired/reported state is a useful industrial convention layered on top of the generic concept.

Rules:

- The exposed instance can read its props.
- Remote clients can read cached props.
- Remote clients cannot assign or patch props.
- The local host can replace props through a host controller.
- Props replacement is atomic at snapshot level.

### 7.2 State

`state` is the instance's latest public observable snapshot.

Examples include:

- current mode;
- a summarized health state;
- reported setpoint and measured value;
- queue depth;
- lifecycle progress;
- UI-relevant derived data.

It is not all object state. Private fields remain the right place for implementation details, caches, handles, credentials, and large or high-frequency data.

Rules:

- The instance changes state through protected helpers.
- Remote clients read cached state.
- Remote clients cannot assign or patch state.
- State updates are immutable at the top level.
- The first implementation uses full snapshots, not patches.

### 7.3 Commands remain typed methods

A client that wants a pump to change does not write `pump.state.running = true`. It calls a typed method whose semantics are visible to Source RPC:

```ts
@rpc({ semantics: 'idempotent-command' })
async setRunning(running: boolean): Promise<void> {
  await this.drive.setRunning(running);
  this.setState({ running });
}
```

This preserves intent, authorization, validation, deadlines, ordering, idempotency, and meaningful error handling.

---

## 8. Server-side API

### 8.1 Base class

```ts
import { EventEmitter } from 'events';

export type RpcComponentData = Record<string, unknown>;

export abstract class RpcComponent<
  P extends RpcComponentData,
  S extends RpcComponentData,
> extends EventEmitter {
  protected constructor(initialProps: P, initialState: S);

  public get props(): Readonly<P>;
  public get state(): Readonly<S>;

  protected readonly setState: (
    update:
      | Partial<S>
      | ((previous: Readonly<S>) => Partial<S>),
  ) => Readonly<S>;

  protected readonly replaceState: (
    update: S | ((previous: Readonly<S>) => S),
  ) => Readonly<S>;
}
```

Implementation requirements:

- Internal records live in a `WeakMap<RpcComponent, ComponentInternals>`.
- `props` and `state` are getters, not mutable fields.
- `setState` and `replaceState` are protected own-property arrow functions, not prototype methods.
- Top-level values are copied and shallow-frozen before commit.
- The component emits an internal snapshot notification after commit, subject to coalescing.

The own-property requirement is deliberate: `exposeClassInstance` currently walks prototype methods when no explicit `@rpc` allow-list exists. Protected helper methods on the base prototype would otherwise become remotely callable. Getters are skipped by the current exposure scan, and own-property functions are not scanned.

### 8.2 Host controller

```ts
export interface RpcComponentHost<
  P extends RpcComponentData,
  S extends RpcComponentData,
> {
  getSnapshot(): RpcComponentSnapshot<P, S>;

  replaceProps(
    update: P | ((previous: Readonly<P>) => P),
  ): RpcComponentSnapshot<P, S>;
}

export function componentHost<
  P extends RpcComponentData,
  S extends RpcComponentData,
>(component: RpcComponent<P, S>): RpcComponentHost<P, S>;
```

Only local code receives this controller. It is never exposed through the remote proxy.

Example:

```ts
const pump = new Pump(initialProps, initialState);
const host = componentHost(pump);

server.exposeClassInstance(pump, 'pump', {
  execution: 'serial',
  component: { minPublishIntervalMs: 20 },
});

host.replaceProps((props) => ({
  ...props,
  configuredMaximumBar: 12,
}));
```

### 8.3 Exposure options

Extend `ExposeOptions` additively:

```ts
export interface RpcComponentExposeOptions {
  /** Coalesce network snapshots; local state still changes immediately. */
  minPublishIntervalMs?: number;

  /** Reject a snapshot that exceeds this encoded size. */
  maxSnapshotBytes?: number;
}

export interface ExposeOptions {
  // existing fields...
  component?: RpcComponentExposeOptions;
}
```

Recommended defaults:

- same-turn updates are microtask-coalesced;
- `minPublishIntervalMs: 0` beyond that microtask batching;
- `maxSnapshotBytes: 1_048_576` unless a project deliberately changes it.

`setState()` increments the local revision for every committed update. Published revisions may skip values when several updates are coalesced; they must never move backwards.

### 8.4 Optional convenience method

`RpcServerBase` may provide:

```ts
exposeComponent<
  P extends RpcComponentData,
  S extends RpcComponentData,
  T extends RpcComponent<P, S>,
>(
  instance: T,
  name?: string,
  options?: ExposeOptions,
): RpcComponentHost<P, S>;
```

This should be a convenience around `exposeClassInstance()` plus `componentHost()`. Existing exposure remains valid and is the underlying mechanism.

---

## 9. Snapshot contract

```ts
export interface RpcComponentSnapshot<
  P extends RpcComponentData,
  S extends RpcComponentData,
> {
  /** Changes when this component instance is reconstructed. */
  readonly epoch: string;

  /** Strictly increasing within one epoch. May have gaps. */
  readonly revision: number;

  readonly props: Readonly<P>;
  readonly state: Readonly<S>;
}
```

### 9.1 Why both epoch and revision are required

A revision alone cannot distinguish revision `3` after a process restart from revision `900` before it. An epoch alone cannot order updates. Together they provide a small, transport-neutral ordering model.

Client acceptance rules:

1. The first snapshot is accepted.
2. In the same epoch, accept only a greater revision.
3. A newly observed epoch replaces the old one and retires the old epoch.
4. A later frame from a retired epoch is ignored.
5. Duplicate revisions are ignored.

The client must not use server wall-clock timestamps for ordering. Browser, edge, and plant clocks are not guaranteed to agree.

### 9.2 Full snapshots first

Version 1 sends full snapshots.

This is intentional:

- reconnect recovery is simple;
- a missed event cannot corrupt a patch chain;
- duplicate delivery is harmless;
- compatibility rules remain understandable;
- most component state should be small and summarized.

A future patch form would need at least `baseRevision`, atomic application, fallback to a full snapshot, and size-based selection. It is out of scope for 4.1.

---

## 10. Client-side API

### 10.1 Component proxy

Ordinary proxies remain unchanged:

```ts
const pump = await client.proxy<Pump>('pump', 'plantServer');
```

Observable behavior is explicit:

```ts
const pump = await client.component<Pump>('pump', 'plantServer');
```

`component()` waits until the first authorized snapshot has arrived, then returns a proxy that combines:

- all ordinary typed remote methods and events;
- cached, read-only `.props`;
- cached, read-only `.state`;
- a symbol-keyed external-store interface.

```ts
export type ComponentProps<T> =
  T extends RpcComponent<infer P, infer _S> ? P : never;

export type ComponentState<T> =
  T extends RpcComponent<infer _P, infer S> ? S : never;

export type RpcComponentProxy<T extends RpcComponent<any, any>> =
  RpcProxy<T> & {
    readonly [rpcComponent]: RpcComponentStore<
      ComponentProps<T>,
      ComponentState<T>
    >;
  };
```

### 10.2 External-store interface

```ts
export const rpcComponent = Symbol('@source-repo/rpc/component');

export type RpcComponentStatus =
  | 'initializing'
  | 'live'
  | 'stale'
  | 'closed';

export interface RpcComponentView<
  P extends RpcComponentData,
  S extends RpcComponentData,
> extends RpcComponentSnapshot<P, S> {
  readonly status: RpcComponentStatus;
  /** Local receipt time, useful for display but not distributed ordering. */
  readonly receivedAt: number;
  readonly staleSince?: number;
}

export interface RpcComponentStore<
  P extends RpcComponentData,
  S extends RpcComponentData,
> {
  getSnapshot(): RpcComponentView<P, S>;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
```

This mirrors the minimal shape expected by React's external-store model without importing React or making React a peer dependency.

A future React adapter can be a separate tiny package or subpath:

```ts
const view = useSyncExternalStore(
  pump[rpcComponent].subscribe,
  pump[rpcComponent].getSnapshot,
);
```

It is not part of 4.1.

### 10.3 Direct reads

```ts
console.log(pump.props.engineeringUnit);
console.log(pump.state.actualBar);
```

These are synchronous reads of the latest accepted snapshot.

Assignments throw at runtime:

```ts
pump.state = nextState;       // TypeScript error and runtime TypeError
pump.props = nextProps;       // TypeScript error and runtime TypeError
```

The first implementation guarantees top-level immutability. Nested objects are typed read-only by convention but are not recursively frozen, because deep freezing is expensive and problematic for typed arrays and rich values. Documentation must tell callers not to mutate nested snapshot data.

### 10.4 `$with()` must preserve the component facade

This must work correctly:

```ts
await pump
  .$with({ idempotencyKey: workOrder, timeoutMs: 5_000 })
  .setRunning(true);
```

The value returned by `$with()` must still expose the same cached `props`, `state`, and `[rpcComponent]` store. Do not return a bare ordinary RPC proxy from the component wrapper.

### 10.5 Shared channel and lifecycle

`RpcClient` holds one internal component channel for each `(target, namespace)` pair.

- Repeated calls to `component()` share the channel.
- Local subscribers are reference-counted.
- The remote internal subscription is removed only when the last facade/store closes.
- `client.close()` closes every channel.

Status transitions:

```text
initializing -> live     first snapshot accepted
live -> stale            transport disconnected or target peer gone
stale -> live            fresh snapshot accepted after reconnect/reappearance
* -> closed              store/client closed
```

The last snapshot remains readable while stale. It must not be cleared, because “last known, stale” is much more useful than replacing knowledge with `undefined`.

---

## 11. Race-free subscription protocol

Use the existing event transport rather than inventing a second message family.

Each `RpcComponent` has one internal event name, private to the implementation. When a client calls `component()`:

1. The client installs the local internal-event handler.
2. It sends the ordinary remote `on(internalSnapshotEvent)` request.
3. The server authorizes the subscription using the existing subscription authorization path.
4. The server attaches the event proxy.
5. The server sends a targeted full snapshot to that subscriber.
6. The server answers the subscription request.
7. `component()` resolves after the first snapshot has been accepted.

The local handler is installed before the request, which already matches the current event proxy behavior. Sending the snapshot after the server listener is attached closes the classic “fetch then subscribe” race.

On every reconnect resubscription, the server sends a fresh full snapshot even if the event proxy already existed. This repairs all missed state without replaying every intermediate change.

The internal component event:

- is authorized like any other subscription;
- is not listed as an ordinary user event in introspection;
- cannot be emitted by remote callers;
- is deduplicated by epoch/revision on the client.

---

## 12. Example component

```ts
import {
  RpcComponent,
  componentHost,
  rpc,
  rpcNamespace,
} from '@source-repo/rpc';

interface PumpProps {
  engineeringUnit: 'bar';
  configuredMaximumBar: number;
  location: string;
}

interface PumpState {
  running: boolean;
  setpointBar: number;
  actualBar: number;
  quality: 'good' | 'uncertain' | 'bad';
}

@rpcNamespace('pump', {
  execution: 'serial',
  mailbox: 32,
})
export class Pump extends RpcComponent<PumpProps, PumpState> {
  public constructor(
    props: PumpProps,
    state: PumpState,
    private readonly drive: Drive,
  ) {
    super(props, state);
  }

  @rpc({ semantics: 'query' })
  public async readRawDiagnostics(): Promise<DriveDiagnostics> {
    return this.drive.readDiagnostics();
  }

  @rpc({ semantics: 'idempotent-command', conflate: true })
  public async setSetpoint(bar: number): Promise<void> {
    if (bar > this.props.configuredMaximumBar) {
      throw Object.assign(new Error('setpoint exceeds configured maximum'), {
        code: 'InvalidParams',
      });
    }

    await this.drive.setSetpoint(bar);
    this.setState({ setpointBar: bar });
  }

  @rpc({ semantics: 'non-repeatable-command' })
  public async dispense(batchId: string): Promise<void> {
    await this.drive.dispense(batchId);
  }

  public onTelemetry(actualBar: number, quality: PumpState['quality']): void {
    this.setState({ actualBar, quality });
  }
}

const pump = new Pump(initialProps, initialState, drive);
const host = componentHost(pump);

server.exposeClassInstance(pump, 'pump', {
  component: { minPublishIntervalMs: 50 },
});

host.replaceProps((props) => ({
  ...props,
  configuredMaximumBar: 10,
}));
```

Client:

```ts
import { rpcComponent } from '@source-repo/rpc';
import type { Pump } from './pump.js';

const pump = await client.component<Pump>('pump', 'plantServer');

console.log(pump.props.location);
console.log(pump.state.actualBar);

const store = pump[rpcComponent];
const unsubscribe = store.subscribe(() => {
  const view = store.getSnapshot();
  renderPump(view.state, view.status);
});

await pump.setSetpoint(6);

unsubscribe();
await store.close();
```

---

## 13. Schema, compatibility, and introspection

### 13.1 Schema extension

Extend `NamespaceSchema` additively:

```ts
export interface ComponentSchema {
  snapshot: 1;
  props: TypeNode;
  state: TypeNode;
}

export interface NamespaceSchema {
  version?: string;
  methods: Record<string, MethodSchema>;
  events?: Record<string, { params: TypeNode[] }>;
  component?: ComponentSchema;
  validate?: boolean;
  history?: Record<string, Omit<NamespaceSchema, 'history'>>;
}
```

The extraction CLI detects a class extending `RpcComponent<P, S>` and emits the resolved `P` and `S` types.

If the extractor cannot resolve a generic, it must report an explicit extraction error or emit `any` only under an opt-in flag. Silently presenting unresolved state as checked would be misleading.

### 13.2 Validation

Add a server option:

```ts
validateComponentSnapshots?: boolean;
```

Default: `false`, analogous to `validateResults`.

When enabled:

- exposure installs the component schema validator;
- a proposed props/state update is validated before commit;
- an invalid update throws locally;
- the previous snapshot remains current;
- no invalid snapshot is emitted.

This is a self-check on server code, not a substitute for command argument validation.

### 13.3 Compatibility direction

Props and state flow from server to client, so compatibility follows the existing output/event direction, not method-parameter direction.

The implementation should reuse the existing structural comparator and add explicit tests for:

- optional fields added;
- required fields removed;
- field value narrowed or widened;
- union alternatives changed;
- bytes/array bounds changed;
- component removed from a namespace;
- a namespace becoming a component.

Do not invent a separate compatibility algebra for components.

### 13.4 Introspection extension

```ts
export interface DescribedComponent {
  props?: TypeNode;
  state?: TypeNode;
  subscribers: number;
}

export interface DescribedNamespace {
  // existing fields...
  component?: DescribedComponent;
}
```

The internal snapshot event must not appear in `events`. The console can render a component as:

- current props/state schema;
- whether it is live;
- number of remote peers observing it;
- current snapshot only when the caller is authorized to subscribe, not merely authorized to describe.

Introspection should describe structure, not leak current values.

---

## 14. Component implementation layout

Suggested files:

```text
packages/rpc/src/RPC/Component.ts
packages/rpc/src/RPC/ComponentClient.ts
packages/rpc/src/RPC/Component.test.ts
packages/rpc/src/RPC/ComponentClient.test.ts
```

Core responsibilities:

### `Component.ts`

- `RpcComponent`
- WeakMap internals
- `componentHost()`
- snapshot creation
- epoch/revision
- coalesced notifications
- optional validator installation

### `ComponentClient.ts`

- component channel cache
- component proxy wrapper
- `$with()` preservation
- ordering/deduplication
- lifecycle status
- external-store interface

### `RpcServerHandler`

- recognize the internal component subscription;
- authorize normally;
- attach event proxy;
- send targeted initial/current snapshot on every subscribe/resubscribe;
- suppress internal event from ordinary introspection.

### `RpcClient`

- `component()` entry point;
- component channel lifecycle;
- forward peer lifecycle events;
- close channels.

---

# Part II — Work queues

## 15. Queue design decision

Do **not** expose MQTT topics or `$share` syntax as the generic work-queue API.

Do **not** create two public implementations called `WorkQueuePush` and `WorkQueuePull` that claim identical semantics.

Instead, define one transport-neutral semantic contract backed by a queue coordinator and an authoritative store. Consumers pull leased tasks through bounded long-poll RPC. The client library hides the loop and presents a callback-based API.

This gives the same guarantees over Socket.IO and MQTT 5. MQTT-specific acceleration can be added later without changing the semantic contract.

### Why not direct MQTT shared subscriptions as the generic queue

MQTT 5 shared subscriptions are valuable, and Source RPC already uses them for RPC replicas. They do not by themselves define the queue semantics proposed here:

- the broker chooses one subscribed session, but the standard does not promise fair or idle-worker selection;
- QoS 1 is at least once, not an application transaction;
- Receive Maximum limits unacknowledged QoS 1/2 packets, not handler concurrency by itself;
- a negative PUBACK/PUBREC reason does not create a dead-letter queue;
- Message Expiry is a delivery lifetime, not a worker lease;
- broker behavior around disconnect and reassignment is not equivalent to an application-visible lease token;
- Socket.IO has no matching broker primitive.

Shared subscriptions remain appropriate for the existing synchronous replica mode and for a future explicitly MQTT-specific primitive.

---

## 16. Queue goals

The first work-queue release must provide:

- enqueue acknowledgment separate from task completion;
- one consumer per delivery;
- at-least-once processing semantics stated plainly;
- bounded consumer concurrency;
- natural consumer backpressure;
- bounded producer backlog;
- lease expiry and redelivery;
- stale acknowledgment rejection;
- retry limits and dead-letter state;
- task TTL before work starts;
- task-ID deduplication;
- optional opaque `Uint8Array` payloads;
- metrics;
- identical semantics over Socket.IO and MQTT 5;
- an in-memory reference store;
- a durable-store interface with explicit atomicity requirements.

## 17. Queue non-goals

4.2 does not provide:

- exactly-once side effects;
- broker clustering or consensus;
- a replicated built-in durable database;
- Kafka-like ordered logs or replay by offset;
- arbitrary exchanges, bindings, or topic wildcards;
- automatic OPFS/IndexedDB spooling;
- automatic loss policies such as silent drop-oldest;
- guaranteed fair scheduling;
- direct task-result rendezvous with the producer;
- MQTT-only queue behavior hidden behind a supposedly portable contract.

---

## 18. Package surface

Add a package subpath:

```json
{
  "exports": {
    ".": { "browser": {}, "types": "...", "default": "..." },
    "./queue": {
      "browser": {
        "types": "./dist/queue-web.d.ts",
        "default": "./dist/queue-web.js"
      },
      "types": "./dist/queue.d.ts",
      "default": "./dist/queue.js"
    },
    "./package.json": "./package.json"
  }
}
```

The root package remains focused. Queue code is imported only by applications that use it.

Suggested public exports:

```ts
export {
  connectWorkQueue,
  exposeWorkQueue,
  WorkQueueService,
  MemoryWorkQueueStore,
  QueueFullError,
  type WorkQueue,
  type WorkQueueStore,
  type WorkConsumer,
  type WorkContext,
  type WorkQueueOptions,
  type WorkQueueSnapshot,
} from '@source-repo/rpc/queue';
```

---

## 19. Public producer and consumer API

### 19.1 Connecting and exposing

Server:

```ts
import {
  exposeWorkQueue,
  MemoryWorkQueueStore,
} from '@source-repo/rpc/queue';

const analysisQueue = exposeWorkQueue<AnalyzeTask>(
  server,
  'analysisJobs',
  {
    store: new MemoryWorkQueueStore(),
    capacity: {
      maxReadyTasks: 10_000,
      maxReadyBytes: 64 * 1024 * 1024,
      maxPayloadBytes: 1 * 1024 * 1024,
    },
    lease: {
      defaultMs: 30_000,
      maximumMs: 5 * 60_000,
    },
    retry: {
      maxAttempts: 5,
      delayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: 0.2,
    },
  },
);
```

Client/worker:

```ts
import { connectWorkQueue } from '@source-repo/rpc/queue';

const queue = await connectWorkQueue<AnalyzeTask>(
  client,
  'analysisJobs',
  'queueServer',
);
```

### 19.2 Enqueue

```ts
export interface EnqueueOptions {
  /** Generated once by the client wrapper when absent. */
  taskId?: string;

  /** Domain-level duplicate identity retained for a configured window. */
  deduplicationKey?: string;

  /** Time from acceptance during which the task may begin processing. */
  ttlMs?: number;

  /** Higher values are considered first; FIFO within one priority. */
  priority?: number;

  headers?: Readonly<Record<string, string>>;
}

export interface EnqueueReceipt {
  taskId: string;
  acceptedAt: number;
  duplicate: boolean;
}

export interface WorkQueue<TTask> {
  enqueue(task: TTask, options?: EnqueueOptions): Promise<EnqueueReceipt>;
  consume(
    handler: WorkHandler<TTask>,
    options: ConsumeOptions,
  ): Promise<WorkConsumer>;
  stats(): Promise<WorkQueueSnapshot>;
  readonly metrics: RpcComponentStore<WorkQueueProps, WorkQueueState>;
}
```

`enqueue()` resolves when the queue has accepted the task, not when a worker has completed it.

A generated `taskId` is stable for the internal attempts of one `enqueue()` call. A caller repeating the whole application operation later must supply the same domain task ID or deduplication key if it wants the two calls recognized as one intent.

### 19.3 Consume

```ts
export type WorkHandler<TTask> = (
  task: TTask,
  context: WorkContext,
) => Promise<void>;

export interface ConsumeOptions {
  consumerId: string;
  concurrency?: number;
  leaseMs?: number;
  waitMs?: number;
  autoRenew?: boolean;
  retryDelayMs?: number;
}

export interface WorkContext {
  readonly taskId: string;
  readonly attempt: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;

  renew(extensionMs?: number): Promise<void>;
}

export interface WorkConsumer {
  readonly id: string;
  readonly closed: boolean;

  close(options?: {
    drain?: boolean;
    timeoutMs?: number;
  }): Promise<void>;
}
```

Recommended defaults:

- `concurrency: 1`
- `waitMs: 20_000`
- `leaseMs`: queue default
- `autoRenew: true`
- RPC timeout for acquire: `waitMs + 5_000`

The library creates one acquire loop per concurrency slot. A slot does not acquire another task until its current handler has completed or failed. This gives natural consumer backpressure and allows faster workers to consume more work without a central fairness algorithm.

No prefetch is included in 4.2. Prefetch leases work before the consumer is ready, weakens fairness, increases memory use, and creates unnecessary lease expiry. It can be added later as an explicit option after measurement.

---

## 20. Why the handler returns `void`

The first queue API should not include `TResult`.

When a producer needs an immediate result, ordinary RPC or the existing replicated RPC-worker mode is the better primitive. A queued task is intentionally decoupled from the producer's connection and lifetime.

Applications that need asynchronous results can:

- write the result to domain storage keyed by `taskId`;
- emit a typed event;
- call a result receiver over RPC;
- expose a separate `result(taskId)` query.

Result retention, expiration, ownership, and authorization form another subsystem and should not be smuggled into the first queue release.

---

## 21. Internal queue protocol

The public callback API wraps a typed internal RPC protocol.

```ts
interface WorkQueueProtocol<TTask> {
  enqueue(request: EnqueueRequest<TTask>): Promise<EnqueueResult>;
  acquire(request: AcquireRequest): Promise<AcquireResult<TTask>>;
  complete(request: CompleteRequest): Promise<LeaseMutationResult>;
  fail(request: FailRequest): Promise<LeaseMutationResult>;
  renew(request: RenewRequest): Promise<LeaseMutationResult>;
  stats(): Promise<WorkQueueSnapshot>;
}
```

The service methods must be explicitly marked with `@rpc`; no queue internals should be exposed by prototype traversal.

Recommended method semantics:

```ts
@rpc({ semantics: 'idempotent-command' }) enqueue(...)
@rpc({ semantics: 'idempotent-command' }) acquire(...)
@rpc({ semantics: 'idempotent-command' }) complete(...)
@rpc({ semantics: 'idempotent-command' }) fail(...)
@rpc({ semantics: 'idempotent-command' }) renew(...)
@rpc({ semantics: 'query' }) stats()
```

The namespace execution mode must be `parallel`. A long-polling acquire must not serialize enqueue, completion, or other consumers behind it. Atomicity belongs in the store.

### 21.1 Result unions, not new global RPC error codes

Expected queue conditions should use discriminated results:

```ts
export type EnqueueResult =
  | { status: 'accepted'; receipt: EnqueueReceipt }
  | { status: 'full'; retryAfterMs?: number };

export type LeaseMutationResult =
  | { status: 'ok' }
  | { status: 'already-completed' }
  | { status: 'lease-lost' }
  | { status: 'not-found' };
```

The public wrapper maps `status: 'full'` to `QueueFullError`. This avoids expanding the global RPC error vocabulary with domain conditions and remains compatible with other-language peers.

---

## 22. Task and lease model

### 22.1 Stored task

```ts
export interface WorkTaskEnvelope<TTask> {
  taskId: string;
  payload: TTask;
  headers: Readonly<Record<string, string>>;
  priority: number;
  acceptedAt: number;
  expiresAt?: number;
  deduplicationKey?: string;
}
```

`acceptedAt` and `expiresAt` are computed by the queue service's clock. Producers provide `ttlMs`, not an absolute timestamp, avoiding cross-machine clock assumptions.

TTL means the task may not **start** after expiry. Once leased, lease rules govern it. An application-level execution deadline belongs in the task contract or handler logic.

### 22.2 Lease

```ts
export interface WorkLease<TTask> {
  taskId: string;
  leaseToken: string;
  payload: TTask;
  headers: Readonly<Record<string, string>>;
  attempt: number;
  leasedUntil: number;
}
```

The token is a random opaque value replaced on every lease. A completion, failure, or renewal carrying an old token is rejected as `lease-lost`.

This fences queue mutations. It does not magically fence side effects in an external database, PLC, or file. Handlers that cause non-repeatable effects still need domain idempotency or a transactional design.

### 22.3 State machine

```text
ready --------acquire--------> leased --------complete-------> completed
  |                                |
  |                                +----fail/timeout---------> delayed/ready
  |                                                            |
  +----TTL before acquire----> expired                           +--max attempts--> dead-lettered
```

A failed task increments `attempt`. After `maxAttempts`, it becomes dead-lettered rather than being delivered forever as a poison task.

### 22.4 At-least-once statement

The documentation must state prominently:

> A work-queue handler may run more than once. A lease can expire after the handler changed the world but before completion reached the queue. Task IDs and lease tokens protect queue state; they do not make arbitrary external side effects exactly once.

---

## 23. Acquire idempotency and unknown outcomes

An acquire changes state, and its response can be lost. A retry with a new acquisition identity could lease a second task while the first remains leased.

Every acquire request therefore carries a stable `acquireId`:

```ts
export interface AcquireRequest {
  acquireId: string;
  consumerId: string;
  leaseMs: number;
  waitMs: number;
}
```

The store remembers the result of an acquire ID for at least the lease period plus a retry margin. Repeating the request returns the same lease or the same empty result.

The consumer wrapper behaves as follows:

- `TransportError` before send: retry the same acquire ID.
- `Timeout` or `UnknownOutcome`: retry the same acquire ID.
- definitive empty result: generate a new acquire ID for the next wait.
- lease received: begin handler and generate no new acquire on that concurrency slot until it settles.

This is application-level idempotency inside the queue protocol and does not rely on the general RPC idempotency store.

---

## 24. Backpressure and capacity

### 24.1 Consumer backpressure

Consumer concurrency is the maximum number of leased tasks being handled by one consumer object. No more work is acquired than the configured slots.

This protects browser, WASM, and edge worker memory independently of the transport.

### 24.2 Producer backpressure

```ts
export interface WorkQueueCapacity {
  maxReadyTasks: number;
  maxReadyBytes: number;
  maxPayloadBytes: number;
  maxHeaders?: number;
  maxHeaderBytes?: number;
}
```

When accepting a task would exceed a limit, the service returns `status: 'full'`. The wrapper throws:

```ts
export class QueueFullError extends Error {
  public readonly queue: string;
  public readonly retryAfterMs?: number;
  public readonly capacity?: Readonly<WorkQueueCapacity>;
}
```

4.2 supports **reject-new only**. It must not silently drop old or new work.

Drop-oldest, conflation, downsampling, and priority triage are valid domain policies for telemetry, but they are not safe generic work-queue defaults. They can be implemented before enqueue or in a future explicitly lossy stream primitive.

### 24.3 Size accounting

The service/store must maintain an encoded or defensible estimated byte size for each task. `Uint8Array` has an exact payload size. Object tasks may be encoded once for storage or measured through the configured codec.

Capacity accounting must include at least payload and bounded header overhead. It should be conservative rather than claim precise process memory use.

---

## 25. Retry and dead-letter policy

```ts
export interface WorkQueueRetryPolicy {
  maxAttempts: number;
  delayMs: number;
  maxDelayMs?: number;
  jitter?: number;
}
```

The public/configured form stays serializable. A custom function may be accepted as a local server option, but introspection should report a stable policy name or normalized static fields rather than pretending a function is part of the portable contract.

Failure rules:

- resolved handler -> `complete`;
- thrown/rejected handler -> `fail` with a bounded failure summary;
- consumer process loss -> lease expiry, then retry;
- renewal failure -> abort signal and eventual retry;
- maximum attempts -> dead letter.

Failure data must be bounded and sanitized. Do not store unbounded stack traces or arbitrary thrown objects in the queue.

### 25.1 Admin surface

Provide a separate administrative interface, authorized through ordinary Source RPC rules:

```ts
interface WorkQueueAdmin {
  listDeadLetters(options?: PageOptions): Promise<DeadLetterPage>;
  retryDeadLetter(taskId: string): Promise<AdminMutationResult>;
  discardDeadLetter(taskId: string): Promise<AdminMutationResult>;
}
```

Do not automatically publish dead letters to an arbitrary MQTT topic in 4.2.

---

## 26. Store interface

The store is the queue's authoritative state machine.

```ts
export interface WorkQueueStore<TStoredPayload = unknown> {
  readonly capabilities: {
    durable: boolean;
    shared: boolean;
  };

  enqueue(
    queue: string,
    task: StoredWorkTask<TStoredPayload>,
    limits: WorkQueueCapacity,
  ): Promise<StoreEnqueueResult>;

  acquire(
    queue: string,
    request: StoreAcquireRequest,
  ): Promise<StoreAcquireResult<TStoredPayload>>;

  complete(
    queue: string,
    taskId: string,
    leaseToken: string,
  ): Promise<StoreLeaseMutationResult>;

  fail(
    queue: string,
    request: StoreFailRequest,
  ): Promise<StoreLeaseMutationResult>;

  renew(
    queue: string,
    request: StoreRenewRequest,
  ): Promise<StoreLeaseMutationResult>;

  reap(queue: string, now: number): Promise<StoreReapResult>;
  snapshot(queue: string, now: number): Promise<WorkQueueSnapshot>;

  listDeadLetters(
    queue: string,
    options: PageOptions,
  ): Promise<DeadLetterPage<TStoredPayload>>;

  retryDeadLetter(
    queue: string,
    taskId: string,
  ): Promise<AdminMutationResult>;

  discardDeadLetter(
    queue: string,
    taskId: string,
  ): Promise<AdminMutationResult>;
}
```

### 26.1 Atomicity requirements

A conforming store must atomically provide:

- deduplicated enqueue and capacity reservation;
- selection plus transition from ready to leased;
- acquire-ID replay;
- lease-token comparison on complete/fail/renew;
- attempt increment plus ready/delayed/dead-letter transition;
- expired-task removal and byte-count correction.

A store that cannot guarantee these transitions must not be documented as a durable/shared implementation.

### 26.2 Memory store

Ship:

```ts
new MemoryWorkQueueStore()
```

Its documentation and introspection must say:

- `durable: false`
- `shared: false`
- all ready, leased, retry, deduplication, and dead-letter state is lost on process restart.

Use ordered indexes or heaps plus one scheduled wake-up for lease/retry expiry. Do not create one unmanaged timer per task.

### 26.3 Durable adapters

Do not add a database dependency to the core package. Durable adapters can later live in separate packages for SQLite, PostgreSQL, MongoDB, Redis, or another project-specific store.

A shared durable store is also the prerequisite for safely replicating the queue service through Source RPC's existing MQTT replica mode.

---

## 27. Long polling

The portable consumer implementation uses bounded long polling:

```ts
const result = await protocol
  .$with({ timeoutMs: waitMs + 5_000 })
  .acquire({
    acquireId,
    consumerId,
    waitMs,
    leaseMs,
  });
```

Rules:

- `waitMs` has a server-configured maximum.
- The service returns an explicit empty result when the wait expires.
- The RPC timeout must exceed the queue wait by a safety margin.
- No promise is held indefinitely.
- Disconnect leaves at most a bounded orphan waiter.
- A task accidentally leased to a disconnected consumer is recovered by lease expiry.

A future core invocation context or cancel frame could remove orphan waiters earlier, but it is not required for correct bounded behavior in 4.2.

---

## 28. Consumer loop behavior

For each concurrency slot:

```text
acquire -> handler -> complete
                 \-> fail
```

Operational rules:

- Retry transport failures with exponential backoff and jitter.
- Reuse the same acquire ID after an uncertain acquire outcome.
- Auto-renew at a fraction of the lease duration when enabled.
- Abort the handler signal if renewal proves the lease is lost or the consumer is forcibly closed.
- Treat handler completion after lease loss as uncertain; attempt no successful completion under the stale token.
- A cooperative handler should stop on `signal.aborted`, but the framework cannot force it.
- Consumer close defaults to graceful drain, with a bounded timeout option.

The queue wrapper should emit or expose operational errors separately from task-handler failures so a handler bug does not end the acquire loop.

---

## 29. Queue metrics as an observable component

`WorkQueueService` should extend `RpcComponent<WorkQueueProps, WorkQueueState>` to exercise the component model and provide live, cached operational status.

```ts
export interface WorkQueueProps {
  capacity: WorkQueueCapacity;
  lease: {
    defaultMs: number;
    maximumMs: number;
  };
  retry: WorkQueueRetryPolicy;
  store: {
    durable: boolean;
    shared: boolean;
  };
}

export interface WorkQueueState {
  ready: number;
  leased: number;
  delayed: number;
  deadLettered: number;
  expired: number;
  activeConsumers: number;
  readyBytes: number;
  oldestReadyAgeMs?: number;
  saturated: boolean;
}
```

Metrics snapshots should be throttled, for example to 250 ms, rather than emitted for every task transition. `stats()` remains available for an authoritative point-in-time query.

When a future replicated queue service uses a shared durable store, metrics must come from that global store rather than from one process's local counters.

---

## 30. Payloads, MessagePack, and routing

### 30.1 Generic typed payloads

The ordinary API accepts typed values and relies on Source RPC's configured codec. MsgPack remains the default and already preserves bytes and dates.

### 30.2 Opaque binary payloads

`TTask` may be `Uint8Array`. The queue must not decode it. It stores and returns the bytes as an opaque payload.

Documentation should call this:

- opaque binary transport;
- no framework-level payload deserialization;
- low-copy where the runtime permits.

Do not claim end-to-end zero-copy. JavaScript, the codec, network stack, broker, store, and disk API may copy buffers even when no application parser touches them.

### 30.3 Routing key

The generic work-queue name is its routing identity. Do not add a raw MQTT topic to each task in the portable API.

Application metadata belongs in bounded `headers`. It stays inside the Source RPC queue protocol so the behavior is identical over Socket.IO and MQTT.

A separate future broker adapter may map selected metadata to MQTT user properties, but that is an adapter concern and must preserve signing and authorization rules.

---

## 31. MQTT-specific future optimization

A future release may add one of two explicit MQTT features.

### 31.1 Shared worker group

```ts
connectMqttSharedWorkerGroup<T>(...)
```

This would expose direct shared-subscription behavior with clearly weaker/broker-dependent guarantees. It should not implement `WorkQueue<T>` unless it recreates the full lease, retry, capacity, and dead-letter contract.

### 31.2 Shared wake-up hint

The portable queue can retain its authoritative store and acquire protocol while MQTT shared subscriptions deliver only a “work available” hint to one worker. The worker still calls `acquire()` atomically.

Lost or duplicated hints are harmless, and semantics remain transport-neutral. This is a safer optimization than sending the task itself outside the lease protocol.

Neither optimization is part of 4.2.

---

## 32. Producer outbox and local spooling

The attached discussion's OPFS/IndexedDB store-and-forward direction is useful but belongs outside the first queue core.

A later API may define:

```ts
export interface ProducerOutbox<TTask> {
  append(task: PendingEnqueue<TTask>): Promise<void>;
  peek(limit: number): Promise<PendingEnqueue<TTask>[]>;
  commit(ids: readonly string[]): Promise<void>;
  stats(): Promise<OutboxSnapshot>;
}
```

Potential adapters:

- browser OPFS;
- browser IndexedDB;
- Node append-only files;
- SQLite.

Production framing must include more than topic length plus payload length. It needs at least:

- magic/version;
- record length;
- task ID;
- metadata length;
- payload length;
- checksum;
- crash recovery for a partial final record;
- storage quota and overflow behavior;
- compaction/rotation rules.

No local disk survives an infinite outage; all stores have finite capacity. The outbox must report saturation rather than promise impossible durability.

---

## 33. Security and authorization

### Components

- Initial snapshots use the existing subscription authorization path.
- No snapshot is sent before authorization succeeds.
- Host props replacement is local only.
- Remote mutation always goes through authorized methods.
- Introspection describes types, not current values.
- Snapshot size is bounded.

### Queues

- Every internal queue method uses existing authentication/signing and `authorize` handling.
- Producer, consumer, and admin rights should be separable by method.
- `consumerId` is a claim unless transport identity and authorization verify it.
- MQTT deployments still require broker credentials, ACLs, TLS, and/or signed frames as appropriate.
- Headers have count, key-length, value-length, and total-size limits.
- Task payload size is checked before storage.
- Failure summaries and dead-letter data are bounded and sanitized.
- Admin listing must be paged and authorized.

A helper can simplify queue authorization, but it must compose with rather than bypass the server's existing authorizer.

---

# Part III — Delivery plan

## 34. Release 4.1.0

### Core changes

1. Add `RpcCallOptions.timeoutMs`.
2. Correct zero-timeout timer behavior.
3. Fix event-subscription reference counting.
4. Forward peer lifecycle events through `RpcClient`.
5. Add `RpcComponent`, `componentHost`, snapshot types, and symbol store.
6. Add `RpcClient.component()` and shared client channels.
7. Send a targeted initial snapshot on subscription/resubscription.
8. Add coalescing and snapshot bounds.
9. Extend schema extraction and compatibility.
10. Extend introspection without exposing internal events.
11. Add complete browser and Node tests/documentation.

### Suggested module exports

Export component types from the root package. Components are a fundamental RPC-instance capability, not an optional infrastructure subsystem.

### Compatibility

- Existing `proxy()` behavior is unchanged.
- Existing classes need no base class.
- Existing wire frames remain valid.
- New clients must receive a clear error when `component()` targets an ordinary instance or an older server.
- An older client can still call methods on a component using `proxy()`; it simply does not observe props/state.

---

## 35. Release 4.2.0

1. Add `@source-repo/rpc/queue` subpath.
2. Add public producer/consumer wrapper.
3. Add internal typed queue protocol.
4. Add `WorkQueueService` with parallel execution.
5. Add `MemoryWorkQueueStore`.
6. Add lease, acquire-ID replay, retry, TTL, and dead-letter state machine.
7. Add capacity and `QueueFullError`.
8. Add queue metrics through observable components.
9. Add admin surface.
10. Add transport-parity, fault-injection, and load tests.
11. Document exactly where existing MQTT replica groups are sufficient instead.

---

## 36. Test plan

### 36.1 Component tests

- `component()` does not resolve before the initial snapshot.
- Local event handler is installed before the remote subscribe call.
- An update concurrent with initial subscription cannot be missed.
- Duplicate snapshot ignored.
- Lower same-epoch revision ignored.
- New epoch accepted.
- Retired epoch ignored if a delayed frame arrives later.
- Same-turn `setState()` calls coalesce but local state updates immediately.
- Configured publish interval emits only the latest full snapshot.
- Reconnect replay produces a fresh snapshot.
- Target `peerGone` makes only that component stale.
- Global disconnect makes all channels stale.
- Last-known data remains readable while stale.
- Multiple `component()` users share one remote subscription.
- Removing one local observer does not unsubscribe the others.
- `$with()` retains component props/state/store behavior.
- Assignment to props/state throws.
- Unauthorized subscription receives no snapshot.
- Snapshot-size limit is enforced.
- Invalid self-snapshot is rejected before commit when validation is on.
- Component schema extraction resolves generics.
- Compatibility checks use output/event direction.
- Introspection reports component metadata but no internal event.
- Base component helpers are never remotely exposed without decorators.
- JSON and MsgPack transport paths.
- Socket.IO and MQTT 5 behavior parity.
- Browser-hosted server component.

### 36.2 Queue state-machine tests

- FIFO within priority.
- Higher priority selected first.
- Duplicate task ID returns original receipt.
- Deduplication key behavior and retention expiry.
- Task TTL before acquire.
- Capacity race with concurrent producers.
- Ready-task and ready-byte bounds never exceeded.
- Oversized payload rejected.
- Acquire-ID retry returns the same lease.
- One task cannot hold two live lease tokens.
- Complete with stale token rejected.
- Fail with stale token rejected.
- Renew with stale token rejected.
- Lease expiry requeues.
- Handler failure increments attempt.
- Maximum attempts dead-letters.
- Dead-letter retry generates a fresh ready transition.
- Expired delayed task does not return to ready.
- Consumer concurrency is respected.
- Faster consumer naturally processes more without exceeding limits.
- Long poll returns empty at its bound.
- RPC timeout margin works at the edge.
- Consumer close drains or aborts according to options.
- Transport loss during acquire.
- Transport loss after lease and before complete.
- Duplicate complete/fail requests are idempotent.
- Memory store reports and exhibits restart loss.
- Fake durable store survives service reconstruction.
- Authorization separates producer, consumer, and admin.
- Opaque byte payload round-trips unchanged.
- Failure strings and headers remain bounded.

### 36.3 Transport tests

Run the same queue conformance suite over:

- in-process modules;
- Socket.IO;
- MQTT 5 with Mosquitto;
- MQTT 5 with EMQX;
- reconnect and broker restart;
- MsgPack and JSON where the payload type permits JSON.

Do not silently skip broker tests in CI.

### 36.4 Load and soak tests

- producers faster than consumers for a sustained period;
- memory remains bounded at configured capacity;
- high consumer churn;
- lease-expiry storms;
- many empty long polls;
- dead-letter growth under poison tasks;
- metrics coalescing under high transition rates;
- thousands of component updates per second with a publish interval;
- a slow subscriber cannot crash the delivery loop.

---

## 37. Documentation structure

Add two guides:

```text
docs/observable-components.md
docs/work-queues.md
```

The component guide should explain:

- what belongs in methods, props, state, private fields, and events;
- stale versus live data;
- React integration without a React dependency;
- why state is a latest snapshot, not a stream;
- why setters/property assignment are not RPC.

The queue guide should begin with the primitive-selection table and clearly state:

- when current `sharedGroup` replicas already solve the problem;
- enqueue acceptance versus completion;
- at-least-once processing;
- lease and task IDs;
- memory-store limitations;
- queue capacity and producer response;
- why this is not RabbitMQ/Kafka replacement.

---

## 38. Review of the attached extension discussion

### Ideas retained

- Raw networked property assignment is ambiguous and lacks a natural asynchronous/error boundary.
- Cached `props` and `state` are a good fit for long-lived RPC instances.
- Props should be externally supplied and read-only to the instance's remote clients.
- State should be controlled by the instance and broadcast after change.
- Commands, events, and work queues are distinct communication patterns.
- A per-instance mailbox and a distributed work queue are different things.
- A work queue should be a separate service rather than overhead embedded in every pump, valve, or ordinary component.
- Queue backpressure must protect both consumers and the central backlog.
- `QueueFullError` is a useful producer-visible condition.
- Opaque MessagePack/byte payloads are useful, and routing metadata should remain outside opaque business bytes.
- Durable local spooling is a legitimate future store-and-forward layer.

### Ideas changed

- `dispatchCommand(string, payload)` is not adopted. Typed methods and declared method semantics are stronger.
- `ControlValue<T>` is not built into the generic component. Industrial quality/timestamp wrappers belong in domain libraries.
- Props are not universally defined as desired state, nor state universally as hardware reality.
- Source RPC is not renamed or reframed as a complete actor model.
- Topics are not modeled as actors in the core.
- `WorkQueuePush` and `WorkQueuePull` do not pretend to have the same guarantees.
- MQTT shared subscriptions are not treated as RabbitMQ-equivalent work queues.
- Receive Maximum is not treated as an application concurrency limit on its own.
- MQTT reason codes are not treated as a portable dead-letter mechanism.
- Message Expiry is not treated as a worker lease.
- “Zero-copy” is replaced with the narrower, supportable claims of opaque binary and avoiding framework deserialization.
- OPFS/IndexedDB spooling is deferred to a separate adapter layer.

### Assumption no longer current

The discussion repeatedly reasons from a hidden MQTT 3.1.1 transport. Source RPC 4.0 now defaults to MQTT 5, retains MQTT 3.1.1 as protocol-4 compatibility, and already exposes shared MQTT request groups for RPC replicas. The new design therefore starts from the current 4.0 capabilities rather than from the earlier fallback assumptions.

---

## 39. Acceptance criteria

The update is ready when all of the following are true.

### 4.1 components

- An unmodified ordinary RPC application observes no behavior change.
- A component client reads props/state synchronously after one awaited connection step.
- The initial snapshot cannot race with an update.
- Reconnect always converges on current full state.
- Staleness is visible and last-known data remains available.
- Component helpers cannot accidentally become exposed RPC methods.
- Component contracts appear in extraction, compatibility checks, and introspection.
- No React dependency is added.

### 4.2 queues

- The same public queue program passes over Socket.IO and MQTT 5.
- A task is never knowingly leased to two consumers at once.
- Stale completion cannot complete a newer lease.
- A crashed worker causes bounded redelivery.
- Poison tasks stop after the configured attempt count.
- Queue memory remains bounded by configured task/byte limits.
- Uncertain enqueue/acquire outcomes can be retried under stable identities.
- The memory store's loss characteristics are explicit.
- The framework makes no exactly-once, fairness, zero-copy, or broker-grade durability claim it cannot prove.

---

## 40. Final recommendation

Proceed with the React-inspired component concept, but make it an **observable snapshot extension to typed RPC**, not a replacement command model.

Proceed with queue support, but implement a **lease-based application service over Source RPC** as the portable baseline. Keep MQTT shared subscriptions in their existing, well-suited role for replicated request/reply services and reserve any direct shared-task primitive for a later, explicitly MQTT-specific API.

This path extends the package's distinctive strength: one honest programming model over browser-oriented Socket.IO links and MQTT 5 industrial networks, while keeping transport optimizations visible rather than turning them into leaky promises.

---

## References reviewed

- Source RPC repository and package README: `https://github.com/source-repo/rpc`
- Source RPC package metadata: `packages/rpc/package.json`, version 4.0.0
- Source RPC client and server handlers: `packages/rpc/src/RpcClient.ts`, `packages/rpc/src/RPC/RpcClientHandler.ts`, `packages/rpc/src/RPC/RpcServerHandler.ts`
- Source RPC schema and introspection: `packages/rpc/src/RPC/Schema.ts`, `packages/rpc/src/RPC/Introspection.ts`
- OASIS MQTT Version 5.0 specification: `https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html`
- MQTT.js README and `handleMessage` documentation: `https://github.com/mqttjs/MQTT.js/blob/main/README.md`
- Attached discussion: *Extending Soure RPC(1).pdf* (the filename contains the original spelling)
