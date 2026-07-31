# Getting started

Source RPC is TypeScript RPC for a network of peers — a browser tab, a Node service, and a plant full of devices — over socket.io and MQTT 5, with one programming model across all of them.

A class is the contract: the server hands one live instance to `exposeClassInstance`, the client gets a typed proxy of the same class, and calling a method on the proxy runs it on that instance. No code generation and no schema files required, though there is a schema when you want arguments checked at runtime.

```
npm install @source-repo/rpc
```

ESM only, Node 22 or later, and it runs in the browser.

**If all you need is a browser talking to a Node server, use [tRPC](https://trpc.io).** It is very good at that and far more widely used. This is for the case it does not cover: more than two parties, not all on the same kind of link, and commands where sending one twice is not free.

## The class both sides share

Nothing here is Source RPC-specific — no decorators, no base class:

```typescript
// calculator.ts
export class Calculator {
    private memory = 0

    async square(n: number) {
        return n * n
    }

    async add(n: number) {
        this.memory += n
        return this.memory
    }
}
```

## The server

With no transports configured it listens on WebSocket (socket.io) port 7843:

```typescript
import { RpcServer } from '@source-repo/rpc'
import { Calculator } from './calculator.js'

const server = new RpcServer()
server.exposeClassInstance(new Calculator(), 'calculator')
await server.ready()
```

## A client

In another Node process, a browser page, or the same process for testing:

```typescript
import { RpcClient } from '@source-repo/rpc'
import type { Calculator } from './calculator.js'    // the type only - see below

const client = new RpcClient('http://localhost:7843')
await client.ready()

const calculator = await client.proxy<Calculator>('calculator')
console.log(await calculator.square(3))      // 9
console.log(await calculator.add(10))        // 10
console.log(await calculator.add(5))         // 15 - one instance, holding its own state

await client.close()
```

Three things worth noticing:

**The instance is a real, long-lived object.** It is constructed once, by you, and every call runs against that same object — which is why `add` accumulates. State lives where you would put it anyway, in fields.

**`import type`** on the client is the point of the whole design: the client compiles against the class but imports none of its code, so the implementation never reaches the browser bundle. In a monorepo, put the class in a package both sides depend on. If the client cannot see the class at all, describe the surface with an `interface` instead and pass that to `proxy<T>()`.

**`proxy()` hands back the instance**, so calling a remote method reads like calling a local one. Two names are reserved on a proxy: `$with` attaches per-call options — an idempotency key, a timeout, an owner fence — and `then` answers `undefined` so `await` does not adopt the proxy as a promise.

## Where to go next

This page is deliberately the ten-minute version.

- [Connecting](./connecting.md) — what a network of these looks like: ports, buses, discovery, serving over a connection you open.
- [Commands](./commands.md) — semantics, idempotency, serialised execution, the bounded mailbox.
- [Observable components](./components.md) — cached props and state, statuses that tell the truth, React integration.
- [Command authority](./authority.md) and [Topology](./topology.md) — the plant's arbitration concept, and where everything sits.
- [Contracts and validation](./contracts.md) — schemas, runtime checking, serving older callers, `describe()`.
- [The command line](../tools/cli.md), [the console](../tools/console.md) and [the MCP server](../tools/mcp.md).
- [Deploying a network](../deploying-a-network.md) — brokers, hubs, TLS and signing, and what a bus actually is.
