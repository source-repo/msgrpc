# Structural context

Inherited, cached, versioned ambient data, resolved through exactly one declared topology axis. Context normally carries *refs to authorities* and slow identifiers — the plant id, the current work order, where the historian is — not live values: high-rate data stays in component state, and shared mutable state stays in an authoritative component changed through typed methods.

```typescript
import { defineRpcContext, HOST_ROOT } from '@source-repo/rpc'

const PlantContext = defineRpcContext<{ plantId: string; pressureUnit: string }>({
    id: 'acme.plant',              // globally stable, namespaced - an id, so control chars refused
    schemaVersion: '1',
    axis: 'physical',              // exactly one axis; there is no logical-then-physical search
    capture: 'explicit'            // may be captured into a payload; the default is 'never'
})

// The plant host provides it at its root; the handle is ownership - nothing remote reaches it.
const handle = plantHost.provideContext(HOST_ROOT, PlantContext, { plantId: 'site-7', pressureUnit: 'bar' })
handle.set({ plantId: 'site-7', pressureUnit: 'kPa' })
```

At most one provider per (node, token); a restarted provider is a new provider epoch, so the new world never continues the old one's revision count.

## Resolving

Resolution walks the token's axis — the physical chain root to root across hosts, the logical chain through remote owners — nearest provider first, or `resolution: 'collect'` for the whole chain in order, never merged:

```typescript
const store = machineHost.contextOf('oven', PlantContext)
store.getSnapshot()      // { status, mountEpoch, entry?, entries?, previous?, transitionReason?, ... }

const value = machineHost.requireContext('oven', PlantContext)   // the policy gate
```

The status vocabulary is `initializing | live | stale | missing | invalid | closed`, with a `transitionReason` (`initial-load`, `owner-remount`, `parent-remount`, `reconnect`):

- **stale** keeps its narrow meaning: the same mount, freshness unknown — the last value stays readable with its age on it, and a reconnect repairs it.
- **missing** is a complete chain with no provider — never a guess from the other axis.
- **invalid** carries `cycle` (with the ring's path), `depth-exceeded`, or `invalid-reference`. `require()` fails closed on it regardless of any stale policy.
- An owner reassignment is an **atomic remount**: a new mount epoch, never a mixture of old and new scope, and the old world survives only as `previous` — which `require()` never returns.

Twenty tokens inherited over one upstream host cost one subscription; two stores of one token share everything.

## Capture

A caller may deliberately package what a node currently sees, for a payload:

```typescript
const captured = server.captureContext('oven', [PlantContext, WorkOrderContext])
```

Only tokens declaring `capture: 'explicit'` may leave their chain; `exposure: 'local'` values never leave the host at all; and the aggregate is size-bounded before anything accepts it. Captured context is evidence — what the caller saw when it decided — never authorization.

## The wire, and its authorization

The `$context` protocol (read / subscribe / unsubscribe, register-then-snapshot, full frames only) is served at the dispatch level. Every call passes `authorize()` with the node and every requested token id visible in params; there is no enumeration surface, so a caller must already know a token's id; and a token whose provider declares `exposure: 'local'` is filtered from remote answers *silently* — a refusal would confirm the secret exists.

`RpcClient.readContext(peer, node, tokenIds)` is the one-shot form, for tools — and for [the work queue's `latest` task context](https://github.com/source-repo/rpc/blob/main/packages/queue/README.md), which resolves the source host's context when execution starts.
