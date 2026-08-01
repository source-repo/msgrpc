# Connecting

Before the table: it is worth ten lines on what a network of these looks like, because everything below follows from one idea.

**An `RpcServer` exposes methods; an `RpcClient` calls them.** For a single link that is the whole API, and the quick start above has already shown it.

The rest comes from this: **a peer is anything on the network with a name**, and a frame is addressed to a *name*, not to a socket. A server has a name, a client has a name. Once addressing works that way, three things follow:

- **A server can call as well as answer.** `RpcServer.proxy()` is the same call as the client's, and hands back the same typed object — it just travels over a link the server already has.
- **A server can relay.** A frame addressed to a name it is not, but can see, is passed along instead of executed. That is what makes a peer reachable *through* another peer.
- **A peer that only relays is a bus.** Nothing else is needed to build one.

So a **bus** — hub, broker, switchboard, whichever word you prefer — is not a different kind of program. It is an `RpcServer` that exposes nothing and forwards everything. An MQTT broker plays exactly the same part for an MQTT network; msgrpc just does not require you to have one.

The server's `transports` say where it listens; the client's url says where to reach it.

| server | client |
| --- | --- |
| `new RpcServer()` | `new RpcClient()` — socket.io on port 7843, the default on both sides |
| `transports: [{ port: 8080 }]` (also `tls`, `path`) | `new RpcClient('http://host:8080')` |
| `transports: [{ server: httpServer }]` | `new RpcClient(origin)` — share an `http.Server` you already have, so the page and its RPC arrive on one port |
| `transports: [{ brokerurl: 'mqtt://broker:1883' }]` | `new RpcClient('mqtt://broker:1883', { defaultTarget: 'plantServer' })` |

**7843 is the Source RPC port**, exported as `defaultWebSocketPort`, and 7844 — `defaultWebPort` — is where anything serving a browser puts its HTTP port. Adjacent rather than an offset apart, because they are read together. Both are deliberately clear of the 80xx range, where a developer's other work already is.

| | | |
| --- | --- | --- |
| `1883` | | MQTT |
| `8083` | | MQTT over WebSocket |
| `7843` | `rpc` | Source RPC — an `RpcServer`, or `source-rpc broker` |
| `7844` | `console` | Source RPC console, or anything else of yours serving a page |
| `8843` | `rpc-tls` | the same, with a certificate |
| `8844` | `console-tls` | |

The encrypted pair is a thousand above rather than beside: the last two digits still match, so it is one number to remember with a rule attached, but **no range covers a plain port and an encrypted one**. `allow 7843:7846` is the firewall rule somebody writes at the end of a long day, and it must not be able to publish the clear-text bus by fencepost while meaning to open only the encrypted one. MQTT draws the same line between 1883 and 8883, so the habit transfers.

These say where to *find* a service; nothing enforces them. A port carries TLS because it was given a certificate, never because of its number — and the CLI's `--cert`/`--key` move a server to its encrypted port on their own, so the convention holds without anyone having to remember it.

**One process needs one port.** `{ server: httpServer }` above is how a page and its RPC arrive together: socket.io answers `/socket.io` on that listener and your own handler serves everything else. The console is built exactly this way. The second number is for running two programs on one host.

A server may hold several at once, serving the same exposed instances to each. One server can face a browser over socket.io and a plant network over MQTT:

```typescript
const server = new RpcServer({
    name: 'plantServer',
    transports: [{ port: 8080 }, { brokerurl: 'mqtt://broker:1883' }]
})
server.exposeClassInstance(new Plant(), 'plant')     // reachable over both
```

### A bus without a broker

Here is that bus, in full. It exposes nothing, so every frame that reaches it is addressed to somebody else and gets forwarded. Everything else dials *it*, and gets what MQTT would have given them: presence, addressing by name, and any peer able to call any other.

```typescript
const bus = new RpcServer({ name: 'bus', transports: [{ port: 7843 }] })

const cellSrv = new RpcServer({ name: 'cellSrv', transports: [{ connect: 'http://bus:7843' }] })
cellSrv.exposeClassInstance(new Cell(), 'cell')

// The same object calls back out, over the same connection and under the same name.
const oven = await cellSrv.proxy<Oven>('oven', 'ovenSrv')
await oven.temperature()
```

Read the last two lines again, because they are the part that surprises people. `cellSrv` is a *server* — and it is calling out. `RpcServer.proxy()` takes the name of a namespace and the name of the peer holding it, and returns the same typed object `RpcClient.proxy()` would. The call leaves over the connection `cellSrv` already opened to the bus, the bus forwards it to `ovenSrv`, and the answer comes back the same way.

Nothing here dialled `ovenSrv` directly. It may not even be dialable — it could be a browser tab. The bus is what they have in common, and that is enough.

### One peer, several links

A peer holds one link per transport, and the two kinds are not interchangeable:

| transport | connections |
| --- | --- |
| `{ port }` / `{ server }` | **accepts** many — every peer that dials in |
| `{ connect: url }` | **opens** exactly one, to that url |
| `{ brokerurl }` | opens one, to that broker |

A socket cannot both accept and dial, so a Node service that serves browsers *and* joins a bus genuinely holds two:

```
browsers ──▶ :8080 ┐
                   ├─ nodeSrv ──▶ ws://bus:9000
                   ┘
```

But **every link carries traffic both ways**. `proxy()` picks whichever transport reaches the target, so:

- calling a browser that dialled in costs no new connection — the frame goes back down the socket that browser opened;
- calling a peer on the bus goes out over the link `nodeSrv` already holds.

Which is why a peer that both serves and calls needs no `RpcClient` at all. Adding one to do the calling would open a *third* connection and put a second name on the network for what is really one program — and over MQTT, that means a second broker session too.

### Serving over a connection you open

A browser cannot listen, so a page that wants to *host* a service has to dial out. `connect` gives an `RpcServer` an outbound link, and it serves over it exactly as it would over one it accepted:

```typescript
const panel = new RpcServer({ name: 'cellPanel', transports: [{ connect: 'https://hub.plant' }] })
panel.exposeClassInstance(new Cell(), 'cell')        // now callable, from a browser tab
```

Whatever it connects to relays calls to it — see [Discovery](./connecting.md#discovery).

### Names and targets

Every peer has a `name`. A server's name is how callers address it; a client's name is how the server routes events back and, when authenticating, who it is.

Over a single socket there is one server, so the default target `'*'` finds it and names can be left alone. Over a broker there are many, so a caller has to say which — either once, with `defaultTarget`, or per proxy:

```typescript
const plant = await client.proxy<Plant>('plant', 'plantServer')
```

Client names must be unique among the peers sharing a server; the default is three words - `brisk-otter-cable` - rather than a UUID, because a name is also a log line, a peer-list entry and an MQTT client id, and a UUID tells you nothing in any of them. Over MQTT a name is also the broker client id, and a broker allows one connection per id, so two peers sharing a name disconnect each other in a loop.

### Discovery

Every peer announces its name when it connects, and is told who else is there. The events are the same on both transports, so code that watches a network does not care which one it is on:

```typescript
transport.on(TransportEvent.peerOnline, (peer) => console.log(peer, 'is up'))
transport.on(TransportEvent.peerGone, (peer) => console.log(peer, 'is gone'))
```

Over MQTT this is retained presence: subscribing to `<prefix>/presence/+` hands over everyone already online, and a last will covers a peer that dies rather than leaves. Over socket.io the server keeps the list and sends it to each peer that announces itself.

Presence also carries a short **hash of each server's described surface**, so anything caching a `describe()` answer can tell a restart that changed the surface from one that did not — without anything describing on sight. The hash covers what a cached description answers questions about (namespaces, methods, signatures, semantics, declared events, versions, capabilities) and deliberately not what moves on its own (subscriber counts, topology epochs). A change arrives as `TransportEvent.peerShape`, emitted only on an actual change, and the latest hash is readable from the peer registry as `peers.shapeOf(name)`. Over socket.io it rides announcements and the hub's snapshots; over MQTT 5 it is a user property beside the retained `online` payload, which older peers never look at — on MQTT 3.1.1 it simply does not travel. The console and the MCP server use it to drop their describe caches the moment a peer reshapes, and to pay nothing for one that did not.

**`ready()` means the link is up, not that anyone has been heard from.** Presence arrives a moment after the connection does, so asking who is there immediately finds an empty network on a bus that is plainly there — and every script that hit this grew the same poll-for-peers loop. `peersSettled()` is that loop, done once and honestly:

```typescript
const others = await peer.peersSettled()      // ready(), then the first presence sweep
```

It resolves when the first sweep has landed — the retained burst read on MQTT, the announced list delivered on socket.io — and returns the names known at that moment, its own excluded. Settled means exactly that: the first picture has arrived, not that every peer that will ever exist has. A peer that joins a second from now still appears a second from now, a network with nobody on it settles empty, and the default two-second bound resolves rather than throws, because on a slow broker the names known then are still worth more than an error. It exists on both `RpcClient` and `RpcServer`; when a *named* peer is what you are waiting for, `awaitPeer(name)` is the sharper question.

**A name is an address, so two peers must not share one.** Both transports report a collision as `TransportEvent.peerDisplaced`, and warn once. The newcomer takes the address either way: a peer reconnecting after a blip announces itself while the old connection may still look live, and refusing it would lock a peer out of its own name. What the event is for is the other case — two peers genuinely running under one name send each other's replies into the wrong place, which reads as calls timing out for no reason and is close to undiagnosable if nothing says so.

Which end finds out differs, because the two protocols enforce it in different places. Over socket.io the **server** sees a second connection announce a name it already holds. Over MQTT there is no server in the middle and nothing has to detect anything: the client id is derived from the peer name, so the broker hands the session over and tells the **displaced peer** why, with reason code `0x8E` — which needs MQTT 5, since 3.1.1 has no reason codes and the connection simply closes.

**A server relays for the peers connected to it.** A frame addressed to another peer it can see is forwarded rather than executed locally, which is what makes a peer that can only dial out reachable at all. A server holding both a socket.io listener and a broker connection therefore bridges them: a browser peer discovers a peer that exists only on the broker, and calls it, with the call arriving under the browser peer's own name rather than the bridge's.

```typescript
const bridge = new RpcServer({
    name: 'bridge',
    transports: [{ port: 8080 }, new MqttTransport('bridge', 'mqtt://broker:1883')]
})
```

Relaying is on by default. `relay: false` forwards nothing, and a predicate decides per connection:

```typescript
const hub = new RpcServer({
    name: 'hub',
    transports: [{ port: 8080 }],
    authenticate,
    relay: ({ identity, target }) => identity?.roles?.includes('engineer') || target === 'readOnlyGateway'
})
```

The rule is asked once per pair of peers, and the answer covers the traffic going back — a call has a reply and usually events after it, and a rule written about the caller would otherwise strand them. Without `authenticate`, a relaying server prints a warning the first time it forwards anything: `source` is a claim until a connection vouches for it, so it passes on whatever it is told.

### More than one hop

A peer announces not only its own name but the peers reachable **through** it, so a server that is a hub for its own peers and a member of a bus makes both sides visible to each other:

```
panel1 ── cellCtl ── bus ── hmi
```

`cellCtl` advertises `panel1` upwards; the bus routes to `panel1` by handing frames to `cellCtl`, which passes them inwards. Calls, replies and events all traverse it, and `panel1` leaving propagates the same way. Covered by a test at two hops.

Two rules keep that from eating itself:

- **Split horizon.** A peer is never advertised back along the link it was learned from, and the list a server hands a newly connected peer excludes whatever that peer reaches for it. Without either, two hubs each conclude the other is the way to a peer and it disappears from everyone further out.
- **A hop limit.** Frames carry a count and are dropped after 8 relays. Split horizon keeps a tree's tables loop-free, but a mesh that has just lost a link can hold a cycle until the tables settle, and a frame going round one never stops on its own.

A peer offered by two links keeps the first; the second is remembered, and used if the first goes away. A peer announcing *itself* always wins over one merely carried.

**What relaying is not.** It does not make a server a broker in the MQTT sense. There is no store-and-forward, no queueing for a peer that is not connected, and no fan-out — a frame is passed to one peer that is there now, or refused - answered with a `TransportError` back down the link it arrived on, and reported as `unroutable` here. Refused rather than dropped, because a caller only ever saw a drop as an unexplained timeout. Discovery is not a routing protocol either: there are no metrics and no shortest path, only reachability.

### Ready and close

`await server.ready()` and `await client.ready()` resolve when every transport is connected, and throw after `readyTimeout` (30 s; `0` waits forever) rather than hanging with no diagnostic. Expose your instances *before* `ready()`: a resumed MQTT session is handed its queued requests the moment it connects.

`await client.close()` rejects any in-flight calls at once instead of leaving them to time out, and forgets the subscriptions it held. `await server.close()` closes every transport, which is what tells the peers on the other side that it went away.

### Encoding

MsgPack by default, so `Uint8Array` and `Date` cross the wire as themselves rather than as string encodings of themselves. `useMsgPack: false` selects JSON on both sides — readable in a broker inspector, at the cost of those two types. Both ends must agree.

## Peer routing

Each `RpcServer` and `RpcClient` owns a `PeerRegistry`, shared by its own modules and nothing wider: transports record which peer a message arrived from, and the switch reads it back to send the reply out of the same transport. Entries are dropped when a peer disconnects, and the registry is bounded, since the keys arrive from remote peers.

Peer names must be unique within one graph. Across separate `RpcServer` instances they do not interfere.
