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

## Asking about another peer's node

`contextOf()` answers for a node this host holds, which is what code that *acts* on context needs. An operator's console is the other case: it asks about a node it does not own.

```typescript
const store = server.contextAt({ peer: 'bakery', instance: 'oven' }, PlantContext)
```

Same store, same statuses, same `close()`. What differs is only where the chain begins — and that is all it needs to differ, because the chain machinery does not care: a hop is a hop, the origin's own host answers the first one, and continuations are followed from there exactly as they are for a local node, including the cycle and depth checks that only the origin can make.

**It is for observing, never for deciding.** Code that depends on context should ask about its own node with `contextOf()`, because a decision taken from another node's ambient data is a decision taken on the wrong node's behalf.

The alternative a console would otherwise reach for is grafting itself into the topology beside the node it wants to read — which is a claim about the plant that happens to be false, visible to every other peer, and which physical edges refuse anyway, since they cross hosts only root to root. This is that need met honestly instead.

Both the console's context panel and the MCP server's [`read_context`](../tools/mcp.md#what-a-node-inherits) are this call and nothing more. A tool that quietly disagreed with the library about what a node sees would be worse than one that could not show it at all.

## Capture

A caller may deliberately package what a node currently sees, for a payload:

```typescript
const captured = server.captureContext('oven', [PlantContext, WorkOrderContext])
```

Only tokens declaring `capture: 'explicit'` may leave their chain; `exposure: 'local'` values never leave the host at all; and the aggregate is size-bounded before anything accepts it. Captured context is evidence — what the caller saw when it decided — never authorization.

## The wire, and its authorization

The `$context` protocol (read / subscribe / unsubscribe, register-then-snapshot, full frames only) is served at the dispatch level. Every call passes `authorize()` with the node and every requested token id visible in params; there is no enumeration surface, so a caller must already know a token's id; and a token whose provider declares `exposure: 'local'` is filtered from remote answers *silently* — a refusal would confirm the secret exists.

`RpcClient.readContext(peer, node, tokenIds)` is the one-shot form, for tools — and for [the work queue's `latest` task context](https://github.com/source-repo/rpc/blob/main/packages/queue/README.md), which resolves the source host's context when execution starts.
