# @source-repo/msgrpc

Modular TypeScript communications and RPC system. Use msgrpc to communicate between Node.JS instances, or between a browser page and a server.

`npm install @source-repo/msgrpc`

msgrpc works best with TypeScript, but plain JavaScript works although it is more error prone.

# High level interface

## RPC server

Start by creating a server in NodeJS. The first example here uses the default transport WebSocket (socket.io) on port 3000.

```typescript
const rpcServer = new RpcServer()
```

Add some RPC functionality

```typescript
class TestRpc {
  async square(n: number) {
    return n * n
  }
}

const testRpc = new TestRpc()
rpcServer.exposeClassInstance(testRpc, 'testRpc')
```



## RPC client

The create a RPC client in another NodeJS app, a web app or the same NodeJS app (for testing).

```typescript
const rpcClient = new RpcClient()
await rpcClient.ready()
```

Now get a proxy for the server functionality

```typescript
const proxy = await rpcClient.proxy<TestRpc>('testRpc')
```

And finally call the server method

```typescript
proxy.remote.square(3)
```

# Advanced usage

A RPC server can have multiple transports defined in an optional RpcServerOptions object. This can make the RPC functionality available on multiple WebSocket channels and also via MQTT messaging.

When using MQTT a network of RPC clients and servers can be easily realized. The different servers are addressed using their `name` property.

```typescript
interface RpcServerOptions {   
    name: string
    transports: (HttpServerOptions | ExternalServerOptions | MqttServerOptions | GenericModule)[]
    useMsgPack: boolean
}
```

name: The server name used when routing RPC messages

transports: An array of one or more transport methods:

```typescript
export interface ServerOptions {
    description: string
}

export interface HttpServerOptions extends ServerOptions {
    port: number
    https: boolean
    path: string
}

export interface ExternalServerOptions extends ServerOptions {
    server: Server
    path: string
}

export interface MqttServerOptions extends ServerOptions {
    brokerurl: string
}
```

useMsgPack: MsgPack is default, set to `false` for JSON. MsgPack encodes `Uint8Array` natively, so
binary arguments and return values survive a round trip unchanged. JSON does not.

## RPC client options

```typescript
interface RpcClientOptions {
    name: string
    transport?: GenericModule
    defaultTarget?: string
    useMsgPack: boolean
    callTimeout: number
    readyTimeout: number
    failCallsOnDisconnect: boolean
}
```

name: how this client identifies itself. Responses and events are addressed to it, so it must be
unique across peers sharing a server. Defaults to a UUID.

transport: supply one to take full control of the link. When omitted, one is built from the url.

callTimeout: how long a call waits for a response before rejecting with an `RpcError` of code
`Timeout`. Default 10000 ms.

readyTimeout: how long `ready()` waits for the transport to connect before throwing. Default
30000 ms; `0` waits forever.

failCallsOnDisconnect: reject in-flight calls as soon as the link drops rather than letting each
wait out its own timeout. Default `true`.

# Exposing methods

`exposeClassInstance` walks the prototype chain and publishes every function it finds, so a helper
a class never meant to offer becomes callable by anyone who can reach the transport. Marking the
intended methods turns that into an allow-list.

```typescript
import { rpc } from '@source-repo/msgrpc'

class Plant {
    @rpc async writeSetpoint(value: number) { ... }
    @rpc async readSetpoint() { ... }
    async wipeConfiguration() { ... }        // unmarked, so unreachable
}
```

A standard ECMAScript decorator, so no `experimentalDecorators` is needed. Marks are inherited, so
a subclass keeps its parent's. Without decorators, `exposeMethods(Plant, ['writeSetpoint'])` does
the same and rejects names that are not methods.

A class that marks nothing keeps the old behaviour and exposes everything. Set
`requireExplicitExposure` on `RpcServer` to refuse such a class instead, which makes the discipline
enforceable across a project.

# Checking arguments

Types are a compile-time promise between a client and a server that share a class. Nothing about
MQTT or a browser page guarantees the caller is one of those - a Python historian or a Node-RED
flow calling in over MQTT 5 shares none of your types - so a schema lets the server check what it
was actually sent.

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

The type language is small on purpose. It describes what MsgPack actually carries, so `bytes`
(`Uint8Array`) and `date` are values rather than string encodings, and it is checkable without
pulling a validation engine into a package that ships to browsers and embedded targets. `ref` names
a shared or recursive type; nesting beyond 32 levels is refused rather than exhausting the stack.

| option | effect |
| --- | --- |
| `validation: 'described'` | check the namespaces the schema covers, let the rest through (default when a schema is given) |
| `validation: 'required'` | refuse anything the schema does not describe |
| `validation: 'off'` | disable checking without removing the schema |
| `validateResults` | check what handlers return too; off by default, since it is a self-check |

Set `validate: false` on a namespace to skip a hot path where the cost is not worth paying.
Validating `writeSetpoint(number)` is not the same proposition as validating a ten-thousand element
telemetry array on every publish.

`version` on a namespace is a diagnostic, not a gate. The receiver always checks against its own
schema, and that check *is* the compatibility test; the version exists so a caller built against an
older contract is recognisable as one instead of looking like a caller sending rubbish. The
`history` field is reserved for a future extraction tool, which can compare a regenerated schema
against the versions stored there and refuse a breaking change before it ships.

# Errors

A call rejects with an `RpcError` carrying a `code`, the remote `message`, and the remote stack in
`remoteStack` when the peer sent one.

```typescript
import { RpcError } from '@source-repo/msgrpc'

try {
    await proxy.remote.square(3)
} catch (e) {
    if (e instanceof RpcError) console.log(e.code, e.message, e.remoteStack)
}
```

| code | meaning |
| --- | --- |
| `Exception` | the exposed method threw |
| `MethodNotFound` | the instance exists but the method is not exposed |
| `ClassNotFound` | nothing is exposed under that name |
| `Timeout` | no response within `callTimeout` |
| `TransportError` | the link dropped, or the message could not be encoded or sent |
| `Unauthorized` | the caller is not authenticated and the server requires it |
| `Forbidden` | the caller is authenticated but not permitted this call |
| `InvalidParams` | the arguments do not match the schema for that method |

# Connection lifecycle

`RpcClient` is an `EventEmitter` that reports the state of its link, so an application can show it
rather than infer it from failed calls.

```typescript
import { TransportEvent } from '@source-repo/msgrpc'

rpcClient.on(TransportEvent.disconnected, (reason) => console.log('link lost:', reason))
rpcClient.on(TransportEvent.connected, ({ restoredSubscriptions }) =>
    console.log('link back, subscriptions restored:', restoredSubscriptions))
```

Reconnection is handled for you:

- The underlying transport reconnects on its own (socket.io and mqtt.js both do).
- On every reconnect the client replays its event subscriptions. This restores server-side state if
  the server restarted, and re-identifies the client to the server so pushed events reach it again.
- Replaying is idempotent: the server will not stack a second listener for a subscription it
  already holds.
- When a client's connection drops, the server releases the event subscriptions it held for it.

# Authentication and authorization

Both are off by default, so an unconfigured server accepts any peer and allows any exposed call.
One thing is *not* off by default: the management surface. See below.

## Authenticating peers

`authenticate` receives whatever the client sent as `credentials` and returns an identity to accept
the peer, or `undefined` to reject it. Rejected peers never reach the RPC layer - the check runs as
socket.io middleware, before the connection is established at all.

```typescript
const server = new RpcServer({
    transports: [{ port: 3000 }],
    authenticate: async (credentials) => {
        const token = (credentials as { token?: string }).token
        const user = await lookUpToken(token)
        return user && { name: user.id, roles: user.roles }
    }
})
```

```typescript
const client = new RpcClient('http://localhost:3000', {
    name: 'operator-17',              // must equal the identity's name, see below
    credentials: { token: 'a-token' }
})
```

**`RpcClientOptions.name` must match `RpcIdentity.name`.** The `source` field of a message is
written by the sender, so it is a claim, not evidence. An authenticating transport pins each
connection to the name it authenticated as and drops frames claiming any other source. Without
that, an authenticated peer could address its calls as another peer and inherit its rights.

## Authorizing calls

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

## MQTT

MQTT has no server-side handshake to authenticate against - both peers connect to a broker, not to
each other - so `authenticate` does not apply to MQTT transports and `identity` is undefined for
MQTT callers. Trust comes from the broker instead:

- Set broker credentials or TLS client certificates through the transport's `mqtt` options.
- Restrict which peer may publish or subscribe to which topic with broker ACLs.
- `authorize` still runs, but its `source` is only as trustworthy as those ACLs make it.

A server that mixes an authenticating socket.io transport with an MQTT transport will reject its
MQTT peers, because `requireAuthenticatedPeers` turns on with `authenticate`. Set it to `false`
explicitly to allow both, and rely on the broker for the MQTT half.

**msgrpc cannot isolate MQTT peers from each other on its own.** Peer names can no longer widen
their own subscription (see below), but anyone holding broker credentials can subscribe to
`<prefix>/rpc/#` directly and read every peer's traffic. Only broker ACLs prevent that. Grant each
peer publish/subscribe rights to its own topics and nothing else.

Signing, below, closes the other half: it makes a message's origin checkable without trusting the
broker, and gives MQTT peers a real identity that `authorize` can use.

## Signing MQTT frames

Without a connection to authenticate, `source` is a claim. Signing each frame makes it checkable,
so a broker operator - or any peer whose ACLs let it publish to another peer's topic - cannot forge
a message from someone else.

```typescript
import { createHmacSigner, createHmacVerifier } from '@source-repo/msgrpc'

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

Once `verify` is set, a frame must be signed, fresh, unreplayed and signed by the key on file for
the name it claims - otherwise it is dropped before reaching the RPC layer and a `rejected` event
is emitted with the reason. A verified peer becomes an `RpcIdentity`, so `requireAuthenticatedPeers`
and `authorize` work over MQTT exactly as they do over WebSocket.

The signature covers source, target, time, seq, nonce and the payload, encoded as a JSON array of
the header fields followed by the payload bytes. The array fixes field order and escapes the
values, so no combination of names can be made to look like a different frame.

**Replay protection.** A signature does not stop a captured frame being sent again, which for RPC
means replaying a command. Each frame carries a nonce, and a receiver rejects frames outside
`maxClockSkew` (default 60 s) or whose nonce it has already seen. Peers therefore need clocks
within that window of each other; the window also bounds how many nonces must be remembered.

**HMAC is symmetric.** Whoever can verify a peer's messages can also forge them, so an HMAC secret
must only be shared with parties allowed to act as that peer. Where a compromised server must not
be able to impersonate its peers, use `createEd25519Signer` / `createEd25519Verifier`, which take
WebCrypto keys directly and leave only public keys on the verifying side.

Both are built on WebCrypto, so the same signer works in Node and in the browser. To use an HSM or
another algorithm, supply your own `MessageSigner` / `MessageVerifier` - the built-ins are only
conveniences.

**Peer names must be unique.** A peer's MQTT client id is derived from its name, and a broker
allows one connection per client id, so a second peer using the same name disconnects the first.

## The management surface

`manageRpc` is **not exposed by default**. Enabling it publishes exactly one method,
`createRpcInstance`, which constructs an instance of a class already passed to `exposeClass()`:

```typescript
const server = new RpcServer({ transports: [{ port: 3000 }], exposeManagement: true })
```

It is still subject to `authorize`, so you can restrict who may create instances.

The `expose*` methods are never remotely reachable. Prior versions published all of `ManageRpc`
under `manageRpc`, with no authentication anywhere, so any peer that could reach the transport
could:

- call `createRpcInstance` to construct any class passed to `exposeClass()`, with attacker-chosen
  constructor arguments;
- call `exposeObject` / `exposeClassInstance` to overwrite an existing exposed name, replacing a
  live instance with inert data and denying service to every other client;
- call the logger, which was exposed the same way, to write arbitrary log entries.

A remote caller can only send serialized data, so it could not publish *callable* methods of its
own choosing. If you are upgrading, treat the first two as reachable by anyone who could open a
socket or publish to the broker topic.

# MQTT

Every peer owns two topics under a configurable prefix:

```
<prefix>/rpc/<peer>        RPC messages addressed to <peer>
<prefix>/presence/<peer>   retained: "online", or "offline" via the last will
```

```typescript
interface MqttTransportOptions {
    prefix?: string             // default 'msgrpc/v1'
    topic?: string              // peer name to subscribe as, defaults to the transport name
    qos?: 0 | 1 | 2             // default 1
    presence?: boolean          // default true
    persistentSession?: boolean // default false; RpcServer sets it true for its own transports
    mqtt?: IClientOptions       // credentials, TLS, keepalive, clientId
}
```

```typescript
const server = new RpcServer({
    name: 'plantServer',
    transports: [{ brokerurl: 'mqtt://broker:1883', prefix: 'site-4', mqtt: { username: 'plant', password: '...' } }]
})

const client = new RpcClient('mqtt://broker:1883', {
    name: 'hmi-1',
    defaultTarget: 'plantServer',
    credentials: { username: 'hmi', password: '...' }   // MQTT credentials go to the broker
})
```

**Peer names are validated.** A name is one topic level, so `#`, `+`, `/`, spaces, an empty name
and names over 128 characters are rejected when the transport is constructed. Without this a peer
named `#` subscribed to `<prefix>/#` and received every other peer's requests and replies.

**QoS 1 by default.** QoS 0 drops messages silently whenever the broker or link hiccups, which
surfaces as an unexplained call timeout. At-least-once permits duplicate delivery, so the server
suppresses repeats by request id and answers them from a cache rather than running the method
again - a redelivered `writeSetpoint` must not execute twice. Publishes are awaited, so a failure
to reach the broker rejects the call instead of vanishing.

**Presence replaces the connection MQTT does not have.** Each peer registers a retained last will,
so when it disappears the broker publishes `offline` on its behalf and servers release the event
subscriptions they held for it. Without this those subscriptions leaked forever, because an MQTT
server never sees a disconnect. A peer that closes gracefully announces `offline` and then clears
its retained value, so it leaves nothing behind on the broker.

**Sessions.** Servers connect with a stable client id and a persistent session, so requests
published while they restart are queued rather than lost. Under MQTT 5 the session is bounded by
`sessionExpirySeconds`, so it does not outlive the process indefinitely; under 3.1.1, which has no
expiry, clients use a clean session instead.

> **Expose before awaiting `ready()`.** A resumed session is handed its queued requests the moment
> it connects. Anything exposed after `await server.ready()` is registered too late for them, and
> those callers get `ClassNotFound`. Construct, expose, then await:
>
> ```typescript
> const server = new RpcServer({ transports: [{ brokerurl }] })
> server.exposeClassInstance(new Plant(), 'plant')   // before, not after
> await server.ready()
> ```

**Replicas.** Set `sharedGroup` and several processes can serve one peer name, with the broker
distributing requests among them. Each replica needs its own `replicaId`, because a broker permits
one connection per client id. Only the request channel is shared - a reply has to reach the
requester waiting for it. Replicas keep no session, since a dead replica's share of the queue would
never be drained, and they observe presence without announcing it: one replica's will would
otherwise declare the whole group offline. Event subscriptions still bind to the replica that
handled them, so events do not fan out across a group.

# Browser use

The `browser` export condition resolves to a build whose static dependencies are `socket.io-client`,
`@msgpack/msgpack`, `uint8array-extras`, `uuid` and `events`. The MQTT client is **not** among them:
`RpcClient` imports it on demand, so a bundle only carries it if an `mqtt://` url is actually used,
in which case bundlers place it in a separate chunk.

`events` is a real dependency rather than a `node:` builtin so bundlers can substitute the browser
shim. Signing uses WebCrypto, which browsers expose only in a secure context (https, or localhost).

# Peer routing

Each `RpcServer` and `RpcClient` owns a `PeerRegistry`, shared by its own modules and nothing wider:
transports record which peer a message arrived from, and the switch reads it back to send the reply
out of the same transport. Entries are dropped when a peer disconnects and the registry is bounded,
since the keys arrive from remote peers.

This used to be one process-wide static. Two servers in a single process that saw the same peer name
would overwrite each other's routes, and one server's reply could be delivered through the other's
transport - to a different client. Peer names must be unique within a graph; across separate
`RpcServer` instances they no longer interfere.

# Low level interface

Additional transports, message formats and connections can be implemented using msgrpc Modules.

## Modules

msgrpc works by plugging together modules in order to solve the desired messaging task.

A module can receive, process and send messages. In this context, *sending* does not mean that it goes over a network, but rather from one module to another within the same environment. Also, a *message* in this context can be any JavaScript value - not just strings or binary data. 

By creating a chain of modules by combining the included modules, as well as creating new ones if needed, you can create a customized solution.

### Using modules

A module must implement the base IGenericModule interface. This interface declares a *receive* function which, as the name suggests, is the function that you want to call whenever the module should receive a message. 

So, to send a message to a module, you would call the *receive* function on that module. In reality you would usually not call this function directly - you would instead *pipe* two modules together.

#### Piping

Modules also have a function named *pipe*. This function will tell the module that it should send its messages to the module passed as parameter, effectively creating a connection from one module to the next.

```typescript
let module1 = new MyModule()
let module2 = new MyModule()
module1.pipe(module2)
```

In this example, when module1 sends a message, it reaches out to module2 and calls its *receive* function, along with the message.

There is also a shorthand for this:

```typescript
let module1 = new MyModule()
let module2 = new MyModule([module1])
```

This example is exactly the same as the one above, but shorter.

You can also pipe a module into a function. The function will be called for each message that the module wants to send.

```typescript
let module1 = new MyModule()
module1.pipe((message) => {
    console.log('module1 wanted to send: ', message)
})
```

### Exceptions

When a module receives a message and an exception is thrown, it is propagated back each pipe, back to the original sender. You can catch these errors either at the original sender when calling `this.send`, or by using the TryCatch module.

```typescript
let module1 = new MyModule()
let tryCatch = new TryCatch([module1])
let module2 = new ModuleThatThrows([module2])

tryCatch.on('caught', (message, err) => {
    console.log('The error was caught!')
})
```

In this example, if module2 would throw an exception, the error would not be propagated back to module1. Instead, the event listener would fire and we would see an output in our log.

The receive function of a module can be asynchronous (return a Promise), and if the promise rejects, it would also be propagated in the same way as an exception would.

### Creating modules

To create a module, extend the base GenericModule class (or technically, the base IGenericModule interface). The base class takes care of piping.

To send a message from your module to all pipes, use `this.send(message)`. This is a protected method only accessible from within the module instance.

Take a look within the source code for examples on how to create modules.

### Utility modules

There are a few basic utility modules included with msgrpc. These are:

- **Converter** - Takes a function as a parameter. For each received message, the function is called and the return value is sent to each piped module.
- **Filter** - Takes a function which returns a boolean as a parameter. For each received message, the function is called and if the function returns a true, the message is sent to each piped module. If not, the message is not sent.
- **Switch**  - Allows messages to be sent to a specific target. A message whose target cannot be
  resolved is dropped.
- **TryCatch** - Catches exceptions (more above).

There are also a few more complex modules included:

- **RpcServer / RpcClient** - Remote procedure call.
- **SocketIoTransport** - WebSocket for both Node.JS and the browser.
- **MqttTransport** - MQTT transport

### WebSocket example

Let's look at a real-world example.

```typescript
import { SocketIoClientTransport } from '@source-repo/msgrpc'

// Create a WebSocket client
let transport = new SocketIoClientTransport('ws://localhost:3000')

transport.pipe((message) => {
    console.log('Received message: ' + message)
})

transport.receive('Sending this message over WS')
```

The SocketIoClientTransport will pass a message through the pipe each time it receives a message over the WebSocket connection. This example will open up a WebSocket connection to localhost, send a message and log each incoming message.

#### RPC over WebSocket

The power of modules is shown when you want to process messages. Here is an example of an RPC server using WebSocket.

```typescript
import { SocketIoClientTransport, Converter, RpcServerHandler, TryCatch } from '@source-repo/msgrpc'

// Create a server which listens on 0.0.0.0:3000
const server = new SocketIoServerTransport('server', undefined, 3000)

// Parse each incoming message
const parser = new Converter([server], (message) => {
    return JSON.parse(message.toString())
})

// Send each parsed message to an RPC server
const rpcServerHandler = new RpcServerHandler('server', [parser])

// Serialize each outgoing message using JSON.stringify
const stringifier = new Converter([rpcServerHandler], (message) => {
    return JSON.stringify(message)
})

// Try to send the message back. If we fail (probably the client disconnected), do nothing.
const tryCatch = new TryCatch([stringifier])
tryCatch.pipe(server)

// Expose a function
rpcServerHandler.manageRpc.exposeObject({
    Hello: () => {
        return 'World!'
    }
}, 'MyRpc')
```

And here is the client:

```typescript
import { SocketIoClientTransport, JsonParser, RpcClientHandler, JsonStringifier } from '@source-repo/msgrpc'

// Create a WebSocket client which connects to the server.
// The same transport works in Node.js and in the browser.
const transport = new SocketIoClientTransport('ws://localhost:3000')

// Parse each incoming message
const parser = new JsonParser([transport])

// Send each parsed message to a RPC client
const rpcClientHandler = new RpcClientHandler('client', [parser])

// Serialize each outgoing message
const stringifier = new JsonStringifier([rpcClientHandler])
stringifier.pipe(transport)

// Create a JavaScript proxy object which allows us to call the RPC functions. The service name should match the exposed object on the server ("MyRpc").
let proxy = rpcClientHandler.proxy('MyRpc')

// Should output Hello World!
console.log('Hello ' + await proxy.remote.hello())
```
# Development

```
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs ava
npm run lint
npm run typecheck  # src and examples, no emit
```

The MQTT test needs a broker on `localhost:1883`; it skips itself when none is reachable. To run
it, bring one up first:

```
docker compose -f docker-compose/docker-compose.yml up -d
```

Point the tests at a different broker with `MSGRPC_TEST_BROKER=mqtt://host:1883`.
