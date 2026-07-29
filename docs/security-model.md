# The security model

What is checked, where it is checked, and what is not checked at all. The last part matters most: a library that is vague about its limits is one you will trust further than it deserves.

The shape of the answer is set by one fact. **socket.io has a connection and MQTT does not.** A connection can be authenticated once and then trusted, because it is the same connection for the life of the peer. An MQTT broker delivers a message with a `source` field written by whoever sent it, and there is nothing underneath it to check. So the two transports are secured by different mechanisms, and neither substitutes for the other.

| | socket.io | MQTT 5 |
| --- | --- | --- |
| who a peer is | authenticated at the handshake | signed per frame, or trusted from broker credentials |
| what enforces it | `authenticate` | `verify`, or the broker's own ACLs |
| what it proves | this connection is that peer | this frame came from that peer |
| privacy | TLS | TLS, and broker ACLs |

## A name is a claim until something vouches for it

Every frame carries a `source`. It is written by the sender, so on its own it is evidence of nothing.

An **authenticating socket.io transport** pins the connection to the identity its credentials resolved to, and then refuses any frame claiming a different source — and refuses a presence announcement claiming a different name, so an impostor is never even listed. A stolen token therefore gets a socket and nothing else.

That pinning extends to the routing table: a frame's source is registered as a peer only *after* the identity check, so a rejected frame cannot leave a peer that does not exist in the registry, nor point lookups for a real peer's name at a link where nothing answers.

**Signing** does the same job where there is no connection. The signature covers everything the receiver acts on — source, target, method, arguments, the error code, the declared contract version, the deadline, the content type and the reply address — with a nonce so a captured frame cannot be replayed. A verifier returns an identity, and the transport refuses the frame if that identity is not the source it claims. So a peer holding its own valid key cannot sign as another peer.

Signed frame **version 2** is not backward compatible on purpose: accepting version 1 as well would let a sender choose the weaker form. Unsigned MQTT peers are unaffected, because an unsigned frame's version says nothing about security.

## Tokens: one per peer

`createTokenAuthenticator` maps a bearer token to the one peer name it admits.

```typescript
authenticate: createTokenAuthenticator({
    [process.env.PLANT_TOKEN!]: 'plantServer',
    [process.env.HMI_TOKEN!]: { name: 'hmi', roles: ['operator'] }
})
```

**There is deliberately no single-secret form.** A token that maps to a name is evidence of *who* is calling, which is what the pinning above turns into a guarantee. A single token everyone shares proves only that the caller is inside the fence — and any holder can then claim to be the peer whose commands matter. Blank tokens, grants with no name and an empty map all throw at construction rather than admitting more than they look like they do.

`source-rpc broker --auth <file>` is the same thing for the bus. The flag names a path, never a secret, because `ps` is readable by everyone on the box; `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS` say the same two things for a container.

## Authorization is a separate question

Authentication says who is calling. `authorize` decides whether *this* call is allowed, and runs for event subscriptions too — without that, anyone could attach to an instance's events and receive everything it emits.

An authorizer that throws **denies**. Failing open would turn a bug in the authorizer into an access-control bypass.

A relay rule is the same idea one layer down: `relay` decides whether a bus will forward between two peers at all, and is asked once per pair, covering the reply — asking per frame would strand the answer coming back.

## What the bus does and does not do

A broker with no `--auth` **relays for anyone that can reach the port**, and says so on startup. Every peer name on it is an unchecked claim. That is a reasonable thing to run on a trusted network and a bad thing to expose.

`bus.tap()` mirrors every frame crossing the broker to whoever asks. It is gated by the same authentication as everything else — but on an unauthenticated bus it is a very convenient way to read all the traffic. Anyone who could call it could already have impersonated a peer; the tap merely makes it one call. The broker says this out loud at startup too.

An upstream broker joined with `--upstream` is a *peer* of this one, not an operator of it. Frames relay across the join, but a call to this broker's own `bus` namespace from across it is refused, because a connection this broker dialled is not one it authenticated.

## Running code you supplied

Two features run code that did not come from your repository. They are separate flags because they are different sizes of grant.

**`--allow-exec`** permits JavaScript or Python method bodies in a fake's script. The JavaScript context has no `require`, no `process` and no filesystem, and a handler that never returns is cut off rather than wedging the peer. That stops a careless handler, not a hostile one: `node:vm` is documented as not being a security mechanism, and Python is a subprocess with no confinement at all.

**`--scripts <dir>`** permits whole programs, run as their own processes with the privileges of whoever started the server. That is strictly more than the above — a script can open sockets and read your disk.

**The flag is the security boundary in both cases, not the runtime.** They are development-machine features. Neither is enabled in the container, and a script asking for exec without the flag is refused at startup rather than served with its handlers quietly dropped.

## TLS

`{ port, tls: { cert, key } }` serves HTTPS, and WSS with it. There is no `https: true` boolean, because a server with no key material listens, completes no handshake, and refuses every client with an error about certificates — so the material is what asks for one.

For a plant with its own certificate authority, pass `ca` rather than switching checking off. `allowInsecureTls` exists, is off, and is documented as unsafe: anything able to answer on that address can then read and rewrite what you send, which over this library means industrial commands.

Given `--cert` and `--key` the CLI moves itself from 7843/7844 to 8843/8844 — a thousand above rather than adjacent, so no firewall range can open a clear-text port while meaning to publish only the encrypted one.

## The honest limits

**Delivery and execution are at least once**, unless the method is guarded by a durable idempotency store. That is true of every RPC system without one; the difference is whether it is written down. See [Commands](https://github.com/source-repo/rpc/tree/main/packages/rpc#commands).

**Signing proves origin, not privacy.** It does not encrypt anything. Any MQTT client permitted to subscribe to `<prefix>/#` reads all of it. Only broker ACLs and TLS prevent that.

**`authenticate` does not apply to MQTT.** There is no server-side handshake to run it in. Trust there comes from broker credentials and ACLs, or from signing.

**Relaying is not brokering.** Nothing is queued for a peer that is not connected, so a frame is delivered to a peer that is there now or reported as undeliverable.

**Introspection is off by default**, and the management surface — the one method that constructs an instance remotely — is off separately and subject to `authorize` when on. Before 2.0.0 the whole management surface was published unauthenticated; if you are upgrading from that, treat it as having been reachable.

**Extraction cannot see runtime invariants.** `value: number` becomes `{ kind: 'number' }`; a bound that matters has to be added to the contract by hand, and the validator will then enforce it.
