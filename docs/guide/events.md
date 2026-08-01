# Events and reconnection

An exposed instance that extends `EventEmitter` can push to subscribers:

```typescript
const plant = await client.proxy<Plant>('plant')
await plant.on('alarm', (message: string) => console.log(message))
await plant.off('alarm', handler)     // same handler reference
```

`RpcClient` is itself an `EventEmitter` reporting the state of its link, so an application can show it rather than infer it from failed calls:

```typescript
import { TransportEvent } from '@source-repo/rpc'

client.on(TransportEvent.disconnected, (reason) => console.log('link lost:', reason))
client.on(TransportEvent.connected, ({ restoredSubscriptions }) =>
    console.log('link back, subscriptions restored:', restoredSubscriptions))
```

Reconnection is handled for you:

- The underlying transport reconnects on its own (socket.io and mqtt.js both do).
- On every reconnect the client replays its event subscriptions. This restores server-side state if the server restarted, and re-identifies the client so pushed events reach it again.
- Replaying is idempotent: the server will not stack a second listener for a subscription it already holds.
- When a client's connection drops, the server releases the event subscriptions it held for it.
- An event is delivered only to subscriptions taken out on the peer and namespace it came from. Watching `alarm` on two instances, or on two peers over one MQTT transport, keeps them apart.
- `off()` is not subject to `authorize`: a subscription is keyed by the peer that made it, so a peer can only drop its own, and refusing to let someone stop receiving events would be strange.

## Counting what fired, watched or not

A server keeps an emission counter per `(namespace, event)` — started at expose time for every event the schema declares, and at first subscription or first ask for one it does not — running whether or not anyone is subscribed. Each delivery is stamped with its position (`seq`) and the server's incarnation (`epoch` — the component channel's discipline, applied server-wide: a sequence only orders within one life). `msgrpc.eventCursor(namespace, event)` reads the counter, riding the same `exposeIntrospection` opt-in and the same `authorize()` gate as `describe()`, because how often a device fires an alarm is process information of the same order as what it serves.

What this buys is loss-awareness for anything that watches in windows rather than holding a subscription forever: compare the cursor across two looks and "saw nothing" splits into "saw nothing and missed nothing" and "saw nothing but three fired" — and across a restart the epochs differ, so the honest answer is "cannot know", stated rather than guessed. The MCP server's `watch_events` reports exactly this. A subscription held open needs none of it; deliveries on a live link are not sampled, and the counter costs one listener per tracked event.
