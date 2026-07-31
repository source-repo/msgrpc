# Observable components

A long-lived instance whose state many peers want to *watch*, not poll. `RpcComponent<Props, State>` gives it two cached, read-only snapshots: `props` are the host's inputs — configuration, limits, a desired state where the domain uses that convention — and `state` is the instance's own public snapshot. Remote clients read both synchronously from a local cache and mutate neither: a client that wants the world to change calls a typed method, whose semantics, authorization, deadline and idempotency the library already carries.

```typescript
import { RpcComponent, rpc, rpcNamespace } from '@source-repo/rpc'

type OvenProps = { unit: string; maximum: number }
type OvenState = { temperature: number; mode: string }

@rpcNamespace('oven')
class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: '°C', maximum: 200 }, { temperature: 20, mode: 'idle' })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }
}

server.exposeClassInstance(new Oven())
```

`setState` takes a partial or an updater function; `replaceState` swaps the whole snapshot. Both are protected — the allow-list of `@rpc` marks is what keeps them off the wire — and commits made in one turn coalesce into one published snapshot. The host side controls props through `componentHost(instance).replaceProps()`, which nothing remote can reach.

## Observing one

```typescript
const oven = await client.component<Oven>('oven', 'ovenServer')

oven.props.unit          // synchronous, from the cache
oven.state.temperature   // likewise
await oven.setMode('heating')   // methods work exactly as on proxy()
```

`component()` resolves after the first snapshot has been accepted, so reads are synchronous from the first line that can execute. `RpcServer.component()` is the same call for a peer that both serves and calls — a browser page hosting a service observes over the link it already holds.

The store underneath is exposed via the `rpcComponent` symbol, and its shape is exactly what React's `useSyncExternalStore` consumes:

```typescript
import { rpcComponent } from '@source-repo/rpc'

const store = oven[rpcComponent]
store.getSnapshot()             // { epoch, revision, props, state, status, receivedAt, staleSince? }
const stop = store.subscribe(() => render())
await store.close()             // each component() call owes one close
```

## The status tells the truth

Every view carries `status: 'initializing' | 'live' | 'stale' | 'closed'`. A dropped link marks the picture **stale and keeps it readable** — "20 °C, stale since 14:03" is an answer and a blank is not — and a reconnect repairs it with one targeted snapshot rather than a replay. A restarted server is a new `epoch`, and the fresh snapshot replaces the old world; within one epoch, revisions only ever move forward, so a duplicate or delayed frame changes nothing.

Two observers of one component share one channel and one remote subscription; one leaving does not blind the other.

## Publishing bounds

Expose options bound what the network hears — local state always changes immediately:

```typescript
server.exposeClassInstance(oven, 'oven', {
    component: { minPublishIntervalMs: 250, maxSnapshotBytes: 1_048_576 }
})
```

`minPublishIntervalMs` coalesces publishes to at most one per interval, latest wins — conflation being the honest behaviour for state. `maxSnapshotBytes` is a tripwire for a waveform buffer wired into state by mistake; the commit succeeds, the publish is skipped and logged. High-rate telemetry belongs in events or a queue, not in a snapshot.

## In the contract

`extract` reads a component's `Props` and `State` through the base-type chain and writes them into the schema (`component: { snapshot: 1, props, state }`); an unresolved generic is a loud diagnostic, never a silent `any`. The compatibility checker treats both shapes as output — a component that stops being served, or widens what it may send, is named to the observer — and `describe()` reports structure plus a live observer count, never the values.

`validateComponentSnapshots: true` on the server checks each commit against the contract before it becomes current: an invalid `setState` throws at the call site — where the bug is — and the previous snapshot stays current.

## Reserved names

`$snapshot` is the event snapshots travel under, reserved the way `$with` is: served to authorized subscribers only, never listed in introspection. A component also answers `$acquire`/`$release` — see [Command authority](./authority.md).
