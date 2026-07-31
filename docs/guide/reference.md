# Reference

## Options

The types are the reference; these are the ones worth explaining. Anything not listed defaults to off or absent.

### RpcServerOptions

| option | default | meaning |
| --- | --- | --- |
| `name` | `'*'` | how this server is addressed |
| `transports` | one socket.io server on port 7843 | see below |
| `useMsgPack` | `true` | `false` selects JSON, which cannot carry `Uint8Array` or `Date` |
| `readyTimeout` | `30000` | how long `ready()` waits before throwing; `0` waits forever |
| `authenticate` / `authorize` | — | see [Authentication and authorization](./security.md) |
| `requireAuthenticatedPeers` | on when `authenticate` is set | refuse peers no transport can vouch for |
| `schema` | — | describes what methods accept, so arguments can be checked |
| `validation` | `'described'` when a schema is given | `'required'` refuses anything undescribed; `'off'` disables |
| `validateResults` | `false` | check what handlers return too |
| `unknownVersion` | `'allow'` | `'reject'` refuses a caller whose version has no stored history |
| `idempotency` | — | where to record what a non-repeatable command did, so a redelivery is answered rather than run again |
| `requireExplicitExposure` | `false` | refuse a class that marks no `@rpc` methods |
| `exposeManagement` | `false` | publish `manageRpc.createRpcInstance` |
| `exposeIntrospection` | `false` | publish `msgrpc.describe()` |
| `relay` | `true` | forward frames addressed to another connected peer; `false`, or a predicate per connection |
| `callTimeout` | `10000` | for this server's own outgoing calls, via `proxy()` |

A transport entry is `{ port, tls?, path? }` for a socket.io server, `{ server, path? }` to attach to an existing `http.Server`, `{ connect, path?, credentials? }` to serve over a connection this server opens, `{ brokerurl, ...MqttTransportOptions }` for MQTT, or a `Transport` instance you built yourself. A `connect` entry also takes `ca` — the authority to trust when the hub serves TLS — and `allowInsecureTls` for a development hub whose certificate nobody signed.

`tls` takes the certificate and key that `https.createServer` takes, and its presence is what makes the server HTTPS - there is no useful HTTPS server without key material, which is why there is no boolean for it.

### RpcClientOptions

| option | default | meaning |
| --- | --- | --- |
| `name` | three readable words | how this client identifies itself; must be unique among peers sharing a server |
| `transport` | built from the url | supply one to take full control of the link |
| `defaultTarget` | `'*'` | which peer `proxy()` addresses when not told otherwise |
| `callTimeout` | `10000` | before rejecting with `Timeout` |
| `readyTimeout` | `30000` | before `ready()` throws; `0` waits forever |
| `failCallsOnDisconnect` | `true` | reject in-flight calls at once rather than waiting out each timeout |
| `credentials` | — | socket.io handshake `auth`, or MQTT broker connect options |
| `sign` | — | sign outgoing frames; only meaningful for MQTT |
| `schema` | — | declares the contract version this client was built against |
| `ca` | — | trust this certificate authority as well as the system ones; verification stays **on** |
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
| `tap` | `false` | watch everything under the prefix and report it as `relayed` without acting on it; answers no calls and checks no signatures |
| `sharedGroup` / `replicaId` | — | see [Replicas](./mqtt.md#replicas) |
| `sign` / `verify` | — | see [Signing frames](./mqtt.md#signing-frames) |
| `maxClockSkew` / `maxTrackedNonces` | `60000` / `5000` | replay window and how much of it to remember |
| `mqtt` | — | passed to mqtt.js: credentials, TLS, keepalive, clientId |

## Browser use

The `browser` export condition resolves to a build whose static dependencies are `socket.io-client`, `@msgpack/msgpack`, `uint8array-extras`, `uuid` and `events`. The MQTT client is **not** among them: `RpcClient` imports it on demand, so a bundle only carries it if an `mqtt://` url is actually used, in which case bundlers place it in a separate chunk.

`events` is a real dependency rather than a `node:` builtin so bundlers can substitute the browser shim. Signing uses WebCrypto, which browsers expose only in a secure context (https, or localhost).

A page can host an `RpcServer` as well as call one: `transports: [{ connect: url }]` serves over the connection it opens, and the hub relays calls to it. See [Serving over a connection you open](./connecting.md#serving-over-a-connection-you-open).

**`RpcServer` means a different class here**, and deliberately. In Node it is `NodeRpcServer`, which adds `{ port }`, `{ server }` and `{ brokerurl }`; in a browser it is the portable base, which has none of them — a page cannot open a listening socket or speak MQTT. So the same source file is portable as long as it sticks to what a browser can do, and `{ port: 8080 }` in browser code is a compile error rather than a class that throws when constructed:

```
Object literal may only specify known properties, and 'port' does not exist in
type 'Transport | ConnectServerOptions'
```

It also means nothing a browser resolves imports socket.io's server or the MQTT client, so neither reaches the bundle — no aliases and no bundler configuration. `NodeRpcServer` is exported under that name too, for code that would rather say where it runs.

## Low level: modules

`RpcServer` and `RpcClient` are assembled from smaller pieces, and the same pieces are available for building something else.

A module receives, processes and sends messages. *Sending* here means from one module to the next within a process, not over a network, and a *message* is any JavaScript value. Modules are connected with `pipe`:

```typescript
const first = new MyModule()
const second = new MyModule()
first.pipe(second)

// The same thing, shorter:
const third = new MyModule([first])

// A module can also pipe into a plain function.
first.pipe((message) => console.log('first wanted to send:', message))
```

To write one, extend `GenericModule` and call `this.send(message)`. Its `receive` may be async, and a rejection propagates back through the pipe to the original sender, where it can be caught either at the `send` call or with a `TryCatch` module:

```typescript
const tryCatch = new TryCatch([source])
tryCatch.on('caught', (message, error) => console.log('caught', error))
```

Included utilities: **Converter** (map each message through a function), **Filter** (pass those a predicate accepts), **Switch** (route to a named target; an unresolvable target is dropped) and **TryCatch**.

Transports own their wire format. A transport receives and emits `Message` objects and encodes them itself with a `FrameCodec`, which is what lets MQTT 5 carry the method and correlation as packet properties rather than burying them in an opaque payload. Wiring RPC by hand is therefore just the handler and a transport:

```typescript
import { RpcServerHandler, SocketIoServerTransport } from '@source-repo/rpc'

const transport = new SocketIoServerTransport('server', undefined, 7843)
const handler = new RpcServerHandler('server', [transport])   // transport -> handler
handler.pipe(transport)                                        // handler -> transport

handler.manageRpc.exposeObject({ hello: () => 'world' }, 'greeter')
```

Before 2.0.0 a `Converter` sat on each side of the handler to encode and decode. Those converters are still exported, but they are no longer part of the RPC chain.

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

[`examples/`](https://github.com/source-repo/rpc/tree/main/packages/rpc/examples) is a small plant service showing the 2.0 idioms: `@rpcNamespace` and `@rpc`, an extracted contract, and a server that validates against it and exposes introspection.
