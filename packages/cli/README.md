# @source-repo/msgrpc-cli

Tooling for [msgrpc](https://www.npmjs.com/package/@source-repo/msgrpc): read a contract out of TypeScript source, fail a build when it
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
msgrpc broker    run a WebSocket bus for peers with no MQTT broker to share
```

| flag | commands | default | meaning |
| --- | --- | --- | --- |
| `--project <tsconfig.json>` | extract, check | `tsconfig.json` | the project to read |
| `--out <file>` | extract | `msgrpc.types.json` | where to write the contract |
| `--against <file>` | check | `msgrpc.types.json` | the contract to compare against |
| `--keep-history` | extract | off | move the previous contract into `history` when the version changed |
| `--broker <url>` | console | — | an MQTT network, e.g. `mqtt://localhost:1883` |
| `--hub <url>` | console | — | a socket.io network, e.g. `http://hub:8080`. One of `--broker`/`--hub` is required; both watches both |
| `--prefix <topic>` | console | the transport's own | must match the network you are watching |
| `--port <n>` | console | `7300` | |
| `--host <address>` | console | `127.0.0.1` | see the warning it prints before widening this |
| `--timeout <ms>` | console | `10000` | call timeout |
| `--name <peer>` | console | `console-<three words>` | how the console identifies itself to the network |
| `--sign <keyfile>` | console | — | HMAC keys, so the console can talk to a signed network |
| `--port <n>` | broker | `8080` | listens on every interface |
| `--name <peer>` | broker | `broker-<three words>` | how the broker identifies itself |
| `--upstream <url>` | broker | — | join another broker; repeatable |
| `--quiet` | broker | off | stop logging peers arriving and leaving |

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
  plant.lookup return is a Map, which MsgPack does not carry; use an object or an array (src/plant.ts:18)
```

So far: generics, function parameters, `Map` and `Set`, and a type that is part dictionary and part
declared shape — `{ name: string; [tag: string]: unknown }` — which would need describing both
halves at once. Dropping either one produces a contract that looks checked and is not.

At most 25 diagnostics are printed, followed by a count of the rest.

### What it can and cannot see

`Date` and `Uint8Array` come through as values rather than encodings of them, because MsgPack
carries both. Recursive types become named references. `Promise<T>` is unwrapped.

An index signature becomes a `record`, so `{ [tag: string]: Reading }` is described by its value
type with the keys left open, and a wrong reading is still caught. `{ [id: number]: string }` gets a
key pattern instead of a numeric key type, because a JS object key is always a string on the wire.

A generic instantiation is inlined rather than named: `Record<string, number>` and
`Record<string, string>` share the symbol `Record`, so keying both under it would quietly make the
second a reference to the first's value type.

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

## broker

```
msgrpc broker --port 8080
```

A bus for networks that have no MQTT broker to share. It runs until Ctrl-C, relaying between the
peers that connect to it and telling each of them who else is there — which is what MQTT gives you
through retained presence and per-peer topics, over one WebSocket port instead.

```
msgrpc broker plantBus on port 8085
  + cellBus (:8085)
  + panel1 (:8085)
  + hmi (:8085)
```

Peers join it by dialling out, which is also the only thing a browser page can do:

```typescript
const panel = new RpcServer({ name: 'panel1', transports: [{ connect: 'http://bus:8080' }] })
panel.exposeClassInstance(new Panel(), 'panel')      // now callable by anything else on the bus
```

There is no separate broker implementation and there should not be: this is an `RpcServer` that
exposes nothing. A peer addressing the broker by name gets `ClassNotFound`, which is the truth —
it is a switchboard, not a service.

### Joining two brokers

`--upstream` dials another broker, and the two become one network. Each side's peers are advertised
to the other, and a call crosses without either end knowing there was a hop:

```
msgrpc broker --port 8085 --name plantBus
msgrpc broker --port 8086 --name cellBus --upstream http://plant:8085
```

A peer on `cellBus` is then callable from `plantBus` and the other way round. Repeat `--upstream` to
join more than one. Loops are handled — a peer is never advertised back along the link it came from,
and frames carry a hop count and are dropped after 8 relays — so brokers dialling each other in a
ring settle rather than storm.

### What it is not

**Not a store-and-forward broker.** Nothing is queued for a peer that is not connected: a frame is
handed to a peer that is there now, or reported as unroutable. If a peer needs to receive what was
sent while it was down, that is what MQTT and `persistentSession` are for.

**Not authenticated.** It listens on every interface and relays for whoever connects, without
checking who they are, and it says so on startup. Put it behind a network you trust, or build one
from the library with `authenticate` and a `relay` rule.

## console

```
msgrpc console --broker mqtt://localhost:1883      # an MQTT network
msgrpc console --hub http://hub:8080               # a socket.io network
msgrpc console --broker mqtt://... --hub http://... # both at once
```

Opens a console at `http://127.0.0.1:7300` listing every peer that is up, what each one exposes, a
form to call it, and a live stream of its events.

**Discovery costs nothing.** Every peer announces itself, so the console is handed everyone already
online the moment it connects. There is no scan, no probe and no configured list of hosts. Over MQTT
that is retained presence under `<prefix>/presence/+`; over socket.io the hub keeps the list.

With both, one list covers both networks and each peer is called over the link it was found on —
which is the useful shape when a plant runs on a broker and the HMIs are browser pages. A peer
hosted *in* a browser shows up like any other, since a page that dials a hub can serve as well as
call.

A peer only appears in detail if its server was started with `exposeIntrospection`; otherwise the
console says so rather than guessing.

### Calling a method

Each method folds open into a form with **one field per argument**, built from the argument's own
type rather than asking for the whole call as a JSON array:

| the schema says | you get |
| --- | --- |
| `number`, with `min`/`max` | a number input carrying those bounds |
| a union of literals | a dropdown of exactly those values |
| `boolean` | a checkbox |
| `date` | a date and time picker |
| `bytes` | a hex field |
| an object or a named type | a JSON box **pre-filled with the shape's required fields** |

Optional arguments have a checkbox that decides whether they are sent at all, so
`writeSetpoint(1200)` and `writeSetpoint(1200, 'auto')` are both reachable. Argument names come
from `paramNames` in the contract, which `extract` writes — without a contract the form falls back
to positions, since nothing else knows what argument 0 is called.

JSON has no date and no byte string, so what is typed into a JSON box is walked against the type
before it is sent: an ISO string where the schema says `date` becomes a `Date`. Otherwise every
object with a timestamp in it would be rejected by the server that asked for one.

### The console describes itself

The console ships its own contract, extracted from its own source, so pointing one console at
another gives argument fields rather than `call(…)`:

```
npm run contract        # extract --project tsconfig.contract.json --out src/console.types.json
npm run check:contract  # the same comparison the server applies to an older caller
```

The file is committed, which is what makes it reviewable and lets `check:contract` fail a build that
would refuse a page built against the old one. This was also the first thing to need `record`:
`describe()` returns a `ServerDescription`, which is built out of `{ [name: string]: TypeNode }` —
so until the type language could describe a dictionary, it could not describe its own output.

### Watching events

The watch button toggles, and unwatching drops the server's subscription too rather than only
silencing the browser — the subscriber count next to the event moves with it. Closing the console
unsubscribes everything it held, so a debugging session does not leave listeners behind on servers
that outlive it.

### How it is built

The browser half is a React app talking to the CLI **over msgrpc itself**. The CLI runs an
`RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace
(`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events; the page is an
ordinary `RpcClient`. There is no REST API and no server-sent events, and the console is the
library's own first client — a bug in event routing shows up here before it reaches a plant.

Everything is bundled into the CLI's `dist`: no CDN, no runtime download. A plant network usually
has no route to the internet, and a page that fetches from one renders blank exactly where it is
needed.

`npm run dev:web` in the package serves the app with hot reload against a console started
separately on port 7300.

### Signed networks

A server configured with `verify` drops unsigned frames before the RPC layer. Without keys the
console still lists peers — presence is unsigned retained state — and then every call times out with
nothing to say why. Give it keys with `--sign`:

```
msgrpc console --broker mqtt://broker:1883 --sign console-keys.json
```

```json
{
  "name": "console-1",
  "secret": "the console's own HMAC secret",
  "peers": { "plantServer": "that server's secret" }
}
```

A file rather than a flag, because a secret on the command line is visible to anyone who can run
`ps`. The console warns if the file is readable by other users.

`peers` is optional. Supplying it makes the console check signatures on what it receives as well,
which means frames from an unsigned peer are then dropped.

The server checks a signature against the key it holds for the name the frame claims, so the
console's name has to be the one its key belongs to. `name` in the file supplies it; passing a
`--name` that contradicts the file is refused rather than left to surface as a timeout.

HMAC only. For Ed25519 or an HSM, build the console with the library's `startConsole` and pass your
own `MessageSigner`.

### Other limits

**It binds to `127.0.0.1` by default.** The console can invoke any method it is allowed to, so
exposing it has to be a deliberate act: `--host 0.0.0.0` works and prints a warning saying what you
have just done.

**Credentials are thin.** Broker credentials work if they fit in the url (`mqtt://user:pass@host`);
TLS client certificates have nowhere to go yet. A hub that authenticates needs a handshake token,
which has no flag for the same reason the signing keys do not — build the console from the library's
`startConsole` and pass `hubCredentials`.

**`--prefix` is MQTT's.** A socket.io hub has no topic namespace, so the flag does nothing for
`--hub`. Watching two MQTT networks at once is not possible either; it is one broker and one hub.

**Give it its own name on a busy network.** The default is unique per process, but a peer name maps
to an MQTT client id and a broker allows one connection per id, so two consoles sharing a `--name`
will disconnect each other.
