# MQTT

Servers and clients addressed by name over a broker, which is how a network of them is usually put together. The different servers are addressed by their `name`.

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

**Both ends must agree on the prefix.** An `mqtt://` url gives the client the default `msgrpc/v2`, so a server that sets its own is unreachable from a client that does not — and it fails as a call timeout, which says nothing about why. There is no client option for it, so build the transport:

```typescript
import { MqttTransport } from '@source-repo/rpc'

const transport = new MqttTransport('hmi-1', 'mqtt://broker:1883', { prefix: 'site-4' })
const client = new RpcClient(undefined, { name: 'hmi-1', transport, defaultTarget: 'plantServer' })
```

The same applies to every `MqttTransportOptions` field: the url form takes the defaults, and anything else means constructing the transport yourself.

### Topics

MQTT 5 is the default. Reply address, correlation and method travel as packet properties, so a peer with no msgrpc code can take part and standard tooling can read the traffic. [`docs/mqtt5-frame-spec.md`](https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md) describes the layout in full.

```
<prefix>/req/<peer>        calls and subscribe requests            default prefix msgrpc/v2
<prefix>/rsp/<peer>        results and errors
<prefix>/evt/<peer>        events pushed to a subscriber
<prefix>/presence/<peer>   retained: "online", or "offline" via the last will
```

Set `protocol: 4` for a broker that does not speak MQTT 5. That uses the older `$`-delimited header on `<prefix>/rpc/<peer>` under a default prefix of `msgrpc/v1`, so the two layouts never share a topic and can run side by side during a migration.

**Peer names are validated.** A name is one topic level, so `#`, `+`, `/`, spaces, an empty name and names over 128 characters are rejected when the transport is constructed. Without this a peer named `#` subscribed to `<prefix>/#` and received every other peer's requests and replies.

### Delivery and sessions

**QoS 1 by default.** QoS 0 drops messages silently whenever the broker or link hiccups, which surfaces as an unexplained call timeout. At-least-once permits duplicate delivery, so the server suppresses repeats by request id and answers them from a cache rather than running the method again — a redelivered `writeSetpoint` must not execute twice. Publishes are awaited, so a failure to reach the broker rejects the call instead of vanishing.

**Presence replaces the connection MQTT does not have.** Each peer registers a retained last will, so when it disappears the broker publishes `offline` on its behalf and servers release the event subscriptions they held for it. Without this those subscriptions leaked forever, because an MQTT server never sees a disconnect. A peer that closes gracefully announces `offline` and then clears its retained value, so it leaves nothing behind on the broker.

**Sessions.** Servers connect with a stable client id and a persistent session, so requests published while they restart are queued rather than lost. Under MQTT 5 the session is bounded by `sessionExpirySeconds`; under 3.1.1, which has no expiry, clients use a clean session instead.

> **Expose before awaiting `ready()`.** A resumed session is handed its queued requests the moment it connects. Anything exposed after `await server.ready()` is registered too late for them, and those callers get `ClassNotFound`. Construct, expose, then await:
>
> ```typescript
> const server = new RpcServer({ transports: [{ brokerurl }] })
> server.exposeClassInstance(new Plant(), 'plant')   // before, not after
> await server.ready()
> ```

**Peer names must be unique.** A peer's MQTT client id derives from its name, and a broker allows one connection per client id, so a second peer using the same name disconnects the first.

### Replicas

Set `sharedGroup` and several processes can serve one peer name, with the broker distributing requests among them. Each replica needs its own `replicaId`, because of the client id rule above. Only the request channel is shared — a reply has to reach the requester waiting for it. Replicas keep no session, since a dead replica's share of the queue would never be drained, and they observe presence without announcing it: one replica's will would otherwise declare the whole group offline. Event subscriptions still bind to the replica that handled them, so events do not fan out across a group.

### What the broker still has to do

MQTT has no server-side handshake, so `authenticate` does not apply to MQTT transports and `identity` is undefined for MQTT callers unless frames are signed. Trust otherwise comes from the broker:

- Set broker credentials or TLS client certificates through the transport's `mqtt` options.
- Restrict which peer may publish or subscribe to which topic with broker ACLs.
- `authorize` still runs, but its `source` is only as trustworthy as those ACLs make it.

A server mixing an authenticating socket.io transport with an MQTT transport will reject its MQTT peers, because `requireAuthenticatedPeers` turns on with `authenticate`. Set it `false` explicitly to allow both and rely on the broker for the MQTT half.

**msgrpc cannot hide MQTT traffic.** Peer names can no longer widen their own subscription, but anyone holding broker credentials can subscribe to `<prefix>/#` and read everything. Only broker ACLs prevent that. Signing, below, makes a message's origin checkable — it does not make it private.

### Signing frames

Without a connection to authenticate, `source` is a claim. Signing each frame makes it checkable, so a broker operator — or any peer whose ACLs let it publish to another peer's topic — cannot forge a message from someone else.

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

Once `verify` is set, a frame must be signed, fresh, unreplayed and signed by the key on file for the name it claims — otherwise it is dropped before reaching the RPC layer and a `rejected` event carries the reason. A verified peer becomes an `RpcIdentity`, so `requireAuthenticatedPeers` and `authorize` work over MQTT exactly as they do over WebSocket.

The signature covers everything that decides what a frame means and where it goes, encoded as a JSON array of those fields followed by the payload bytes. The array fixes field order and escapes values, so no combination of names can be made to look like a different frame. Under MQTT 5 that includes the destination topic, since the topic is what carries the addressing; the exact field list is in the frame spec.

**Replay protection.** A signature does not stop a captured frame being sent again, which for RPC means replaying a command. Each frame carries a nonce, and a receiver rejects frames outside `maxClockSkew` (default 60 s) or whose nonce it has already seen. Peers therefore need clocks within that window of each other; the window also bounds how many nonces must be remembered.

**HMAC is symmetric.** Whoever can verify a peer's messages can also forge them, so an HMAC secret must only be shared with parties allowed to act as that peer. Where a compromised server must not be able to impersonate its peers, use `createEd25519Signer` / `createEd25519Verifier`, which take WebCrypto keys directly and leave only public keys on the verifying side.

Both are built on WebCrypto, so the same signer works in Node and in the browser. To use an HSM or another algorithm, supply your own `MessageSigner` / `MessageVerifier` — the built-ins are only conveniences.
