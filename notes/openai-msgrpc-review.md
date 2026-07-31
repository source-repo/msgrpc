# Recommendation

**Keep `msgrpc` and harden it rather than replacing it.**

For your precise scope—your own browser applications on one side, MQTT-based industrial networks on the other—the library is now more valuable than a generic RPC wrapper. Its most important asset is not the TypeScript proxy API; it is the **MQTT 5 wire protocol and delivery model** you have built underneath it.

I would treat the current 2.3.0 code as a strong release candidate, but **not yet freeze the protocol or declare it production-hardened**. There are several concrete issues to fix first, including two security-critical ones. I reviewed the current repository source, documentation and tests; this was not a complete penetration test or a full execution of every test against real brokers and browsers. ([GitHub][1])

One positioning correction is important:

> `msgrpc` currently provides RPC over **Socket.IO and MQTT**, not generic WebSocket and MQTT.

Socket.IO normally uses WebSocket when possible, but its wire protocol is not compatible with an ordinary WebSocket client. That is not necessarily a disadvantage—Socket.IO brings reconnection, heartbeat and transport fallback—but the distinction matters for interoperability and documentation. ([socket.io][2])

## What is particularly good

### 1. The two transports share one coherent programming model

The same class contract, proxy, instance lifecycle, calls and events work across the browser and MQTT sides. That is exactly the sort of unity you would lose by combining a browser RPC framework with a separate MQTT service library.

The contract compatibility mechanism is also more thoughtful than simply comparing package versions or schema hashes. Structural compatibility allows independently deployed components to evolve without requiring identical builds, while the CLI provides a way to detect incompatible changes before deployment. ([GitHub][3])

### 2. The MQTT 5 implementation is the strongest part

You are using MQTT 5 mechanisms rather than merely putting JSON requests on arbitrary topics:

* response topics and correlation data;
* separate request, response and event topic spaces;
* message expiry;
* persistent sessions;
* retained presence and last-will handling;
* shared subscriptions;
* QoS 1 with application-level duplicate suppression;
* frame signatures, timestamps and replay protection;
* explicit source, method, path, event and version metadata.

That is a meaningful industrial protocol design. A plain MQTT.js application can interoperate with it, so the wire format is not intrinsically tied to the TypeScript proxy implementation. The existing plain-MQTT interoperability tests are especially important because they establish that `msgrpc` can become a documented protocol rather than merely an internal library. ([GitHub][4])

### 3. It addresses real failure conditions

The code visibly considers duplicates, malformed packets, broker reconnection, queued messages, presence, contract mismatch and calls arriving concurrently. This puts it beyond the usual small “RPC over MQTT” wrapper.

The duplicate-response cache and in-flight tracking are useful optimizations, even though they cannot by themselves provide durable exactly-once execution. ([GitHub][5])

### 4. The focus is defensible

Supporting exactly two transports can be an advantage. You can make the semantics precise instead of growing a generic framework with HTTP, gRPC, AMQP, NATS and numerous partially equivalent adapters.

I would explicitly freeze the intended boundary as:

* browser/HMI applications: Socket.IO;
* Node/edge/industrial services: MQTT 5;
* selective bridging between them;
* MQTT 3.1.1 only as a compatibility mode;
* MCP and similar integrations remain optional tooling, not additional core transports.

## Issues to fix before relying on it broadly

### 1. Critical: TLS certificate verification is disabled by default

The Socket.IO client currently sets:

```ts
rejectUnauthorized: false
```

before applying user options. That means a Node-side client accepts an untrusted or impersonated TLS server unless the caller remembers to override the option. This should never be the default, especially where the library may carry industrial commands. ([GitHub][6])

Remove the default entirely. For installations using private plant certificates, support an explicit CA configuration:

```ts
type TlsOptions =
  | {
      ca: string | Buffer | Array<string | Buffer>;
      rejectUnauthorized?: true;
    }
  | {
      /**
       * Deliberately unsafe. Intended only for local development.
       */
      allowInsecureTls: true;
    };
```

The insecure option should be conspicuous, produce a warning and preferably be unavailable under a hardened production profile.

The `{ https: true }` server shorthand also appears to create an HTTPS server without certificate/key material. Replace it with either:

```ts
{ tls: HttpsServerOptions }
```

or require the application to supply an already configured HTTP/HTTPS server. 

### 2. Critical: signatures do not cover every semantic field

The canonical signed MQTT data currently includes the frame version, MQTT topic, source, kind, path, method/event, correlation data, timestamp, nonce and payload. However, other properties that affect interpretation are omitted, notably:

* content type;
* remote result/error code;
* contract version.

The receiver uses those unsigned properties to decide how the payload should be decoded and how the frame should be handled. ([GitHub][7])

The content-type omission is not merely theoretical. A one-byte signed payload containing hexadecimal `31` can be decoded as:

* JSON text `"1"` → numeric value `1`;
* MessagePack positive fixed integer → numeric value `49`.

Changing only the unsigned content type can therefore change the meaning while leaving the signature valid.

For a version 2 signed frame, include every authoritative field in the canonical representation:

```ts
type SignedFrameMetadata = {
  frameVersion: number;
  topic: string;
  responseTopic?: string;
  correlationData?: Uint8Array;

  source: string;
  kind: 'request' | 'response' | 'event';
  path: string;
  method?: string;
  event?: string;

  contentType: 'application/json' | 'application/msgpack';
  resultCode?: string;
  contractVersion?: string;

  issuedAt: number;
  deadline?: number;
  nonce: string;
};
```

Also:

* reject unknown content types rather than treating them as MessagePack;
* reject unsupported signed frame versions;
* include a signing key identifier to permit key rotation;
* add tampering tests for each individual property;
* sign the response topic if it is authoritative.

The documentation currently understates the consequences of changing content type. That section should be corrected when the signed-frame version changes. ([GitHub][8])

### 3. High: the incoming MQTT 5 Response Topic is not actually honored

Outbound requests provide an MQTT 5 Response Topic, but the request receiver appears to construct the destination response topic from `mr-src` rather than reading the packet’s `responseTopic` property.

The interoperability test succeeds because the plain MQTT client happens to choose the same response topic that `msgrpc` would derive from the source name. A standards-compliant caller choosing another valid response topic would not receive the response where requested. 

This also diverges from your documentation, which describes the Response Topic as the authoritative place to reply. ([GitHub][8])

I would honor the incoming Response Topic:

1. Validate that it is syntactically acceptable.
2. Apply a configured prefix or allow-list policy so a caller cannot make a server publish anywhere in the broker.
3. Associate it with the correlation data.
4. Use it for that response.
5. Include it in signed metadata.

The alternative is to declare that `msgrpc` uses a conventionally derived response topic and that MQTT 5 Response Topic is informational. That would work, but it would weaken the claim that arbitrary MQTT 5 peers can use native request/response behavior. Honoring it is the better choice.

### 4. High: a request can execute after the caller has timed out

The default client call timeout is approximately 10 seconds, while the default MQTT request expiry is approximately 30 seconds. Consequently, a request may remain queued and be delivered roughly 20 seconds after the caller has already reported a timeout. ([GitHub][9])

For a read operation this may only waste resources. For a command such as “start pump,” “reset fault” or “apply configuration,” it can be dangerous: the operator sees a timeout, takes another action, and then the original command executes late.

Message expiry should be derived from a **signed absolute deadline**, not be an independent transport default:

```ts
export interface RpcCallOptions {
  /**
   * Unix timestamp in milliseconds.
   */
  deadline: number;

  signal?: AbortSignal;
  idempotencyKey?: string;

  delivery:
    | 'online-only'
    | 'queue-until-deadline';

  orderingKey?: string;
}
```

The sender should:

* derive MQTT `messageExpiryInterval` from the remaining deadline;
* stop waiting at the same deadline;
* cancel locally through `AbortSignal` when appropriate.

The receiver should verify the deadline immediately before invoking the method. Broker expiry alone is insufficient because a packet can arrive just before expiration and then wait in a local queue.

### 5. High: execution is not durably exactly once

The current duplicate suppression is in-memory. That is useful during normal redelivery, but this sequence remains possible:

1. Server invokes an industrial command.
2. The command changes the physical or persistent state.
3. Server crashes before publishing or caching the response.
4. MQTT redelivers the QoS 1 request after restart.
5. The command executes again.

The documentation appropriately acknowledges that per-process or per-replica duplicate caches do not provide distributed exactly-once execution. ([GitHub][5])

The public semantics should therefore say something close to:

> RPC delivery and execution are at least once unless the method supplies durable idempotency.

Add a handler context containing an immutable request ID and idempotency key:

```ts
export interface RpcInvocationContext {
  requestId: string;
  idempotencyKey?: string;
  source: string;
  deadline: number;
  attempt: number;
}
```

Then provide a persistence hook:

```ts
export interface RpcIdempotencyStore {
  get(
    scope: string,
    idempotencyKey: string,
  ): Promise<StoredRpcOutcome | undefined>;

  begin(
    scope: string,
    idempotencyKey: string,
  ): Promise<'acquired' | 'in-progress' | 'completed'>;

  complete(
    scope: string,
    idempotencyKey: string,
    outcome: StoredRpcOutcome,
  ): Promise<void>;
}
```

The library does not need to contain a database implementation. It needs to expose the semantics and hook cleanly.

### 6. High: concurrent method execution needs an explicit policy

Calls are intentionally executed concurrently. That is good for stateless services and unrelated devices, but potentially unsafe for multiple methods operating on one long-lived mutable instance. ([GitHub][5])

For example:

```text
setMode("manual")
start()
setSetpoint(80)
```

could interleave with another caller’s:

```text
stop()
setMode("automatic")
```

Add configurable execution policies:

```ts
type RpcExecutionPolicy =
  | { mode: 'parallel' }
  | { mode: 'serial-per-instance' }
  | {
      mode: 'serial-by-key';
      getKey: (invocation: RpcInvocation) => string;
    };
```

For industrial objects, `serial-per-instance` is a safe default. Read-only operations can explicitly opt into parallel execution.

I would also classify methods:

```ts
type RpcMethodSemantics =
  | 'query'
  | 'idempotent-command'
  | 'non-repeatable-command';
```

That classification can control retries, idempotency requirements, queueing and the error reported when the outcome is uncertain.

A `non-repeatable-command` should not be silently retried after an ambiguous disconnect. It should produce a distinct `UNKNOWN_OUTCOME` result so the caller knows that the command may have executed.

### 7. Browser-to-MQTT is not currently a clean supported path

The automatic transport selection interprets `http://`, `https://`, `ws://` and `wss://` as Socket.IO. MQTT is selected by an `mqtt://`-style URL. The browser export also does not expose the MQTT transport. ([GitHub][10])

MQTT.js browsers, however, connect to MQTT brokers through `ws://` or `wss://`, not through a native TCP `mqtt://` connection. ([GitHub][11])

This is completely acceptable when your intended architecture is:

```text
Browser
   │ Socket.IO
   ▼
Application / edge service
   │ MQTT 5
   ▼
Industrial broker and services
```

In fact, that is often preferable because browser users do not need direct broker credentials or topic permissions.

Document this topology explicitly. Do not imply that a browser can currently select MQTT merely by passing a broker WebSocket URL.

Should direct browser-to-broker support become necessary, use explicit transport selection rather than inferring from the URL:

```ts
const client = await RpcClient.connect({
  transport: 'mqtt',
  url: 'wss://broker.example/mqtt',
});
```

### 8. Production defaults are too permissive

The current defaults favor easy development:

* relaying is enabled;
* authentication is optional;
* explicit method exposure is not required;
* unknown contract versions may be accepted;
* Socket.IO CORS is broadly open;
* all prototype methods can become callable when there are no explicit exposure marks.

Those defaults are convenient locally but risky in an industrial deployment. ([GitHub][12])

Introduce a production profile rather than forcing every caller to discover all the relevant switches:

```ts
const server = await RpcServer.create({
  securityProfile: 'production',

  auth: authenticatePeer,
  allowedOrigins: ['https://hmi.example'],
  relay: false,
});
```

A production profile should imply:

* TLS verification enabled;
* explicit method exposure required;
* authentication required for non-loopback connections;
* relaying disabled unless an allow predicate is supplied;
* strict contract/version handling;
* remote stack traces disabled;
* request validation enabled;
* bounded message size;
* bounded pending calls;
* global, per-peer and per-instance concurrency limits;
* rate limiting or an admission-control hook.

## Comparison with the main alternatives

### tRPC

tRPC is the stronger choice for a conventional TypeScript browser/server application. It has an excellent TypeScript developer experience and supports WebSocket-based communication, but MQTT is not one of its core transports. ([tRPC][13])

Using tRPC would therefore lead to:

```text
Browser ── tRPC ── Gateway ── MQTT.js/MQTT+ ── Industrial network
```

This gives you a larger web ecosystem, but you would have:

* two service definitions or an adapter generator;
* two error models;
* two deadline/retry models;
* two subscription/event models;
* gateway code translating identity and authorization;
* no single end-to-end call semantics.

**Choose tRPC instead only when web application ergonomics are more important than one unified browser/industrial model.**

For your stated purpose, I would not switch.

### WAMP

WAMP is the strongest standards-oriented alternative. It defines routed RPC and publish/subscribe, supports symmetric roles, is language-independent and commonly operates over WebSocket. ([WAMP][14])

WAMP is attractive when:

* ordinary WebSocket interoperability is important;
* several third-party languages must participate;
* a standard router-based protocol is preferable to owning a wire format.

But it does not give you native MQTT 5 sessions, shared subscriptions, broker ACL integration, MQTT message expiry or MQTT response-topic behavior. You would still require a WAMP–MQTT bridge or two separate protocol domains.

**Choose WAMP when external cross-language WebSocket standardization is the strategic requirement.**

That does not appear to be your primary requirement.

### NestJS

Nest supports WebSocket gateways, including Socket.IO and raw WebSocket approaches, and it has an MQTT microservice transport. ([NestJS Docs][15])

However, these are parts of the wider Nest framework and use separate gateway/microservice abstractions. Nest adds dependency injection, decorators, modules, lifecycle conventions and often RxJS around the transport layer.

It is appropriate when the entire backend is already committed to Nest. It is not a smaller or cleaner replacement for this focused library.

### `rpc-websockets`

`rpc-websockets` gives a relatively direct JSON-RPC 2.0 model over ordinary WebSocket, with browser and Node clients plus server events. ([GitHub][16])

It has a clearer standards story for the browser transport than Socket.IO, but:

* it has no MQTT transport;
* it does not give you your shared MQTT delivery semantics;
* its bidirectionality and instance model are less aligned with what `msgrpc` is doing.

A combination of `rpc-websockets` and custom MQTT code would mostly recreate the split-stack problem.

### MQTT+

MQTT+ is the most relevant MQTT-only alternative I found. It provides typed event and service patterns, source/sink streaming, JSON/CBOR encoding and its own MQTT packet conventions. ([GitHub][17])

It may be more attractive than `msgrpc` if streaming pipelines become the central problem. But it does not replace the browser transport. You would still combine it with tRPC, WAMP, Socket.IO or JSON-RPC and maintain a gateway between two programming models.

The most credible replacement path is therefore:

```text
tRPC or rpc-websockets for browsers
                  +
             MQTT+ for MQTT
                  +
             explicit gateway
```

That is a valid architecture, but it is not inherently simpler than maintaining `msgrpc`. It exchanges ownership of one small protocol for ownership of the integration between two frameworks.

## The path I would take

### Phase 1: stabilize the protocol

Before declaring the current generation stable:

1. Restore secure TLS verification.
2. Replace the HTTPS boolean shortcut with real TLS options.
3. Introduce signed MQTT frame version 2 covering every semantic field.
4. Honor and validate incoming MQTT Response Topics.
5. Add signed absolute deadlines and derive MQTT expiry from them.
6. Reject unknown content types and unsupported frame versions.
7. Document the browser/Socket.IO and industrial/MQTT topology explicitly.

These are protocol corrections and should happen before long-lived installations depend on the present wire behavior.

### Phase 2: define industrial command semantics

Add explicit concepts for:

* query versus idempotent versus non-repeatable command;
* online-only versus queued delivery;
* durable idempotency hooks;
* per-instance ordering;
* unknown command outcome;
* cancellation and deadlines;
* concurrency and packet-size limits.

This is where `msgrpc` could become materially better for industrial use than general-purpose web RPC libraries. Most RPC systems make it easy to call a function; fewer make the distinction between “the call failed” and “the caller lost the response after the physical command may have executed.”

### Phase 3: make the protocol independently verifiable

Publish alongside the package:

* a normative MQTT 5 wire specification;
* canonical signature test vectors;
* JSON and MessagePack examples;
* malformed-frame vectors;
* compatibility rules;
* a small conformance test suite;
* one implementation that does not use the `msgrpc` TypeScript runtime.

A plain MQTT.js implementation is already partly represented in your tests. A small Rust, C# or Node-RED reference client would demonstrate that the protocol can be implemented independently. That matters in industrial environments where a customer may eventually need a non-Node device or service.

Also ensure CI launches a real broker rather than allowing MQTT tests to silently skip when no broker is present. The current tests contain broker-dependent skip behavior, so CI should explicitly provide both MQTT 5 and compatibility configurations. 

A useful test matrix would cover:

* Mosquitto MQTT 5 and MQTT 3.1.1 compatibility;
* Socket.IO from Node and a Vite browser build;
* valid public TLS;
* private CA TLS;
* invalid TLS rejection;
* broker disconnection before and after request publication;
* process restart between side effect and response;
* duplicate delivery;
* queued request expiration;
* tampering with each signed property;
* multiple replicas using shared subscriptions;
* simultaneous calls to one mutable instance.

### Phase 4: polish the API without expanding scope

Only after the protocol is stable, I would consider:

* `await RpcClient.connect()` instead of constructor-plus-`ready()`;
* returning the typed remote proxy directly instead of requiring `.remote!`;
* optional package entry points such as `/core`, `/socketio` and `/mqtt`;
* an explicit transport option rather than URL-only inference;
* renaming or very clearly explaining `msgrpc`, since the name can imply gRPC wire compatibility.

I would **not** add more transports or broad framework features. Keep it small enough that you can reason about every delivery and security path.

# Final decision

For your use case, the choice is:

> **Use `msgrpc` as the focused RPC/event layer for Socket.IO browsers and MQTT 5 industrial services. Preserve the MQTT protocol design, correct the security and delivery issues, and resist turning it into a universal RPC framework.**

Moving to tRPC, WAMP, Nest or a WebSocket-RPC-plus-MQTT combination would not remove complexity. It would mostly relocate that complexity into gateways, duplicated contracts and mismatched delivery semantics.

The current implementation is worth continuing because it solves the unusual part of your problem: **one understandable RPC model spanning a browser-oriented connection and an industrial message broker**. The TLS default, signature coverage, response-topic handling and late-command behavior are the items that separate a promising internal library from something I would trust for production industrial commands.

[1]: https://github.com/source-repo/rpc/blob/main/packages/rpc/package.json "https://github.com/source-repo/rpc/blob/main/packages/rpc/package.json"
[2]: https://socket.io/docs/v4/ "https://socket.io/docs/v4/"
[3]: https://github.com/source-repo/rpc/blob/main/packages/rpc "https://github.com/source-repo/rpc/blob/main/packages/rpc"
[4]: https://github.com/source-repo/rpc/raw/refs/heads/main/packages/rpc/src/Transports/MqttTransport.ts "https://github.com/source-repo/rpc/raw/refs/heads/main/packages/rpc/src/Transports/MqttTransport.ts"
[5]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/RpcServerHandler.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/RpcServerHandler.ts"
[6]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/Transports/SocketIoClientTransport.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/Transports/SocketIoClientTransport.ts"
[7]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/Signing.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/Signing.ts"
[8]: https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md "https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md"
[9]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/RpcClientHandler.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RPC/RpcClientHandler.ts"
[10]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RpcClient.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/RpcClient.ts"
[11]: https://github.com/mqttjs/mqtt.js/ "https://github.com/mqttjs/mqtt.js/"
[12]: https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/Transports/SocketIoServerTransport.ts "https://raw.githubusercontent.com/source-repo/rpc/refs/heads/main/packages/rpc/src/Transports/SocketIoServerTransport.ts"
[13]: https://trpc.io/docs/server/websockets "https://trpc.io/docs/server/websockets"
[14]: https://wamp-proto.org/wamp_latest_ietf.html "https://wamp-proto.org/wamp_latest_ietf.html"
[15]: https://docs.nestjs.com/microservices/mqtt "https://docs.nestjs.com/microservices/mqtt"
[16]: https://github.com/elpheria/rpc-websockets "GitHub - elpheria/rpc-websockets: JSON-RPC 2.0 implementation over WebSockets for Node.js and JavaScript/TypeScript · GitHub"
[17]: https://github.com/rse/mqtt-plus "GitHub - rse/mqtt-plus: MQTT Communication Patterns · GitHub"
