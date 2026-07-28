# Changelog

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
