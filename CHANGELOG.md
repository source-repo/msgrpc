# Changelog

## msgrpc 2.1.1

Documentation only.

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
