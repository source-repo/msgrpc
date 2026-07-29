```
███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗███████╗
██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝██╔════╝
███████╗██║   ██║██║   ██║██████╔╝██║     █████╗
╚════██║██║   ██║██║   ██║██╔══██╗██║     ██╔══╝
███████║╚██████╔╝╚██████╔╝██║  ██║╚██████╗███████╗
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝
██████╗ ██████╗  ██████╗
██╔══██╗██╔══██╗██╔════╝
██████╔╝██████╔╝██║
██╔══██╗██╔═══╝ ██║
██║  ██║██║     ╚██████╗
╚═╝  ╚═╝╚═╝      ╚═════╝
```

# @source-repo/rpc

Source RPC — TypeScript RPC over socket.io and MQTT 5. A class is the contract: the server hands one live instance
to `exposeClassInstance`, the client gets a typed proxy of the same class, and calling a method on
the proxy runs it on that instance. No code generation and no schema files required, though there is
a schema when you want arguments checked at runtime.

```
npm install @source-repo/rpc
```

ESM only, Node 18.17 or later, and it runs in the browser. Contracts can be extracted from your
source and checked for breaking changes with [`@source-repo/rpc-cli`](https://www.npmjs.com/package/@source-repo/rpc-cli), which also serves
a browser console for a live network.

Upgrading from 1.x? [`CHANGELOG.md`](https://github.com/source-repo/msgrpc/blob/main/CHANGELOG.md) lists what breaks.

## Quick start

The class both sides share. Nothing here is msgrpc-specific — no decorators, no base class:

```typescript
// calculator.ts
export class Calculator {
    private memory = 0

    async square(n: number) {
        return n * n
    }

    async add(n: number) {
        this.memory += n
        return this.memory
    }
}
```

The server. With no transports configured it listens on WebSocket (socket.io) port 3000:

```typescript
import { RpcServer } from '@source-repo/rpc'
import { Calculator } from './calculator.js'

const server = new RpcServer()
server.exposeClassInstance(new Calculator(), 'calculator')
await server.ready()
```

A client, in another Node process, a browser page, or the same process for testing:

```typescript
import { RpcClient } from '@source-repo/rpc'
import type { Calculator } from './calculator.js'    // the type only - see below

const client = new RpcClient('http://localhost:3000')
await client.ready()

const calculator = await client.proxy<Calculator>('calculator')
console.log(await calculator.remote!.square(3))      // 9
console.log(await calculator.remote!.add(10))        // 10
console.log(await calculator.remote!.add(5))         // 15 - one instance, holding its own state

await client.close()
```

Three things worth noticing:

**The instance is a real, long-lived object.** It is constructed once, by you, and every call runs
against that same object — which is why `add` accumulates. State lives where you would put it
anyway, in fields. Nothing is constructed or discarded per call, and the instance you passed in is
still yours to read and mutate locally. (A class can instead be *registered* for peers to
instantiate remotely, but that is off by default and rarely what you want — see
[The management surface](#the-management-surface).)

**`import type`** on the client is the point of the whole design: the client compiles against the
class but imports none of its code, so the implementation never reaches the browser bundle. In a
monorepo, put the class in a package both sides depend on. If the client cannot see the class at
all — a different language, a different repo — describe the surface with an `interface` instead and
pass that to `proxy<T>()`.

**`.remote!`** — `proxy()` returns a small record (`{ name, target?, remote? }`) whose `remote` is
the typed proxy. The field is optional in the type because the record is assembled piece by piece;
`proxy()` awaits `ready()` first, so what it hands back always has one, hence the `!`.

## Connecting

Before the table: it is worth ten lines on what a network of these looks like, because everything
below follows from one idea.

**An `RpcServer` exposes methods; an `RpcClient` calls them.** For a single link that is the whole
API, and the quick start above has already shown it.

The rest comes from this: **a peer is anything on the network with a name**, and a frame is
addressed to a *name*, not to a socket. A server has a name, a client has a name. Once addressing
works that way, three things follow:

- **A server can call as well as answer.** `RpcServer.proxy()` is the same call as the client's, and
  hands back the same typed object — it just travels over a link the server already has.
- **A server can relay.** A frame addressed to a name it is not, but can see, is passed along
  instead of executed. That is what makes a peer reachable *through* another peer.
- **A peer that only relays is a bus.** Nothing else is needed to build one.

So a **bus** — hub, broker, switchboard, whichever word you prefer — is not a different kind of
program. It is an `RpcServer` that exposes nothing and forwards everything. An MQTT broker plays
exactly the same part for an MQTT network; msgrpc just does not require you to have one.

The server's `transports` say where it listens; the client's url says where to reach it.

| server | client |
| --- | --- |
| `new RpcServer()` | `new RpcClient()` — socket.io on port 3000, the default on both sides |
| `transports: [{ port: 8080 }]` (also `tls`, `path`) | `new RpcClient('http://host:8080')` |
| `transports: [{ server: httpServer }]` | `new RpcClient(origin)` — share an `http.Server` you already have, so the page and its RPC arrive on one port |
| `transports: [{ brokerurl: 'mqtt://broker:1883' }]` | `new RpcClient('mqtt://broker:1883', { defaultTarget: 'plantServer' })` |

A server may hold several at once, serving the same exposed instances to each. One server can face a
browser over socket.io and a plant network over MQTT:

```typescript
const server = new RpcServer({
    name: 'plantServer',
    transports: [{ port: 8080 }, { brokerurl: 'mqtt://broker:1883' }]
})
server.exposeClassInstance(new Plant(), 'plant')     // reachable over both
```

### A bus without a broker

Here is that bus, in full. It exposes nothing, so every frame that reaches it is addressed to
somebody else and gets forwarded. Everything else dials *it*, and gets what MQTT would have given
them: presence, addressing by name, and any peer able to call any other.

```typescript
const bus = new RpcServer({ name: 'bus', transports: [{ port: 8080 }] })

const cellSrv = new RpcServer({ name: 'cellSrv', transports: [{ connect: 'http://bus:8080' }] })
cellSrv.exposeClassInstance(new Cell(), 'cell')

// The same object calls back out, over the same connection and under the same name.
const oven = await cellSrv.proxy<Oven>('oven', 'ovenSrv')
await oven.remote!.temperature()
```

Read the last two lines again, because they are the part that surprises people. `cellSrv` is a
*server* — and it is calling out. `RpcServer.proxy()` takes the name of a namespace and the name of
the peer holding it, and returns the same typed object `RpcClient.proxy()` would. The call leaves
over the connection `cellSrv` already opened to the bus, the bus forwards it to `ovenSrv`, and the
answer comes back the same way.

Nothing here dialled `ovenSrv` directly. It may not even be dialable — it could be a browser tab.
The bus is what they have in common, and that is enough.

### One peer, several links

A peer holds one link per transport, and the two kinds are not interchangeable:

| transport | connections |
| --- | --- |
| `{ port }` / `{ server }` | **accepts** many — every peer that dials in |
| `{ connect: url }` | **opens** exactly one, to that url |
| `{ brokerurl }` | opens one, to that broker |

A socket cannot both accept and dial, so a Node service that serves browsers *and* joins a bus
genuinely holds two:

```
browsers ──▶ :8080 ┐
                   ├─ nodeSrv ──▶ ws://bus:9000
                   ┘
```

But **every link carries traffic both ways**. `proxy()` picks whichever transport reaches the
target, so:

- calling a browser that dialled in costs no new connection — the frame goes back down the socket
  that browser opened;
- calling a peer on the bus goes out over the link `nodeSrv` already holds.

Which is why a peer that both serves and calls needs no `RpcClient` at all. Adding one to do the
calling would open a *third* connection and put a second name on the network for what is really one
program — and over MQTT, that means a second broker session too.

### Serving over a connection you open

A browser cannot listen, so a page that wants to *host* a service has to dial out. `connect` gives
an `RpcServer` an outbound link, and it serves over it exactly as it would over one it accepted:

```typescript
const panel = new RpcServer({ name: 'cellPanel', transports: [{ connect: 'https://hub.plant' }] })
panel.exposeClassInstance(new Cell(), 'cell')        // now callable, from a browser tab
```

Whatever it connects to relays calls to it — see [Discovery](#discovery).

### Names and targets

Every peer has a `name`. A server's name is how callers address it; a client's name is how the
server routes events back and, when authenticating, who it is.

Over a single socket there is one server, so the default target `'*'` finds it and names can be left
alone. Over a broker there are many, so a caller has to say which — either once, with
`defaultTarget`, or per proxy:

```typescript
const plant = await client.proxy<Plant>('plant', 'plantServer')
```

Client names must be unique among the peers sharing a server; the default is a UUID, which is unique
but tells you nothing in a log. Over MQTT a name is also the broker client id, and a broker allows
one connection per id, so two peers sharing a name disconnect each other in a loop.

### Discovery

Every peer announces its name when it connects, and is told who else is there. The events are the
same on both transports, so code that watches a network does not care which one it is on:

```typescript
transport.on(TransportEvent.peerOnline, (peer) => console.log(peer, 'is up'))
transport.on(TransportEvent.peerGone, (peer) => console.log(peer, 'is gone'))
```

Over MQTT this is retained presence: subscribing to `<prefix>/presence/+` hands over everyone
already online, and a last will covers a peer that dies rather than leaves. Over socket.io the
server keeps the list and sends it to each peer that announces itself.

**A name is an address, so two peers must not share one.** Both transports report a collision as
`TransportEvent.peerDisplaced`, and warn once. The newcomer takes the address either way: a peer
reconnecting after a blip announces itself while the old connection may still look live, and
refusing it would lock a peer out of its own name. What the event is for is the other case — two
peers genuinely running under one name send each other's replies into the wrong place, which reads
as calls timing out for no reason and is close to undiagnosable if nothing says so.

Which end finds out differs, because the two protocols enforce it in different places. Over
socket.io the **server** sees a second connection announce a name it already holds. Over MQTT there
is no server in the middle and nothing has to detect anything: the client id is derived from the
peer name, so the broker hands the session over and tells the **displaced peer** why, with reason
code `0x8E` — which needs MQTT 5, since 3.1.1 has no reason codes and the connection simply closes.

**A server relays for the peers connected to it.** A frame addressed to another peer it can see is
forwarded rather than executed locally, which is what makes a peer that can only dial out reachable
at all. A server holding both a socket.io listener and a broker connection therefore bridges them:
a browser peer discovers a peer that exists only on the broker, and calls it, with the call arriving
under the browser peer's own name rather than the bridge's.

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

The rule is asked once per pair of peers, and the answer covers the traffic going back — a call has
a reply and usually events after it, and a rule written about the caller would otherwise strand
them. Without `authenticate`, a relaying server prints a warning the first time it forwards
anything: `source` is a claim until a connection vouches for it, so it passes on whatever it is
told.

### More than one hop

A peer announces not only its own name but the peers reachable **through** it, so a server that is a
hub for its own peers and a member of a bus makes both sides visible to each other:

```
panel1 ── cellCtl ── bus ── hmi
```

`cellCtl` advertises `panel1` upwards; the bus routes to `panel1` by handing frames to `cellCtl`,
which passes them inwards. Calls, replies and events all traverse it, and `panel1` leaving
propagates the same way. Verified to three hops.

Two rules keep that from eating itself:

- **Split horizon.** A peer is never advertised back along the link it was learned from, and the
  list a server hands a newly connected peer excludes whatever that peer reaches for it. Without
  either, two hubs each conclude the other is the way to a peer and it disappears from everyone
  further out.
- **A hop limit.** Frames carry a count and are dropped after 8 relays. Split horizon keeps a tree's
  tables loop-free, but a mesh that has just lost a link can hold a cycle until the tables settle,
  and a frame going round one never stops on its own.

A peer offered by two links keeps the first; the second is remembered, and used if the first goes
away. A peer announcing *itself* always wins over one merely carried.

**What relaying is not.** It does not make a server a broker in the MQTT sense. There is no
store-and-forward, no queueing for a peer that is not connected, and no fan-out — a frame is passed
to one peer that is there now, or reported as `unroutable`. Discovery is not a routing protocol
either: there are no metrics and no shortest path, only reachability.

### Ready and close

`await server.ready()` and `await client.ready()` resolve when every transport is connected, and
throw after `readyTimeout` (30 s; `0` waits forever) rather than hanging with no diagnostic. Expose
your instances *before* `ready()`: a resumed MQTT session is handed its queued requests the moment it
connects.

`await client.close()` rejects any in-flight calls at once instead of leaving them to time out, and
forgets the subscriptions it held. `await server.close()` closes every transport, which is what
tells the peers on the other side that it went away.

### Encoding

MsgPack by default, so `Uint8Array` and `Date` cross the wire as themselves rather than as string
encodings of themselves. `useMsgPack: false` selects JSON on both sides — readable in a broker
inspector, at the cost of those two types. Both ends must agree.

## Exposing methods

`exposeClassInstance` walks the prototype chain and publishes every function it finds, so a helper
a class never meant to offer becomes callable by anyone who can reach the transport. Marking the
intended methods turns that into an allow-list.

```typescript
import { rpc, rpcNamespace } from '@source-repo/rpc'

@rpcNamespace('plant', { version: '2' })
class Plant {
    @rpc async writeSetpoint(value: number) { ... }
    @rpc async readSetpoint() { ... }
    async wipeConfiguration() { ... }        // unmarked, so unreachable
}

server.exposeClassInstance(new Plant())      // name taken from @rpcNamespace
```

Standard ECMAScript decorators, so no `experimentalDecorators` is needed. Marks are inherited, so a
subclass keeps its parent's. Without decorators, `exposeMethods(Plant, ['writeSetpoint'])` does the
same and rejects names that are not methods.

A class that marks nothing publishes every method on its prototype chain, which is what makes the
plain style above work. Set `requireExplicitExposure` on `RpcServer` to refuse such a class instead,
which makes the discipline enforceable across a project.

`@rpcNamespace` also tells the extraction CLI which namespace a class belongs to, since the name
would otherwise exist only at the `exposeClassInstance` call site.

### More than one, and without a class

A server exposes as many namespaces as you like, and a client takes a proxy per namespace:

```typescript
server.exposeClassInstance(new Plant(), 'plant')
server.exposeClassInstance(new History(), 'history')
server.exposeObject({ ping: () => 'pong' }, 'health')      // a plain object's own functions

const plant = await client.proxy<Plant>('plant')
const history = await client.proxy<History>('history')
```

`exposeObject` publishes an object's own function properties rather than a prototype chain, which
suits a handful of functions that never wanted to be a class.

## Errors

A call rejects with an `RpcError` carrying a `code`, the remote `message`, and the remote stack in
`remoteStack` when the peer sent one.

```typescript
import { RpcError } from '@source-repo/rpc'

try {
    await calculator.remote!.square(3)
} catch (e) {
    if (e instanceof RpcError) console.log(e.code, e.message, e.remoteStack)
}
```

| code | meaning |
| --- | --- |
| `Exception` | the exposed method threw |
| `MethodNotFound` | the instance exists but the method is not exposed |
| `ClassNotFound` | nothing is exposed under that name |
| `Timeout` | no response within `callTimeout`, or the server refused to run it that late |
| `TransportError` | the link dropped, or the message could not be encoded or sent |
| `Unauthorized` | the caller is not authenticated and the server requires it |
| `Forbidden` | the caller is authenticated but not permitted this call |
| `InvalidParams` | the arguments do not match the schema for that method |
| `IncompatibleVersion` | the caller's contract cannot be served by this one |

**A call that timed out will not run afterwards.** Every request carries the time its caller will
still wait, so a server that reaches the method late answers `Timeout` instead of running it, and an
MQTT broker is given the same deadline as its message expiry rather than a longer one of its own.
Without that, a request queued for a restarting server arrives after the operator has already been
told the call failed and acted on it - which for a read is wasted work and for `start pump` is a
machine moving when nobody expects it to.

It is a duration on the wire rather than a moment, so no two peers ever have to agree what time it
is - a browser page's clock belongs to whoever is sitting at it. `refuseExpiredCalls` on the server
handler turns the refusal off.

## Events and reconnection

An exposed instance that extends `EventEmitter` can push to subscribers:

```typescript
const plant = await client.proxy<Plant>('plant')
await plant.remote!.on('alarm', (message: string) => console.log(message))
await plant.remote!.off('alarm', handler)     // same handler reference
```

`RpcClient` is itself an `EventEmitter` reporting the state of its link, so an application can show
it rather than infer it from failed calls:

```typescript
import { TransportEvent } from '@source-repo/rpc'

client.on(TransportEvent.disconnected, (reason) => console.log('link lost:', reason))
client.on(TransportEvent.connected, ({ restoredSubscriptions }) =>
    console.log('link back, subscriptions restored:', restoredSubscriptions))
```

Reconnection is handled for you:

- The underlying transport reconnects on its own (socket.io and mqtt.js both do).
- On every reconnect the client replays its event subscriptions. This restores server-side state if
  the server restarted, and re-identifies the client so pushed events reach it again.
- Replaying is idempotent: the server will not stack a second listener for a subscription it already
  holds.
- When a client's connection drops, the server releases the event subscriptions it held for it.
- An event is delivered only to subscriptions taken out on the peer and namespace it came from.
  Watching `alarm` on two instances, or on two peers over one MQTT transport, keeps them apart.
- `off()` is not subject to `authorize`: a subscription is keyed by the peer that made it, so a peer
  can only drop its own, and refusing to let someone stop receiving events would be strange.

## Checking arguments

Types are a compile-time promise between a client and a server that share a class. Nothing about
MQTT or a browser page guarantees the caller is one of those — a Python historian or a Node-RED flow
calling in over MQTT 5 shares none of your types — so a schema lets the server check what it was
actually sent.

```typescript
const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '3',
            methods: {
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], returns: { kind: 'number' } }
            }
        }
    }
}

const server = new RpcServer({ transports: [{ brokerurl }], schema })
```

A call that does not match is refused with `InvalidParams` before it reaches the method, and the
message names the offending position: `argument 0: expected number, got string (this server serves
plant@3)`.

`source-rpc extract` writes this file from your source rather than you writing it by hand. Note what it
can and cannot see: `value: number` becomes `{ kind: 'number' }`, because a range like `0..2000` is
a runtime invariant that TypeScript does not carry. Extraction gives you shape checking — types,
arity, whether an argument is required. Bounds have to be added to the schema or expressed in the
type.

The type language is small on purpose. It describes what MsgPack actually carries, so `bytes`
(`Uint8Array`) and `date` are values rather than string encodings, and it is checkable without
pulling a validation engine into a package that ships to browsers and embedded targets. `ref` names
a shared or recursive type; nesting beyond 32 levels is refused rather than exhausting the stack.

`object` describes a known shape and `record` an open one — `{ [tag: string]: Reading }`, which is
how plant data usually arrives. A record checks every value against one type and leaves the keys
open, or constrains them with `keyPattern`; `maxEntries` bounds it the way `maxItems` bounds an
array, since a dictionary is the other shape a caller can grow without limit.

```typescript
readings: { params: [], returns: { kind: 'record', values: { kind: 'ref', name: 'Reading' } } }
```

| option | effect |
| --- | --- |
| `validation: 'described'` | check the namespaces the schema covers, let the rest through (default when a schema is given) |
| `validation: 'required'` | refuse anything the schema does not describe |
| `validation: 'off'` | disable checking without removing the schema |
| `validateResults` | check what handlers return too; off by default, since it is a self-check |

Set `validate: false` on a namespace to skip a hot path where the cost is not worth paying.
Validating `writeSetpoint(number)` is not the same proposition as validating a ten-thousand element
telemetry array on every publish.

### Serving older callers

Give a client the contract it was built against and it declares the version on every call:

```typescript
const client = new RpcClient(url, { schema: contractTheClientWasBuiltAgainst })
```

The server keeps earlier versions of a namespace under `history`, and compares the caller's contract
with the one it now serves. It is a structural comparison, not an equality check, so a caller whose
contract still holds keeps working and only a genuine incompatibility is refused — with
`IncompatibleVersion` and the reason:

```
plant@1 is not compatible with plant@2: writeSetpoint argument 0 narrowed, so a value the
caller may send is no longer accepted
```

The rule is ordinary function subtyping. **Parameters are contravariant**: the current contract has
to accept everything the old one allowed, so widening a parameter is safe and narrowing it is not.
**Returns are covariant**: everything the current contract can return has to fit what the old caller
expects, so narrowing a return is safe and widening it is not. Adding an optional field or an
optional argument is safe; adding a required one is not. Events run the other way, since the server
emits and the caller receives.

The comparison happens once per peer and version, not per call, and is conservative: where it cannot
prove compatibility it reports incompatibility, since a false "safe" is the expensive direction.

A caller that declares nothing is simply not version-checked — only its arguments are. A caller
declaring a version the server has no history for is allowed by default, since truncating history is
a legitimate operational choice; `unknownVersion: 'reject'` refuses it instead.

`source-rpc check` runs the same comparison at build time, so a change that would refuse a deployed peer
fails the build instead of surfacing when that peer next calls.

## Describing a server

A server can report what it exposes, so a peer or a person can find out without reading the source.

```typescript
const server = new RpcServer({ transports: [{ brokerurl }], exposeIntrospection: true })

const described = await (await client.proxy<Introspection>('msgrpc')).remote!.describe()
```

It reports each namespace with its class, its contract version, whether the instance was created at
runtime, its methods with types when a schema describes them, and its events with how many peers are
currently subscribed. `source-rpc console` renders this in a browser.

`describe` describes itself: the `source-rpc` namespace comes with its own contract, so a peer reading a
server sees the type it will get back, and `validation: 'required'` does not refuse the one call
made to find out what is there. Its named types are prefixed — `msgrpc.ServerDescription` — because
the schema has one type map shared by every namespace, and a plant defining its own `TypeNode`
should not find `describe()` described against it. A schema that already defines `source-rpc` is left
untouched.

**Off by default, and subject to `authorize` like any other call.** Listing every class, method and
live instance is reconnaissance, and instance names on a plant network tend to encode plant
structure.

This is msgrpc's own shape rather than a borrowed one. OpenAPI is HTTP-shaped and cannot describe a
server pushing events; AsyncAPI models everything as a channel, which fights an RPC surface. Either
would mean describing this system in someone else's concepts.

## Authentication and authorization

Both are off by default, so an unconfigured server accepts any peer and allows any exposed call. The
management surface is *not* off by default in the same sense — it is simply never published unless
asked for. See below.

### Authenticating peers

`authenticate` receives whatever the client sent as `credentials` and returns an identity to accept
the peer, or `undefined` to reject it. Rejected peers never reach the RPC layer — the check runs as
socket.io middleware, before the connection is established at all.

```typescript
const server = new RpcServer({
    transports: [{ port: 3000 }],
    authenticate: async (credentials) => {
        const user = await lookUpToken((credentials as { token?: string }).token)
        return user && { name: user.id, roles: user.roles }
    }
})

const client = new RpcClient('http://localhost:3000', {
    name: 'operator-17',              // must equal the identity's name, see below
    credentials: { token: 'a-token' }
})
```

**`RpcClientOptions.name` must match `RpcIdentity.name`.** The `source` field of a message is written
by the sender, so it is a claim, not evidence. An authenticating transport pins each connection to
the name it authenticated as and drops frames claiming any other source. Without that, an
authenticated peer could address its calls as another peer and inherit its rights.

### Authorizing calls

`authorize` runs for every call and every event subscription. Return false to reject with a
`Forbidden` error.

```typescript
const server = new RpcServer({
    transports: [{ port: 3000 }],
    authenticate,
    authorize: ({ identity, instanceName, method, subscription }) => {
        if (subscription) return identity?.roles?.includes('observer') ?? false
        if (instanceName === 'plant' && method.startsWith('write')) return identity?.roles?.includes('engineer') ?? false
        return true
    }
})
```

An authorizer that throws denies the call. Failing open would turn a bug in the authorizer into an
access-control bypass.

`requireAuthenticatedPeers` defaults to true when `authenticate` is set, rejecting calls from peers
no transport can vouch for with an `Unauthorized` error.

### The management surface

`manageRpc` is **not exposed by default**. Enabling it publishes exactly one method,
`createRpcInstance`, which constructs an instance of a class already passed to `exposeClass()`:

```typescript
const server = new RpcServer({ transports: [{ port: 3000 }], exposeManagement: true })
```

It is still subject to `authorize`, so you can restrict who may create instances. The `expose*`
methods are never remotely reachable.

> Versions before 2.0.0 published all of `ManageRpc` under `manageRpc` with no authentication, so
> any peer that could reach the transport could construct any `exposeClass`'d class with chosen
> arguments, or overwrite an exposed name and deny service to every other client. If you are
> upgrading, treat both as having been reachable.

## MQTT

Servers and clients addressed by name over a broker, which is how a network of them is usually put
together. The different servers are addressed by their `name`.

```typescript
const server = new RpcServer({
    name: 'plantServer',
    transports: [{ brokerurl: 'mqtt://broker:1883', mqtt: { username: 'plant', password: '...' } }]
})

const client = new RpcClient('mqtt://broker:1883', {
    name: 'hmi-1',
    defaultTarget: 'plantServer',
    credentials: { username: 'hmi', password: '...' }   // MQTT credentials go to the broker
})
```

**Both ends must agree on the prefix.** An `mqtt://` url gives the client the default `msgrpc/v2`,
so a server that sets its own is unreachable from a client that does not — and it fails as a call
timeout, which says nothing about why. There is no client option for it, so build the transport:

```typescript
import { MqttTransport } from '@source-repo/rpc'

const transport = new MqttTransport('hmi-1', 'mqtt://broker:1883', { prefix: 'site-4' })
const client = new RpcClient(undefined, { name: 'hmi-1', transport, defaultTarget: 'plantServer' })
```

The same applies to every `MqttTransportOptions` field: the url form takes the defaults, and
anything else means constructing the transport yourself.

### Topics

MQTT 5 is the default. Reply address, correlation and method travel as packet properties, so a peer
with no msgrpc code can take part and standard tooling can read the traffic.
[`docs/mqtt5-frame-spec.md`](https://github.com/source-repo/msgrpc/blob/main/docs/mqtt5-frame-spec.md) describes the layout in full.

```
<prefix>/req/<peer>        calls and subscribe requests            default prefix msgrpc/v2
<prefix>/rsp/<peer>        results and errors
<prefix>/evt/<peer>        events pushed to a subscriber
<prefix>/presence/<peer>   retained: "online", or "offline" via the last will
```

Set `protocol: 4` for a broker that does not speak MQTT 5. That uses the older `$`-delimited header
on `<prefix>/rpc/<peer>` under a default prefix of `msgrpc/v1`, so the two layouts never share a
topic and can run side by side during a migration.

**Peer names are validated.** A name is one topic level, so `#`, `+`, `/`, spaces, an empty name and
names over 128 characters are rejected when the transport is constructed. Without this a peer named
`#` subscribed to `<prefix>/#` and received every other peer's requests and replies.

### Delivery and sessions

**QoS 1 by default.** QoS 0 drops messages silently whenever the broker or link hiccups, which
surfaces as an unexplained call timeout. At-least-once permits duplicate delivery, so the server
suppresses repeats by request id and answers them from a cache rather than running the method again
— a redelivered `writeSetpoint` must not execute twice. Publishes are awaited, so a failure to reach
the broker rejects the call instead of vanishing.

**Presence replaces the connection MQTT does not have.** Each peer registers a retained last will, so
when it disappears the broker publishes `offline` on its behalf and servers release the event
subscriptions they held for it. Without this those subscriptions leaked forever, because an MQTT
server never sees a disconnect. A peer that closes gracefully announces `offline` and then clears its
retained value, so it leaves nothing behind on the broker.

**Sessions.** Servers connect with a stable client id and a persistent session, so requests published
while they restart are queued rather than lost. Under MQTT 5 the session is bounded by
`sessionExpirySeconds`; under 3.1.1, which has no expiry, clients use a clean session instead.

> **Expose before awaiting `ready()`.** A resumed session is handed its queued requests the moment it
> connects. Anything exposed after `await server.ready()` is registered too late for them, and those
> callers get `ClassNotFound`. Construct, expose, then await:
>
> ```typescript
> const server = new RpcServer({ transports: [{ brokerurl }] })
> server.exposeClassInstance(new Plant(), 'plant')   // before, not after
> await server.ready()
> ```

**Peer names must be unique.** A peer's MQTT client id derives from its name, and a broker allows one
connection per client id, so a second peer using the same name disconnects the first.

### Replicas

Set `sharedGroup` and several processes can serve one peer name, with the broker distributing
requests among them. Each replica needs its own `replicaId`, because of the client id rule above.
Only the request channel is shared — a reply has to reach the requester waiting for it. Replicas keep
no session, since a dead replica's share of the queue would never be drained, and they observe
presence without announcing it: one replica's will would otherwise declare the whole group offline.
Event subscriptions still bind to the replica that handled them, so events do not fan out across a
group.

### What the broker still has to do

MQTT has no server-side handshake, so `authenticate` does not apply to MQTT transports and `identity`
is undefined for MQTT callers unless frames are signed. Trust otherwise comes from the broker:

- Set broker credentials or TLS client certificates through the transport's `mqtt` options.
- Restrict which peer may publish or subscribe to which topic with broker ACLs.
- `authorize` still runs, but its `source` is only as trustworthy as those ACLs make it.

A server mixing an authenticating socket.io transport with an MQTT transport will reject its MQTT
peers, because `requireAuthenticatedPeers` turns on with `authenticate`. Set it `false` explicitly to
allow both and rely on the broker for the MQTT half.

**msgrpc cannot hide MQTT traffic.** Peer names can no longer widen their own subscription, but
anyone holding broker credentials can subscribe to `<prefix>/#` and read everything. Only broker ACLs
prevent that. Signing, below, makes a message's origin checkable — it does not make it private.

### Signing frames

Without a connection to authenticate, `source` is a claim. Signing each frame makes it checkable, so
a broker operator — or any peer whose ACLs let it publish to another peer's topic — cannot forge a
message from someone else.

```typescript
import { createHmacSigner, createHmacVerifier } from '@source-repo/rpc'

const secrets: Record<string, string> = { 'hmi-1': '...', plantServer: '...' }
const verify = createHmacVerifier(
    (peer) => secrets[peer],
    (peer) => ({ name: peer, roles: rolesFor(peer) })   // optional: attach roles to the identity
)

const server = new RpcServer({
    name: 'plantServer',
    transports: [{ brokerurl: 'mqtt://broker:1883', sign: createHmacSigner(secrets.plantServer), verify }],
    requireAuthenticatedPeers: true,
    authorize: ({ identity, method }) => (method.startsWith('write') ? !!identity?.roles?.includes('engineer') : true)
})

const client = new RpcClient('mqtt://broker:1883', {
    name: 'hmi-1',
    defaultTarget: 'plantServer',
    sign: createHmacSigner(secrets['hmi-1'])
})
```

Once `verify` is set, a frame must be signed, fresh, unreplayed and signed by the key on file for the
name it claims — otherwise it is dropped before reaching the RPC layer and a `rejected` event carries
the reason. A verified peer becomes an `RpcIdentity`, so `requireAuthenticatedPeers` and `authorize`
work over MQTT exactly as they do over WebSocket.

The signature covers everything that decides what a frame means and where it goes, encoded as a JSON
array of those fields followed by the payload bytes. The array fixes field order and escapes values,
so no combination of names can be made to look like a different frame. Under MQTT 5 that includes the
destination topic, since the topic is what carries the addressing; the exact field list is in the
frame spec.

**Replay protection.** A signature does not stop a captured frame being sent again, which for RPC
means replaying a command. Each frame carries a nonce, and a receiver rejects frames outside
`maxClockSkew` (default 60 s) or whose nonce it has already seen. Peers therefore need clocks within
that window of each other; the window also bounds how many nonces must be remembered.

**HMAC is symmetric.** Whoever can verify a peer's messages can also forge them, so an HMAC secret
must only be shared with parties allowed to act as that peer. Where a compromised server must not be
able to impersonate its peers, use `createEd25519Signer` / `createEd25519Verifier`, which take
WebCrypto keys directly and leave only public keys on the verifying side.

Both are built on WebCrypto, so the same signer works in Node and in the browser. To use an HSM or
another algorithm, supply your own `MessageSigner` / `MessageVerifier` — the built-ins are only
conveniences.

## Options

The types are the reference; these are the ones worth explaining. Anything not listed defaults to
off or absent.

### RpcServerOptions

| option | default | meaning |
| --- | --- | --- |
| `name` | `'*'` | how this server is addressed |
| `transports` | one socket.io server on port 3000 | see below |
| `useMsgPack` | `true` | `false` selects JSON, which cannot carry `Uint8Array` or `Date` |
| `readyTimeout` | `30000` | how long `ready()` waits before throwing; `0` waits forever |
| `authenticate` / `authorize` | — | see [Authentication and authorization](#authentication-and-authorization) |
| `requireAuthenticatedPeers` | on when `authenticate` is set | refuse peers no transport can vouch for |
| `schema` | — | describes what methods accept, so arguments can be checked |
| `validation` | `'described'` when a schema is given | `'required'` refuses anything undescribed; `'off'` disables |
| `validateResults` | `false` | check what handlers return too |
| `unknownVersion` | `'allow'` | `'reject'` refuses a caller whose version has no stored history |
| `requireExplicitExposure` | `false` | refuse a class that marks no `@rpc` methods |
| `exposeManagement` | `false` | publish `manageRpc.createRpcInstance` |
| `exposeIntrospection` | `false` | publish `msgrpc.describe()` |
| `relay` | `true` | forward frames addressed to another connected peer; `false`, or a predicate per connection |
| `callTimeout` | `10000` | for this server's own outgoing calls, via `proxy()` |

A transport entry is `{ port, tls?, path? }` for a socket.io server, `{ server, path? }` to attach
to an existing `http.Server`, `{ connect, path?, credentials? }` to serve over a connection this
server opens, `{ brokerurl, ...MqttTransportOptions }` for MQTT, or a `Transport` instance you built
yourself.

`tls` takes the certificate and key that `https.createServer` takes, and its presence is what makes
the server HTTPS - there is no useful HTTPS server without key material, which is why there is no
boolean for it.

### RpcClientOptions

| option | default | meaning |
| --- | --- | --- |
| `name` | a UUID | how this client identifies itself; must be unique among peers sharing a server |
| `transport` | built from the url | supply one to take full control of the link |
| `defaultTarget` | `'*'` | which peer `proxy()` addresses when not told otherwise |
| `callTimeout` | `10000` | before rejecting with `Timeout` |
| `readyTimeout` | `30000` | before `ready()` throws; `0` waits forever |
| `failCallsOnDisconnect` | `true` | reject in-flight calls at once rather than waiting out each timeout |
| `credentials` | — | socket.io handshake `auth`, or MQTT broker connect options |
| `sign` | — | sign outgoing frames; only meaningful for MQTT |
| `schema` | — | declares the contract version this client was built against |
| `allowInsecureTls` | `false` | accept any certificate on an `https`/`wss`/`mqtts` link; unsafe by design, and it says so |

### MqttTransportOptions

| option | default | meaning |
| --- | --- | --- |
| `protocol` | `5` | `4` for a broker that does not speak MQTT 5 |
| `prefix` | `msgrpc/v2` (`msgrpc/v1` at protocol 4) | topic namespace |
| `topic` | the transport's name | peer name to subscribe as |
| `qos` | `1` | `0` drops messages silently |
| `presence` | `true` | retained last will, which is how peers learn of departures |
| `persistentSession` | `false`, `true` for `RpcServer`'s own | queue messages while disconnected |
| `sessionExpirySeconds` | `3600` persistent, `60` otherwise, `0` for a replica | bounds that queueing |
| `requestExpirySeconds` | `30` | how long the broker holds a request that states no deadline; one from an RPC client carries its caller's, and the expiry follows that |
| `allowResponseTopic` | under the prefix | decides whether a request may have its reply published where it asks |
| `allowInsecureTls` | `false` | accept any certificate from an `mqtts`/`wss` broker; unsafe by design |
| `channels` | all three | which of `req`/`rsp`/`evt` to subscribe to |
| `sharedGroup` / `replicaId` | — | see [Replicas](#replicas) |
| `sign` / `verify` | — | see [Signing frames](#signing-frames) |
| `maxClockSkew` / `maxTrackedNonces` | `60000` / `5000` | replay window and how much of it to remember |
| `mqtt` | — | passed to mqtt.js: credentials, TLS, keepalive, clientId |

## Browser use

The `browser` export condition resolves to a build whose static dependencies are `socket.io-client`,
`@msgpack/msgpack`, `uint8array-extras`, `uuid` and `events`. The MQTT client is **not** among them:
`RpcClient` imports it on demand, so a bundle only carries it if an `mqtt://` url is actually used,
in which case bundlers place it in a separate chunk.

`events` is a real dependency rather than a `node:` builtin so bundlers can substitute the browser
shim. Signing uses WebCrypto, which browsers expose only in a secure context (https, or localhost).

A page can host an `RpcServer` as well as call one: `transports: [{ connect: url }]` serves over the
connection it opens, and the hub relays calls to it. See
[Serving over a connection you open](#serving-over-a-connection-you-open).

**`RpcServer` means a different class here**, and deliberately. In Node it is `NodeRpcServer`, which
adds `{ port }`, `{ server }` and `{ brokerurl }`; in a browser it is the portable base, which has
none of them — a page cannot open a listening socket or speak MQTT. So the same source file is
portable as long as it sticks to what a browser can do, and `{ port: 8080 }` in browser code is a
compile error rather than a class that throws when constructed:

```
Object literal may only specify known properties, and 'port' does not exist in
type 'Transport | ConnectServerOptions'
```

It also means nothing a browser resolves imports socket.io's server or the MQTT client, so neither
reaches the bundle — no aliases and no bundler configuration. `NodeRpcServer` is exported under that
name too, for code that would rather say where it runs.

## Peer routing

Each `RpcServer` and `RpcClient` owns a `PeerRegistry`, shared by its own modules and nothing wider:
transports record which peer a message arrived from, and the switch reads it back to send the reply
out of the same transport. Entries are dropped when a peer disconnects, and the registry is bounded,
since the keys arrive from remote peers.

Peer names must be unique within one graph. Across separate `RpcServer` instances they do not
interfere.

## Low level: modules

`RpcServer` and `RpcClient` are assembled from smaller pieces, and the same pieces are available for
building something else.

A module receives, processes and sends messages. *Sending* here means from one module to the next
within a process, not over a network, and a *message* is any JavaScript value. Modules are connected
with `pipe`:

```typescript
const first = new MyModule()
const second = new MyModule()
first.pipe(second)

// The same thing, shorter:
const third = new MyModule([first])

// A module can also pipe into a plain function.
first.pipe((message) => console.log('first wanted to send:', message))
```

To write one, extend `GenericModule` and call `this.send(message)`. Its `receive` may be async, and a
rejection propagates back through the pipe to the original sender, where it can be caught either at
the `send` call or with a `TryCatch` module:

```typescript
const tryCatch = new TryCatch([source])
tryCatch.on('caught', (message, error) => console.log('caught', error))
```

Included utilities: **Converter** (map each message through a function), **Filter** (pass those a
predicate accepts), **Switch** (route to a named target; an unresolvable target is dropped) and
**TryCatch**.

Transports own their wire format. A transport receives and emits `Message` objects and encodes them
itself with a `FrameCodec`, which is what lets MQTT 5 carry the method and correlation as packet
properties rather than burying them in an opaque payload. Wiring RPC by hand is therefore just the
handler and a transport:

```typescript
import { RpcServerHandler, SocketIoServerTransport } from '@source-repo/rpc'

const transport = new SocketIoServerTransport('server', undefined, 3000)
const handler = new RpcServerHandler('server', [transport])   // transport -> handler
handler.pipe(transport)                                        // handler -> transport

handler.manageRpc.exposeObject({ hello: () => 'world' }, 'greeter')
```

Before 2.0.0 a `Converter` sat on each side of the handler to encode and decode. Those converters
are still exported, but they are no longer part of the RPC chain.

## Development

```
npm install
npm run build           # tsc -> dist/
npm test                # cleans, builds, then runs ava
npm run lint
npm run typecheck       # src and examples, no emit
npm run build:examples  # examples/ -> dist-examples/
```

The MQTT tests need a broker on `localhost:1883` and skip themselves when none is reachable:

```
docker compose -f docker-compose/docker-compose.yml up -d
```

Point them at a different broker with `MSGRPC_TEST_BROKER=mqtt://host:1883`.

[`examples/`](https://github.com/source-repo/msgrpc/tree/main/packages/rpc/examples) is a small plant service showing the 2.0 idioms: `@rpcNamespace` and `@rpc`,
an extracted contract, and a server that validates against it and exposes introspection.
