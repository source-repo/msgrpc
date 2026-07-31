# Exposing methods

`exposeClassInstance` walks the prototype chain and publishes every function it finds, so a helper a class never meant to offer becomes callable by anyone who can reach the transport. Marking the intended methods turns that into an allow-list.

```typescript
import { rpc, rpcNamespace } from '@source-repo/rpc'

@rpcNamespace('plant', { version: '2' })
class Plant {
    @rpc async writeSetpoint(value: number) { ... }
    @rpc async readSetpoint() { ... }
    async wipeConfiguration() { ... }        // unmarked, so unreachable
}

server.exposeClassInstance(new Plant())      // name taken from @rpcNamespace
```

Standard ECMAScript decorators, so no `experimentalDecorators` is needed. Marks are inherited, so a subclass keeps its parent's. Without decorators, `exposeMethods(Plant, ['writeSetpoint'])` does the same and rejects names that are not methods.

A class that marks nothing publishes every method on its prototype chain, which is what makes the plain style above work. Set `requireExplicitExposure` on `RpcServer` to refuse such a class instead, which makes the discipline enforceable across a project.

`@rpcNamespace` also tells the extraction CLI which namespace a class belongs to, since the name would otherwise exist only at the `exposeClassInstance` call site.

Both decorators take options: `@rpc({ semantics: 'non-repeatable-command' })` says what calling a method does to the world, and `@rpcNamespace('cell', { execution: 'serial' })` says whether calls into the instance may overlap. Both are in [Commands](./commands.md), which is where they matter.

### More than one, and without a class

A server exposes as many namespaces as you like, and a client takes a proxy per namespace:

```typescript
server.exposeClassInstance(new Plant(), 'plant')
server.exposeClassInstance(new History(), 'history')
server.exposeObject({ ping: () => 'pong' }, 'health')      // a plain object's own functions

const plant = await client.proxy<Plant>('plant')
const history = await client.proxy<History>('history')
```

`exposeObject` publishes an object's own function properties rather than a prototype chain, which suits a handful of functions that never wanted to be a class.
