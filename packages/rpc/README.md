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

TypeScript RPC for a network of peers — a browser tab, a Node service, and a plant full of devices — over socket.io and MQTT 5, with one programming model across all of them.

A class is the contract: the server hands one live instance to `exposeClassInstance`, the client gets a typed proxy of the same class, and calling a method on the proxy runs it on that instance. No code generation and no schema files required, though there is a schema when you want arguments checked at runtime.

```
npm install @source-repo/rpc
```

ESM only, Node 22 or later, and it runs in the browser.

**Documentation: [source-repo.github.io/rpc](https://source-repo.github.io/rpc/)** — the guide, the tools and the operations pages, with search.

**If all you need is a browser talking to a Node server, use [tRPC](https://trpc.io).** It is very good at that and far more widely used. This is for the case it does not cover: more than two parties, not all on the same kind of link, and commands where sending one twice is not free.

## Quick start

```typescript
// calculator.ts - nothing here is Source RPC-specific
export class Calculator {
    private memory = 0
    async square(n: number) { return n * n }
    async add(n: number) { this.memory += n; return this.memory }
}
```

```typescript
// The server. With no transports configured it listens on WebSocket (socket.io) port 7843.
import { RpcServer } from '@source-repo/rpc'
import { Calculator } from './calculator.js'

const server = new RpcServer()
server.exposeClassInstance(new Calculator(), 'calculator')
await server.ready()
```

```typescript
// A client - another process, a browser page, or the same process for testing.
import { RpcClient } from '@source-repo/rpc'
import type { Calculator } from './calculator.js'    // the type only: no implementation in the bundle

const client = new RpcClient('http://localhost:7843')
await client.ready()

const calculator = await client.proxy<Calculator>('calculator')
console.log(await calculator.square(3))      // 9
console.log(await calculator.add(10))        // 10
console.log(await calculator.add(5))         // 15 - one instance, holding its own state
```

## What is in it

- **[Command semantics for machinery.](https://source-repo.github.io/rpc/guide/commands)** A method declares whether repeating it is free, harmless or dangerous; a caller can tell *did not run* from *may have run*; a durable idempotency hook makes a redelivered command run once; declared commands serialise per instance behind a bounded mailbox, and setpoint-shaped commands can conflate.
- **[Observable components.](https://source-repo.github.io/rpc/guide/components)** Cached `props` and `state` snapshots with epoch/revision ordering, a per-channel status of `initializing | live | stale | closed` that keeps last-known data readable, and a store that plugs straight into `useSyncExternalStore`.
- **[Command authority.](https://source-repo.github.io/rpc/guide/authority)** `$acquire`/`$release` — the plant's arbitration concept: granted, visible in every snapshot, always expiring, with only declared methods ever gated, so an E-stop is never behind a held lease.
- **[Topology and context.](https://source-repo.github.io/rpc/guide/topology)** Every host answers for where its components sit — physically and logically — with durable epochs, an owner fence on calls, and [inherited context](https://source-repo.github.io/rpc/guide/context) resolved across hosts with atomic remounts.
- **[Two transports, one model.](https://source-repo.github.io/rpc/guide/connecting)** socket.io for browsers and anything that dials out; MQTT 5 for the plant, with a [documented wire format](https://source-repo.github.io/rpc/mqtt5-frame-spec) a plain MQTT.js peer can speak. Any peer can be a bus, and a browser tab can host a server.
- **[Contracts checked at runtime](https://source-repo.github.io/rpc/guide/contracts)**, compared between versions so a change that would break a deployed caller fails a build rather than a plant — and `describe()`, so a server reports what it exposes.
- **[Authentication both ways.](https://source-repo.github.io/rpc/guide/security)** Per-connection tokens where there is a connection, per-frame signing (HMAC or Ed25519) where there is not, `authorize()` on every call and subscription, TLS with a plant's own CA.

## Related packages

- [`@source-repo/rpc-cli`](https://www.npmjs.com/package/@source-repo/rpc-cli) is the tooling: contract extraction, the browser console, taps, record/replay, fakes, an MCP server and find-by-capability.
- [`@source-repo/queue`](https://www.npmjs.com/package/@source-repo/queue) is a lease-based work queue for Source RPC networks: every-value work with leases, retries, dead letters and capacity that refuses rather than drops.
- `@source-repo/sparkplug` is planned as the Sparkplug B integration package: selected Source RPC components projected as Sparkplug Edge Nodes, Devices and metrics, with ingestion and commands added in later milestones.

Upgrading? [`CHANGELOG.md`](https://github.com/source-repo/rpc/blob/main/CHANGELOG.md) lists what changed, release by release, with the reasoning.
