# @source-repo/msgrpc-cli

Reads an [msgrpc](../msgrpc) contract out of TypeScript source, and checks it for breaking changes.

```
npm install --save-dev @source-repo/msgrpc-cli

msgrpc extract --project tsconfig.json --out msgrpc.types.json
msgrpc check   --project tsconfig.json --against msgrpc.types.json
```

## Declaring the contract

The namespace is declared in the source, because static analysis cannot see the name a class is
eventually exposed under at some `exposeClassInstance` call elsewhere. Methods opt in with `@rpc`,
so the contract is the allow-list rather than everything on the prototype chain.

```typescript
import { rpc, rpcNamespace } from '@source-repo/msgrpc'

@rpcNamespace('plant', { version: '2' })
export class Plant {
    declare rpcEvents: { alarm: [message: string, severity: number] }

    @rpc async writeSetpoint(value: number, mode?: 'auto' | 'manual') { ... }
    async internalOnly() { ... }        // unmarked, so absent from the contract
}
```

Events are declared as a property type rather than inferred from `emit()` calls, which cannot be
read statically with any confidence.

## What it refuses to describe

Anything the type language cannot represent is **reported, never emitted as `any`**: generics,
function parameters, `Map` and `Set`. A schema that quietly degrades on the parts it could not read
still looks like protection while checking nothing, so `extract` writes no file when it hits one.

```
msgrpc: 3 types could not be described
  plant.fetch return is generic (T), which has no runtime type to check (src/plant.ts:6)
  plant.subscribe argument 0 is a function, which cannot be checked on the wire (src/plant.ts:12)
  plant.lookup return is a Map, which MsgPack does not carry; use an object or an array (src/plant.ts:18)
```

`Date` and `Uint8Array` are values rather than encodings of them, because MsgPack carries both.
Recursive types become named references.

## Checking for breaking changes

`check` compares the source against a stored contract using the **same comparison the server
applies at runtime** to a caller declaring an older version, so a change that would refuse an
existing peer is caught before it ships:

```
$ msgrpc check
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
msgrpc: 1 breaking change against msgrpc.types.json
$ echo $?
1
```

Parameters may widen and returns may narrow; the reverse breaks callers. Adding an optional
argument or field is safe, adding a required one is not.

`extract --keep-history` moves the previous contract into `history` when the version changes, which
is what lets both this check and the server recognise an older caller.
