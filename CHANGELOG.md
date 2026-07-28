# Changelog

## msgrpc 2.2.0 and msgrpc-cli 2.3.0

**Discovery and routing over socket.io**, so a network with no broker works the way an MQTT one
always has - and so a server hosted in a browser page is a peer like any other.

- **`RpcServer.proxy()`**, the mirror of `RpcClient.proxy`. A peer that both serves and calls now
  needs one object and one connection, under one name, rather than an `RpcServer` and an
  `RpcClient` under two - which over MQTT meant two broker sessions. Its subscriptions are replayed
  on reconnect the way a client's are.
- **A bus without a broker.** An `RpcServer` that exposes nothing and only relays is one; everything
  else joins with `{ connect: url }` and gets presence, addressing by name, and any-to-any calling.
- **More than one hop.** A peer announces the peers reachable *through* it as well as its own name,
  so a server that is a hub for its own peers and a member of a bus makes each visible to the other.
  Calls, replies and events all traverse it, and departures propagate. Verified to three hops.
  Split horizon - never advertising a peer back along the link it came from, in the broadcasts and
  in the snapshot handed to a newly connected peer - keeps two hubs from concluding the other is
  the way to a peer and losing it. Frames carry a hop count and are dropped after 8 relays, since a
  mesh that has just lost a link can hold a cycle until the tables settle. A peer offered by two
  links keeps the first and falls back to the second; a peer announcing itself outranks one merely
  carried.

- **Every peer announces itself on connect**, and is told who else is there. A socket.io server used
  to learn a peer only from the header of a frame it sent, so a peer that merely listened was
  invisible and could not be addressed at all. `peerOnline` and `peerGone` now come from both
  transports, so code watching a network no longer cares which one it is on.
- **`transports: [{ connect: url }]`** lets an `RpcServer` serve over a connection it opens. A
  browser cannot listen, so this is the only way a page can host a service; the hub relays calls to
  it.
- **A server relays for its connected peers.** A frame addressed to another peer it can see is
  forwarded instead of executed locally. `relay: false` forwards nothing, and a predicate decides
  per connection. The decision is remembered per pair of peers, because a rule written about the
  caller would otherwise strand the reply travelling the other way. A relaying server with no
  `authenticate` warns once, the first time it actually forwards something.
- **A server holding both a socket.io listener and a broker connection bridges them.** A browser
  peer discovers a peer that exists only on MQTT and calls it, with the call arriving under the
  browser peer's own name rather than the bridge's, so per-peer authorization and subscriptions
  still mean something. The bridge subscribes to the reply and event topics of the peers it
  forwards for, and publishes presence on their behalf - without that, a departing browser peer
  left its event subscriptions on the MQTT server forever.
- **`msgrpc console --hub <url>`**, on its own or alongside `--broker`. With both, one list covers
  both networks and each peer is called over the link it was found on.

### Fixed

- **A socket.io server executed calls addressed to another peer.** The target was tested only for
  being a name the server had heard of, never for being the server itself, so a call meant for
  someone else was answered by whoever it reached - with that server's own implementation, reported
  as success. It now forwards, or refuses; it never substitutes itself. A frame that can be neither
  delivered nor relayed is reported as `unroutable` rather than dropped in silence, which callers
  only ever saw as an unexplained timeout.
- `MqttTransport` set the response topic of a forwarded request to its own address, so a
  non-msgrpc peer honouring it would have replied to the wrong peer.

### Tests

- MQTT test peers get a 10 s session expiry. Names became unique per run in 2.1.1, which fixed one
  problem and created another: a server keeps a persistent session for an hour by default, so every
  run left another one behind. After a day of runs the broker held 1024 sessions and 3628
  subscriptions and stopped accepting connections. The one test that is *about* the hour-long
  default keeps it and clears its own session afterwards.

### Breaking

- `new SocketIoClientTransport(url, sources, options)` is now
  `new SocketIoClientTransport(name, url, sources, options)`. A peer has to know its own name to
  announce it, the same way `MqttTransport` has always taken one. `RpcClient` passes its `name`
  through, so this only affects code constructing the transport directly.

## msgrpc 2.1.1

Documentation and test hygiene; no change to shipped code.

- The quick start did not compile: `Calculator` was neither exported by the server snippet nor
  imported by the client one, and the client needs the class as a type to get a typed proxy. It is
  now a shared `calculator.ts` the client pulls in with `import type`, which is the point being
  made and was the thing left out.
- The MQTT example gave the server `prefix: 'site-4'` and the client no prefix at all, so the two
  could never reach each other. An `mqtt://` url takes the default prefix and there is no client
  option to change it, so the section now shows building the `MqttTransport` and says what the
  mismatch looks like: a bare call timeout.
- A **Connecting** section, which was missing entirely - transports against urls, peer names and
  targets, `ready()`/`close()`, and the MsgPack/JSON choice. The README went from the quick start
  to decorators and schemas without ever saying how to point a client at a real server.
- Reordered so the basics come first: exposing, errors, events, then schemas and versioning, then
  introspection, authentication and MQTT. Security and broker detail used to arrive before the
  ordinary reader had been shown a second method call.
- The opening sentence said "expose an instance", which read as though instances were incidental.
  It now says the instance is one live object that every call runs against, and the quick start
  demonstrates state surviving between calls.
- Exposing more than one namespace, and `exposeObject`, are both shown.

### Tests

- The MQTT tests gave every peer a fixed name, and a peer name is the broker's client id. A server
  keeps a persistent session, so a second run resumed the first run's session and was handed
  whatever it still had queued - which showed up as an occasional failure that never reproduced
  when the file was run on its own. Names and topic prefixes now carry a per-run suffix.
- `rpc traffic is published per peer` waited for two messages on the observed prefix before
  asserting, which the two presence announcements could satisfy on their own, leaving the reply
  still in flight. It now waits for the rpc topics it is actually about.

## msgrpc-cli 2.2.0

- **`msgrpc console` is now a React app, and it reaches the CLI over msgrpc itself.** The CLI runs
  an `RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace
  (`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events; the browser is
  an ordinary `RpcClient`. The REST endpoints and the server-sent event stream are gone. The
  console is now the library's own first client, so a fault in event routing surfaces here before
  it reaches a plant.
- **A method folds open into a form with one field per argument**, built from that argument's type:
  a number input carrying the schema's bounds, a dropdown for a union of literals, a checkbox for a
  boolean, a picker for a date, a hex field for bytes, and for an object a JSON box pre-filled with
  the shape's required fields. Optional arguments have a checkbox deciding whether they are sent at
  all. Previously the whole call had to be written as one JSON array.
- JSON typed into a field is walked against the type before it is sent, so an ISO string where the
  schema says `date` becomes a `Date`. Without this any object carrying a timestamp was rejected by
  the server that asked for one.
- The browser waits longer than the console's own `--timeout`, which the console reports. Both
  defaulted to 10 s, so a call into an unreachable peer used to time out in the browser at the same
  moment the console was forming the answer that said why.
- Everything is bundled into `dist/web`; nothing is fetched at runtime.

## msgrpc 2.1.0

- `MethodSchema.paramNames` carries parameter names, and `msgrpc.describe()` reports them. Tooling
  that has to present a call to a person needs a label, and "argument 0" is not one. Optional and
  never used for checking, so a hand-written schema can leave it out. `msgrpc extract` writes it.

## msgrpc-cli 2.1.0

- `msgrpc console --sign <keyfile>` lets the console take part in a signed network. Without it the
  console lists peers, because presence is unsigned retained state, and then every call times out
  with nothing to say why. Keys come from a file rather than a flag, since a secret on a command
  line is visible to anyone who can run `ps`, and a `--name` contradicting the key file is refused
  rather than left to surface as that same timeout.
- README corrected: it claimed broker credentials and signing already applied to the console, which
  they did not, and documented none of the console's flags.

## msgrpc 2.0.1

- README rewritten. It documented 3 of 14 server options, described the MQTT v1 topic layout as
  current when MQTT 5 has been the default since 2.0.0, and its low-level examples wired converters
  that 2.0.0 removed. No code change.
- `repository.directory` and `homepage` added, so npm and GitHub can find each package in the tree.

## 2.0.0

A near-complete rework of everything below the API. The class-as-contract surface is unchanged —
`exposeClassInstance` and `proxy<T>()` still look the same — but correlation, addressing,
reconnection, security and the MQTT wire format were all rebuilt.

Published as `@source-repo/msgrpc` and, new in this release, `@source-repo/msgrpc-cli`.

### Breaking

| change | what to do |
| --- | --- |
| Output moved from `dist/src/*` to `dist/*`, with an `exports` map | Use the package name; deep imports into `dist/src` no longer resolve |
| ESM only, Node >= 18.17 | — |
| `RpcClient` extends `EventEmitter` | Only matters if you subclassed it |
| `ready()` throws after `readyTimeout` (default 30 s) instead of waiting forever | Catch it, or set `readyTimeout: 0` for the old behaviour |
| `RpcErrorPayload.exception` replaced by `error`, and error payloads carry `id` | The old field always encoded to `{}`; read `error.message` |
| `MqttTransport(name, url, options, sources)` — options are an object | `topic` and broker options move into it |
| MQTT defaults to protocol 5 on prefix `msgrpc/v2` | Set `protocol: 4` for the old `$`-header layout on `msgrpc/v1`; the two never share a topic |
| `manageRpc` is no longer exposed remotely | Set `exposeManagement: true` if you relied on remote `createRpcInstance` |
| Transports carry messages, not bytes; encoding lives in the transport | Only matters if you wrote a transport or wired the module chain by hand |
| `GenericModule.knownSources` static removed | Each `RpcServer`/`RpcClient` owns a `PeerRegistry` |
| `MessageSigner`/`MessageVerifier` take canonical bytes plus a context | One signer now serves both wire formats |
| An event is delivered only to the peer and namespace it came from | Previously every subscriber of that event name received it |
| `uuid` 14, `@types/node` 22 | — |

`exposeClassInstance(instance)` may now omit the name when the class declares `@rpcNamespace`.

### Security

Several of these were exploitable in 1.x. If you ran 1.x where untrusted peers could reach the
transport, assume they were reachable.

- **Replies were broadcast to every connected socket.** An unauthenticated socket could read another
  client's payloads; clients merely filtered on arrival. Replies now go to one socket.
- **`ManageRpc` exposed itself**, so any peer could construct any `exposeClass`'d class with chosen
  arguments, or overwrite an exposed name and deny service to everyone else.
- **MQTT peer names were interpolated into topics unchecked.** A peer named `#` subscribed to every
  other peer's traffic. Names are now validated as a single topic level.
- Optional `authenticate` / `authorize`, with identity bound to the connection rather than looked up
  by a claimed name, so one peer cannot address messages as another.
- Optional frame signing (HMAC-SHA256 or Ed25519) with replay protection, which gives MQTT peers a
  verifiable identity without trusting the broker.

### Added

- **MQTT 5 frame layout** — reply address, correlation and method travel as packet properties, so a
  peer with no msgrpc code can take part and standard tooling can read the traffic. See
  `docs/mqtt5-frame-spec.md`.
- **Argument checking** against a schema, with `@rpc` marking which methods are exposed at all.
- **Contract versions**, compared structurally: a caller built against an older contract keeps
  working unless the two genuinely disagree.
- **`msgrpc.describe()`** reporting namespaces, methods, events and live instances. Off by default.
- **`@source-repo/msgrpc-cli`** — `extract` reads a contract from TypeScript source, `check` fails a
  build on a breaking change, `console` serves a browser view of a live network.
- MQTT shared subscriptions for server replicas, bounded sessions, and presence.
- Connection lifecycle events, configurable `callTimeout`, and fail-fast on disconnect.

### Fixed

- MsgPack round-tripped through JSON, turning every `Uint8Array` into `{"0":1,…}`.
- A server-side throw never rejected the caller; it timed out after 10 s with the error discarded.
- Pending-call bookkeeping never drained, leaking a timer per call.
- Repeated `on()` stacked a server-side listener each time and none could be removed.
- Clients did not re-subscribe after a reconnect, and servers never released a departed peer's
  subscriptions.
- `off()` was never handled by the server, so unsubscribing did nothing.
- Peer routing lived in one process-wide static, so two servers in a process could deliver each
  other's replies to the wrong client.
- `open()` ran twice per client, and `close()` left socket.io's reconnect timer armed.
- Browser builds pulled in the MQTT client whether or not they used it.
