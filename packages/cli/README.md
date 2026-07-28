# @source-repo/msgrpc-cli

Tooling for [msgrpc](../msgrpc): read a contract out of TypeScript source, fail a build when it
changes in a way that would break a deployed peer, and browse a live network in a browser.

```
npm install --save-dev @source-repo/msgrpc-cli
```

ESM only, Node 18.17 or later.

## Commands

```
msgrpc extract   write the contract described by the source to a file
msgrpc check     compare the source against a written contract, exit 1 on a breaking change
msgrpc console   browse a live network: peers, what they expose, calls and events
```

| flag | commands | default | meaning |
| --- | --- | --- | --- |
| `--project <tsconfig.json>` | extract, check | `tsconfig.json` | the project to read |
| `--out <file>` | extract | `msgrpc.types.json` | where to write the contract |
| `--against <file>` | check | `msgrpc.types.json` | the contract to compare against |
| `--keep-history` | extract | off | move the previous contract into `history` when the version changed |
| `--broker <url>` | console | required | e.g. `mqtt://localhost:1883` |
| `--prefix <topic>` | console | the transport's own | must match the network you are watching |
| `--port <n>` | console | `7300` | |
| `--host <address>` | console | `127.0.0.1` | see the warning it prints before widening this |
| `--timeout <ms>` | console | `10000` | call timeout |
| `--name <peer>` | console | `msgrpc-console-<pid>` | how the console identifies itself to the network |

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

## extract

```
msgrpc extract --project tsconfig.json --out msgrpc.types.json
```

It describes **the files your tsconfig includes**, not everything they import. A decorated class in
a dependency belongs to that dependency's contract, not yours.

Nothing is executed: the decorators are read from the syntax tree, so `extract` never runs your
code.

### What it refuses to describe

Anything the type language cannot represent is **reported, never emitted as `any`**, and a run with
any diagnostic writes no file. A schema that quietly degrades on the parts it could not read still
looks like protection while checking nothing.

```
msgrpc: 3 types could not be described
  plant.fetch return is generic (T), which has no runtime type to check (src/plant.ts:6)
  plant.subscribe argument 0 is a function, which cannot be checked on the wire (src/plant.ts:12)
  plant.readings return has an index signature, which the schema type language cannot describe yet (src/plant.ts:18)
```

So far: generics, function parameters, `Map` and `Set`, and index signatures. The last is the one to
know about — `{ [id: string]: Reading }` has no named properties, so describing it as an ordinary
object would produce a type that refuses every value.

At most 25 diagnostics are printed, followed by a count of the rest.

### What it can and cannot see

`Date` and `Uint8Array` come through as values rather than encodings of them, because MsgPack
carries both. Recursive types become named references. `Promise<T>` is unwrapped.

What it cannot see is anything the type system does not carry. `value: number` becomes
`{ kind: 'number' }` — a range like `0..2000` is a runtime invariant, invisible to TypeScript.
Extraction gives you shape checking: types, arity, whether an argument is required. Bounds have to
be added to the schema afterwards or expressed in the type.

## check

```
msgrpc check --project tsconfig.json --against msgrpc.types.json
```

Compares the source against a stored contract using the **same comparison the server applies at
runtime** to a caller declaring an older version, so a change that would refuse a deployed peer
fails the build instead:

```
$ msgrpc check
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
msgrpc: 1 breaking change against msgrpc.types.json
$ echo $?
1
```

Parameters may widen and returns may narrow; the reverse breaks callers. Adding an optional argument
or field is safe, adding a required one is not. Events run the other way, since the server emits and
the caller receives.

`extract --keep-history` moves the previous contract into `history` when the version changes, which
is what lets both this check and the server recognise an older caller.

## console

```
msgrpc console --broker mqtt://localhost:1883
```

Opens a console at `http://127.0.0.1:7300` listing every peer that is up, what each one exposes, a
form to call it, and a live stream of its events.

**Discovery costs nothing.** Every peer publishes retained presence, so subscribing to
`<prefix>/presence/+` hands over everyone already online the moment the console connects. There is
no scan, no probe and no configured list of hosts.

A peer only appears in detail if its server was started with `exposeIntrospection`; otherwise the
console says so rather than guessing.

The watch button toggles, and unwatching drops the server's subscription too rather than only
silencing the browser — the subscriber count next to the event moves with it. Closing the console
unsubscribes everything it held, so a debugging session does not leave listeners behind on servers
that outlive it.

The page is served from the CLI with no CDN, no bundler and no framework — one HTTP handler, an
inlined page, and server-sent events for the live half. A plant network usually has no route to the
internet, and a tool for looking at one should be something you can read in a sitting.

### What it needs, and what it cannot do yet

**It binds to `127.0.0.1` by default.** The console can invoke any method it is allowed to, so
exposing it has to be a deliberate act: `--host 0.0.0.0` works and prints a warning saying what you
have just done.

**MQTT only.** It connects as an ordinary MQTT peer, so a network served purely over WebSocket
cannot be browsed with it.

**It does not sign its frames.** A server configured with `verify` drops unsigned frames before the
RPC layer, so the console cannot talk to a signed network — calls simply time out. Broker
credentials work if they fit in the url (`mqtt://user:pass@host`), but client certificates and
signing keys have nowhere to go yet.

**Give it its own name on a busy network.** The default is unique per process, but a peer name maps
to an MQTT client id and a broker allows one connection per id, so two consoles sharing a `--name`
will disconnect each other.
