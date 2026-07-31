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

This page is deliberately the ten-minute version. The full story currently lives in the package READMEs, and is moving here section by section:

- [`@source-repo/rpc`](https://github.com/source-repo/rpc/blob/main/packages/rpc/README.md) — commands and semantics, events and reconnection, observable components, command authority, topology and context, contracts and validation, authentication and signing, MQTT.
- [`@source-repo/rpc-cli`](https://github.com/source-repo/rpc/blob/main/packages/cli/README.md) — extract and check contracts, the browser console, taps, record and replay, fakes, the MCP server, `find` by capability.
- [`@source-repo/queue`](https://github.com/source-repo/rpc/blob/main/packages/queue/README.md) — the lease-based work queue.
- [Deploying a network](../deploying-a-network.md) — brokers, hubs, TLS and signing, and what a bus actually is.
