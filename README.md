# Source RPC

TypeScript RPC for a **network of peers** — a browser tab, a Node service, and a plant full of devices — over WebSocket and MQTT 5, with one programming model across all of them.

A class is the contract. There is no code generation, no schema language and no `.proto` file: the server hands one live instance to `exposeClassInstance`, the client compiles against the same class with `import type`, and calling a method on the typed proxy runs it on that instance.

```
npm install @source-repo/rpc
```

## If all you need is a browser and a Node server

Use [tRPC](https://trpc.io). It is very good at exactly that, it is far more widely used, and you will find more answers to your questions.

Come here when the shape is different — when there are *more than two* parties and they are not all on the same kind of link:

- devices on an MQTT broker and operator screens on a WebSocket, calling each other without either end knowing which transport the other is on
- peers that cannot listen — a browser tab hosting a service, a box behind NAT — that still need to be addressable by name
- commands that change something physical, where sending one twice is not free

## The problem it is built around

Most RPC libraries make it easy to call a function. Rather fewer distinguish *the call failed* from *I lost the answer to a command that may well have run* — and when the call opens a valve, that is the distinction that decides whether an operator sends a second start.

Retrying a read costs a round trip. Retrying a start costs a second start.

## A class is the contract

```typescript
// pump.ts — shared by both sides. No base class, and the decorators are optional.
export class Pump {
    private bar = 0

    @rpc({ semantics: 'query' })                    async pressure()             { return this.bar }
    @rpc({ semantics: 'idempotent-command' })       async setSetpoint(bar: number) { this.bar = bar }
    @rpc({ semantics: 'non-repeatable-command' })   async dispense()             { /* … */ }
}
```

The server holds one long-lived instance. State lives in fields, where you would have put it anyway; nothing is constructed or discarded per call.

```typescript
const server = new RpcServer({ name: 'plantServer', transports: [{ brokerurl: 'mqtt://plant:1883' }] })
server.exposeClassInstance(new Pump(), 'pump')
await server.ready()
```

The caller imports the **type** and none of the code, so the implementation never reaches a browser bundle.

```typescript
import type { Pump } from './pump.js'

const pump = await client.proxy<Pump>('pump', 'plantServer')
await pump.remote!.setSetpoint(4)
```

## The network

A peer is anything with a name, and a frame is addressed to a *name*, not to a socket. Once that is true, a server can call as well as answer, and a server that exposes nothing and forwards everything is a **bus** — so there is no separate broker implementation, and there should not be.

```
   browser tab              browser tab
   hosting a service        running the console
            │                       │
            └───────────┬───────────┘
                        │  WebSocket (socket.io)
                  ┌─────┴──────┐
                  │    bus     │  :7843   relays; exposes nothing
                  └─────┬──────┘
                        │  MQTT 5
        ┌───────────────┼───────────────┐
        │               │               │
   plantServer       cellSrv         ovenSrv
```

The console calls `ovenSrv` without knowing it is on MQTT. `ovenSrv` calls the browser tab without knowing it cannot listen. Peers announce themselves, so discovery is free — no scanning, no configured host list — and a peer is never advertised back down the link it came from, so brokers joined in a ring settle rather than storm.

## What you get that is hard to find elsewhere

- **A method declares what calling it does to the world.** `query`, `idempotent-command` or `non-repeatable-command` — part of the contract, not a comment. `source-rpc check` calls it a **breaking change** when a method becomes more dangerous to repeat than the version a caller was built against. Every type still lines up in that case, which is exactly why nothing else catches it.
- **`UnknownOutcome`.** *The request never left* is a different fact from *it left and nothing came back*. `TransportError` now means the first, so a caller can tell "certainly did not run" from "go and look before sending it again".
- **Commands that run once.** Give the server a durable [`RpcIdempotencyStore`](https://github.com/source-repo/rpc/tree/main/packages/rpc#commands) and a redelivery after a crash is answered from the record instead of executed again. It is consulted only for non-repeatable commands, the outcome is written *before* the answer goes out, and a store that cannot be reached refuses the command rather than failing open.
- **Deadlines that survive the trip.** A request carries the milliseconds its caller will still wait; the MQTT broker is given the same expiry; and the deadline is read again *after* the call has queued, so a command that waited out its caller is refused rather than run late.
- **Ordering where it matters.** One call at a time per instance, or per key — which is how a server fronting fifty devices keeps each device's commands in order without serialising itself behind the slowest of them.
- **Two transports, one model.** Including an [MQTT 5 wire format](https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md) that a plain MQTT.js peer can speak with none of this code — reply address, correlation, method and deadline are packet properties, not an opaque envelope.
- **Authentication on both sides of the seam.** Per-connection tokens where there is a connection, per-frame signing (HMAC or Ed25519) with replay protection where there is not. An authenticated name is pinned: a peer cannot address frames as another peer.

## The tooling is half the point

[`@source-repo/rpc-cli`](https://github.com/source-repo/rpc/tree/main/packages/cli) is not the usual thin wrapper. Because a server can describe itself, the CLI can do things an RPC library does not normally offer:

- **`tap`** — `tcpdump` for RPC. It pairs a call to its reply and reports the method and the latency, *neither of which is in the reply itself*, which is what a topic browser on the same wire cannot do. Armed by a call rather than a restart, because a plant bus that has to be restarted before it can be watched will not be watched.
- **`record` / `replay`** — capture a live session, replay it at the replacement device, exit 1 on divergence. A call that failed *the same way it failed when recorded* counts as a match, because otherwise no recording of a real plant is usable.
- **`check --peer`** — ask the box on the wall what it serves and compare that against the committed contract, using the same comparator the server runs at runtime. "Unchecked" is reported apart from "passed".
- **`serve --fail plant.halt=Timeout`** — a fake built from a contract, told to *never answer*. Staging a hang normally means pulling a cable.
- **`console`** and **`mcp`** — the live network in a browser, or handed to an AI assistant over [MCP](https://modelcontextprotocol.io): list the peers, describe them, call them, stand a fake one up.

## The two packages

| | |
| --- | --- |
| [`packages/rpc`](https://github.com/source-repo/rpc/tree/main/packages/rpc) | `@source-repo/rpc` — the library. Start here. |
| [`packages/cli`](https://github.com/source-repo/rpc/tree/main/packages/cli) | `@source-repo/rpc-cli` — the `source-rpc` command, and the container. |

ESM only, Node 18.17 or later, and it runs in the browser.

## Documentation

The two package READMEs are the complete reference for their package — every option, every command, every flag. The guides are task-shaped and cross both.

| guide | |
| --- | --- |
| [Deploying a network](https://github.com/source-repo/rpc/blob/main/docs/deploying-a-network.md) | broker, bus, console, ports, TLS, containers, and watching one that is already misbehaving |
| [Writing a simulator](https://github.com/source-repo/rpc/blob/main/docs/writing-a-simulator.md) | the four rungs from a fake built out of a contract to a peer of your own, and when to stop climbing |
| [The security model](https://github.com/source-repo/rpc/blob/main/docs/security-model.md) | what is checked where, why the two transports differ, and the limits stated plainly |
| [MQTT 5 frame spec](https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md) | the wire format, so a peer that is not this library can join |
| [Tooling roadmap](https://github.com/source-repo/rpc/blob/main/docs/tooling-roadmap.md) | what the CLI could become, and what each piece would cost |

| reference | |
| --- | --- |
| [`@source-repo/rpc`](https://github.com/source-repo/rpc/tree/main/packages/rpc#readme) | the library: connecting, commands, contracts, auth, MQTT, options |
| [`@source-repo/rpc-cli`](https://github.com/source-repo/rpc/tree/main/packages/cli#readme) | the command: console, tap, verbs, extract/check, serve, record, mcp |

## Run a whole network

The CLI is also an image, `ghcr.io/source-repo/rpc-cli`, whose entrypoint is the command itself — so one image is the bus, the console, the MCP server or the recorder depending on what it is asked to run.

```
docker run -d -p 7843:7843 ghcr.io/source-repo/rpc-cli          # a bus; broker is the default command
```

[`docker-compose/network.yml`](https://github.com/source-repo/rpc/blob/main/docker-compose/network.yml) brings up an MQTT broker, a bus and a console together, which is the shape a plant deploys:

```
echo "CONSOLE_TOKEN=$(openssl rand -hex 32)" > docker-compose/.env
docker compose -f docker-compose/network.yml up -d
open http://localhost:7844
```

## Ports

| | |
| --- | --- |
| `7843` | Source RPC — an `RpcServer`, or `source-rpc broker` |
| `7844` | anything serving a browser, such as `source-rpc console` |
| `1883` / `8083` | MQTT, and MQTT over WebSocket |

Adjacent, and deliberately clear of the 80xx range where the rest of a developer's work already lives. One process needs one port: a page and its RPC share a listener. Given `--cert` and `--key` the pair becomes **8843** and **8844** — a thousand above rather than beside, so no firewall range can open a clear-text port while meaning to publish only the encrypted one.

## What it does not do

**Delivery and execution are at least once, unless the method is guarded by a durable idempotency store.** That is true of every RPC system without one; the difference is whether it is written down.

Relaying is not brokering: nothing is queued for a peer that is not connected, and discovery reports reachability rather than routes. There is no cancellation — a deadline bounds a call, but nothing tells a running method to stop, and doing that properly needs handler cooperation a library cannot supply. The full list, with the reasoning, is in [the library README](https://github.com/source-repo/rpc/tree/main/packages/rpc#commands).

## Development

```
npm install          # installs both workspaces
npm run build
npm test             # the MQTT tests need a broker:
                     # docker compose -f docker-compose/docker-compose.yml up -d
```

Without a broker the MQTT tests skip themselves, which is right on a laptop and wrong in CI; `SOURCE_RPC_REQUIRE_BROKER=1` turns the skip into a failure, and the workflow sets it alongside the broker it starts.

[`docs/mqtt5-frame-spec.md`](https://github.com/source-repo/rpc/blob/main/docs/mqtt5-frame-spec.md) describes the wire format. [`CHANGELOG.md`](https://github.com/source-repo/rpc/blob/main/CHANGELOG.md) covers what breaks between versions.

The packages and the command were renamed in 3.0 — `msgrpc` became Source RPC — but **the protocol did not change**. Topic prefixes are still `msgrpc/v1` and `msgrpc/v2`, introspection is still the `msgrpc` namespace, and MQTT 5 user properties still carry the `mr-` prefix: renaming those would strand every deployed peer for no engineering gain.

MIT.
