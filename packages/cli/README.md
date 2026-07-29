```
███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗███████╗
██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝██╔════╝
███████╗██║   ██║██║   ██║██████╔╝██║     █████╗
╚════██║██║   ██║██║   ██║██╔══██╗██║     ██╔══╝
███████║╚██████╔╝╚██████╔╝██║  ██║╚██████╗███████╗
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝
██████╗ ██████╗  ██████╗      ██████╗██╗     ██╗
██╔══██╗██╔══██╗██╔════╝     ██╔════╝██║     ██║
██████╔╝██████╔╝██║     ████╗██║     ██║     ██║
██╔══██╗██╔═══╝ ██║     ╚═══╝██║     ██║     ██║
██║  ██║██║     ╚██████╗     ╚██████╗███████╗██║
╚═╝  ╚═╝╚═╝      ╚═════╝      ╚═════╝╚══════╝╚═╝
```

# @source-repo/rpc-cli

Tooling for [Source RPC](https://www.npmjs.com/package/@source-repo/rpc): read a contract out of TypeScript source, fail a build when it changes in a way that would break a deployed peer, browse a live network in a browser, and hand that same network to an AI assistant over [MCP](https://modelcontextprotocol.io) — list the peers, describe them, call them, stand a fake one up, watch what they say to each other.

```
npm install --save-dev @source-repo/rpc-cli
```

The command is `source-rpc`. ESM only, Node 18.17 or later. It was `msgrpc` before 3.0.

## What you would not expect

What a CLI usually ships for an RPC library is a code generator. A Source RPC server describes itself at runtime, so this one is a set of instruments instead — and these five are the ones people are surprised to find:

- **[The traffic tap](#the-traffic-tap)** — `tcpdump` for RPC. It pairs a call to its reply and reports the method and the latency, *neither of which is in the reply itself*, which is exactly what a topic browser pointed at the same wire cannot do. Armed by a call rather than a restart, because a plant bus that has to be restarted before it can be watched will not be watched.
- **[`record` and `replay`](#record-and-replay)** — capture a live session, replay it at the replacement device, and exit 1 on divergence. A call that failed *the same way it failed when recorded* counts as a match, because otherwise no recording of a real plant is usable.
- **[`check --peer`](#checking-the-device-rather-than-the-build)** — ask the box on the wall what it serves and compare that against the committed contract, using the comparator the server itself applies at runtime. A peer with no contract is reported as *unchecked*, not as passing.
- **[`serve --fail plant.halt=Timeout`](#serve)** — a fake built from a contract and told to *never answer*. Staging a hang usually means pulling a cable.
- **[`mcp`](#mcp)** — the live network as tools for a model: list the peers, describe one, call it, or stand a fake up from a contract passed inline.

## Commands

**Contracts**

```
source-rpc extract   write the contract described by the source to a file
source-rpc check     compare the source against a written contract, exit 1 on a breaking change
source-rpc diff      compare what two live peers expose
```

**A live network**

```
source-rpc console   browse it in a browser: peers, what they expose, calls and events
source-rpc broker    run a WebSocket bus for peers with no MQTT broker to share, with a traffic tap
source-rpc mcp       serve the network to an MCP client over stdio
source-rpc peers     who is on the network right now
source-rpc describe  what one peer exposes
source-rpc call      call a method, and exit 1 if the peer refuses
source-rpc watch     stream a peer's events as jsonl until Ctrl-C
```

**Testing against it**

```
source-rpc serve     stand a peer up from a contract, for an HMI with no plant to talk to
source-rpc record    write what the network is carrying to a file
source-rpc replay    send a recording's calls at a peer and compare the answers
source-rpc bench     call one method over and over and report what it cost
```

## Contents

**A live network** — [console](#console) · [Presence](#presence) · [Problems](#problems) · [The traffic tap](#the-traffic-tap) · [peers, describe, call, watch](#peers-describe-call-watch)

**Contracts** — [Declaring the contract](#declaring-the-contract) · [extract](#extract) · [check](#check) · [diff](#diff)

**Testing against it** — [serve](#serve) · [record and replay](#record-and-replay) · [bench](#bench)

**Running it** — [broker](#broker) · [mcp](#mcp) · [Ports](#ports) · [Flags](#flags)

## console

```
source-rpc console --broker mqtt://localhost:1883      # an MQTT network
source-rpc console --hub http://hub:7843               # a socket.io network
source-rpc console --broker mqtt://... --hub http://... # both at once
```

Opens a console at `http://127.0.0.1:7844` listing every peer that is up, what each one exposes, a form to call it, and a live stream of its events.

**Discovery costs nothing.** Every peer announces itself, so the console is handed everyone already online the moment it connects. There is no scan, no probe and no configured list of hosts. Over MQTT that is retained presence under `<prefix>/presence/+`; over socket.io the hub keeps the list.

With both, one list covers both networks and each peer is called over the link it was found on — which is the useful shape when a plant runs on a broker and the HMIs are browser pages. A peer hosted *in* a browser shows up like any other, since a page that dials a hub can serve as well as call.

A peer only appears in detail if its server was started with `exposeIntrospection`; otherwise the console says so rather than guessing.

**One port.** The page, `console.json` and the RPC link all arrive on 7844: socket.io answers `/socket.io` on the same listener the static app is served from. There is no second port to open and no CORS to configure, because the page and its server share an origin.

### Behind a reverse proxy

The console can be published under a path. Nothing needs configuring — the page works out where it was served from and hangs everything off that, so its assets, `console.json` and its socket all land back on the same mount:

```nginx
location /tools/console/ {
    proxy_pass http://console:7844/;      # the trailing slashes matter, on both lines
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Two things that will bite otherwise. **Both paths must end in `/`** — the page resolves everything relative to its mount point, and `/tools/console` without the slash resolves one level up, so the app asks `/tools/` for its files. And the `Upgrade` headers are what let socket.io leave long polling for a WebSocket; without them it still works, and quietly costs a round trip per frame.

That rule **strips** the prefix, which is what the trailing slash on `proxy_pass` does. For a proxy that forwards it through unchanged — `proxy_pass http://console:7844;`, no slash, or an ingress that does not rewrite — tell the console where it is published:

```
source-rpc console --hub http://bus:7843 --base-path /tools/console
source-rpc console on http://127.0.0.1:7844/tools/console/, watching http://bus:7843 as console-…
```

The page, its assets, `console.json` and socket.io then all answer under that path and nowhere else: a request to `/` gets a 404 rather than the app, because the rest of that origin belongs to whatever the proxy publishes beside it. `/tools/console` without the slash redirects to `/tools/console/`, since that is the only place the relative paths come out right.

Both ends of the same idea: the page always asks relative to where it was served, and `--base-path` tells the *server* to expect the prefix. Use it only when the proxy keeps the prefix — with a stripping rule it would put the console one level deeper than the proxy is looking.

### Calling a method

Each method folds open into a form with **one field per argument**, built from the argument's own type rather than asking for the whole call as a JSON array:

| the schema says | you get |
| --- | --- |
| `number`, with `min`/`max` | a number input carrying those bounds |
| a union of literals | a dropdown of exactly those values |
| `boolean` | a checkbox |
| `date` | a date and time picker |
| `bytes` | a hex field |
| an object or a named type | a JSON box **pre-filled with the shape's required fields** |

Optional arguments have a checkbox that decides whether they are sent at all, so `writeSetpoint(1200)` and `writeSetpoint(1200, 'auto')` are both reachable. Argument names come from `paramNames` in the contract, which `extract` writes — without a contract the form falls back to positions, since nothing else knows what argument 0 is called.

JSON has no date and no byte string, so what is typed into a JSON box is walked against the type before it is sent: an ISO string where the schema says `date` becomes a `Date`. Otherwise every object with a timestamp in it would be rejected by the server that asked for one.

### The console describes itself

Both services this package runs — the CLI's `console` namespace and the `chat` namespace the page hosts — ship a contract extracted from their own source, so pointing one console at another gives argument fields rather than `call(…)` and `say(…)`:

```
npm run contract        # extract both, into src/console.types.json and web/src/chat.types.json
npm run check:contract  # the same comparison the server applies to an older caller
```

The files are committed, which makes them reviewable and lets `check:contract` fail a build that would refuse a peer built against the old one. A test asserts they still match their source, since a service changed without re-extracting would ship a contract describing the old shape.

The console's own contract was the first thing to need `record`: `describe()` returns a `ServerDescription`, built out of `{ [name: string]: TypeNode }` — so until the type language could describe a dictionary, it could not describe its own output.

The chat contract is the one that has to survive a bundler. `@rpc` and `@rpcNamespace` are standard ECMAScript decorators, and they come through Vite's build intact — which is also what keeps the namespace called `chat` rather than the minified class name, and what `extract` reads statically to write the contract in the first place.

### Watching events

**Watch all** takes every event in a namespace in one click, which is the usual first move on an unfamiliar peer. The events pane has a filter, a pause and an **export** that saves what is on screen as jsonl — the same shape `source-rpc record` writes and `jq` reads. Pausing stops the buffer filling rather than only the list rendering, so a paused pane on a busy network stays as it was.

Arguments worth keeping get a **save** button. Presets are stored in the browser and keyed by namespace and method rather than by peer, so a set saved against one cell is offered on the next — the reason to save a setpoint sequence usually being that five more cabinets are coming. They are named by what they hold, so there is nothing to type.

Each method keeps its timings: **×20** calls it repeatedly and reports `20 calls · p50 1 ms · last 1 ms` next to the button, which is `source-rpc bench` in miniature for when the question is smaller than a benchmark. **copy as CLI** puts the equivalent `source-rpc call …` on the clipboard, complete with the network flags this console was started with — a call worth making in a browser is usually one worth putting in a script, and retyping `--hub http://…` from memory is where that stops happening.

The watch button toggles, and unwatching drops the server's subscription too rather than only silencing the browser — the subscriber count next to the event moves with it. Closing the console unsubscribes everything it held, so a debugging session does not leave listeners behind on servers that outlive it.

### How it is built

The browser half is a React app talking to the CLI **over msgrpc itself**. The CLI runs an `RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace (`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events. There is no REST API and no server-sent events, and the console is the library's own first client — a bug in event routing shows up here before it reaches a plant.

The page closes its connection on `pagehide` rather than only on unmount, because React's cleanup does not run when a document is torn down by a navigation - a page that did not would stay a peer in everyone's list until the console reaped it, and socket.io's long-polling transport means a handful of those exhausts the browser's per-host connection limit and stops the next page connecting at all. If a handshake does fail, the page tries again three times before saying so.

Each page takes a random readable name — `page-drink-love-spy` — kept in `sessionStorage`, so a reload comes back as the same peer and a second tab is simply a different one. It is not derived from the URL, because a name is an address: every browser pointed at one console would derive the same one, and then two pages answer to it and each other's replies go to whichever the console registered last. A page cannot detect that, since `localStorage` is per browser profile and cannot see the other browser. Add `?name=lab-browser` to give a page a name of its own — the page's version of the CLI's `--name` — for when it should be recognisable in a peer list rather than merely unique.

The page is an `RpcServer` too, not a client. It serves over the connection it opens to the console, which is the only thing a browser can do since it cannot listen, and that is what lets its `chat` namespace be called by another peer. The same object calls outwards with `proxy()`, so browsing the network and hosting a service on it share one link and one name. Chat exists to exercise exactly that direction: two consoles on one bus, a page on each, and a message crossing between them tests dial-out serving, presence propagation and relaying in a way no amount of calling the console can.

Everything is bundled into the CLI's `dist`: no CDN, no runtime download. A plant network usually has no route to the internet, and a page that fetches from one renders blank exactly where it is needed.

`npm run dev:web` in the package serves the app with hot reload against a console started separately on port 7844.

### Signed networks

A server configured with `verify` drops unsigned frames before the RPC layer. Without keys the console still lists peers — presence is unsigned retained state — and then every call times out with nothing to say why. Give it keys with `--sign`:

```
source-rpc console --broker mqtt://broker:1883 --sign console-keys.json
```

```json
{
  "name": "console-1",
  "secret": "the console's own HMAC secret",
  "peers": { "plantServer": "that server's secret" }
}
```

A file rather than a flag, because a secret on the command line is visible to anyone who can run `ps`. The console warns if the file is readable by other users.

`peers` is optional. Supplying it makes the console check signatures on what it receives as well, which means frames from an unsigned peer are then dropped.

The server checks a signature against the key it holds for the name the frame claims, so the console's name has to be the one its key belongs to. `name` in the file supplies it; passing a `--name` that contradicts the file is refused rather than left to surface as a timeout.

HMAC only. For Ed25519 or an HSM, build the console with the library's `startConsole` and pass your own `MessageSigner`.

### Other limits

**It binds to `127.0.0.1` by default.** The console can invoke any method it is allowed to, so exposing it has to be a deliberate act: `--host 0.0.0.0` works and prints a warning saying what you have just done.

**Credentials are thin.** Broker credentials work if they fit in the url (`mqtt://user:pass@host`); TLS client certificates have nowhere to go yet, and neither does a private certificate authority — `--insecure-tls` accepts any certificate at all, which is a development answer and not a plant one. A hub that authenticates needs a handshake token, which has no flag for the same reason the signing keys do not — build the console from the library's `startConsole` and pass `hubCredentials`.

**`--prefix` is MQTT's.** A socket.io hub has no topic namespace, so the flag does nothing for `--hub`. Watching two MQTT networks at once is not possible either; it is one broker and one hub.

**Give it its own name on a busy network.** The default is unique per process, but a peer name maps to an MQTT client id and a broker allows one connection per id, so two consoles sharing a `--name` will disconnect each other.

## Presence

A peer that flaps is one of the commonest faults on a plant and the hardest to catch in the act. The console used to show it as a dot that changed colour and then forgot, so a device dropping every thirty seconds looked exactly like one that was simply up.

```
flakyCell has arrived 4 times

3:36:43 AM  −  flakyCell   http://localhost:8090
3:36:41 AM  +  flakyCell   http://localhost:8090
3:36:38 AM  +  polish-2
3:36:38 AM  −  flakyCell   http://localhost:8090
```

Kept by the console and handed over when a page connects, so **opening the console after the trouble still shows it** — and anything that has arrived three times or more in the window is called out by name, because that is the fault and the rest is a Tuesday.

Each peer in the list also says **what it is** — broker, console, page, device, or served without a contract. That is learned from descriptions the console was already making when you select a peer or when it goes looking for a bus to tap, so the labels fill in as the network is used and an idle console costs exactly what it did before.

## Problems

The **Problems** tab is where a call that never comes back says why. Four things the transports have always reported and nothing used to listen to:

| kind | what it means |
| --- | --- |
| `rejected` | the frame was refused before it reached the RPC layer — a bad signature, an unsafe name, something undecodable |
| `unroutable` | there was nowhere to deliver it: no such peer, a relay refused, or too many hops |
| `peerDisplaced` | two peers are answering to one name, so replies reach whichever connected last |
| `transportError` | the link itself failed |

```
1:26:44 AM  peerDisplaced  on this console
            twin-hmi
            another connection claimed this name
1:26:42 AM  unroutable     on this console
            lost-caller → no-such-device
            no route to the target
```

There is nothing to switch on: these cost nothing when nothing is wrong, and the ones worth reading are usually from before anyone thought to look. The console keeps a bounded history and hands it over when a page connects, so **opening the console after the trouble still shows it** — which is the usual way round.

`source-rpc watch <console> console.problem` streams the same thing to a shell, and `source-rpc call <console> console.problems` fetches the history.

Each peer in the list also now carries **the link it was found on**, which on a plant with the devices on a broker and the HMIs on a hub is the first thing worth knowing about one.

## The traffic tap

A console sees its own calls and the events it subscribed to, which on a real network is a small fraction of what is happening. The broker sees everything, because it is the thing forwarding it. `bus` is the one namespace it exposes, and it is **turned on by a call rather than a flag** — a plant bus that has to be restarted before it can be watched will not be watched, since the run worth looking at is the one already going wrong.

```
$ source-rpc call plantBus bus.tap '{"peer":"plantServer","payloads":true}' --hub http://bus:7843
{ "token": "tap-1", "expires": 1785272777436, "filter": { … } }

$ source-rpc watch plantBus bus.frame --hub http://bus:7843
→  hmi-3 -> plantServer  plant.writeSetpoint[1200,"auto"]
⇒  plantServer -> hmi-3  plant.alarm["setpoint moved",1]
←  plantServer -> hmi-3  plant.writeSetpoint  2ms
→  hmi-3 -> plantServer  plant.read[]
←  plantServer -> hmi-3  plant.read  1ms
→  hmi-3 -> plantServer  plant.fault[]
←  plantServer -> hmi-3  plant.fault  0ms  Exception: valve jammed
```

(The arrows are `jq` over the jsonl; `watch` writes one JSON object per line.)

| method | |
| --- | --- |
| `tap(filter?)` | start watching; returns a token |
| `untap(token)` | stop watching that one |
| `taps()` | who is watching what, and how much each has seen |

Frames arrive as the `frame` event, so anything that can subscribe to an msgrpc event can read them — the console, `source-rpc watch`, or a program of your own.

**It knows what a frame is**, which is what a topic browser pointed at the same wire cannot do. A call and its reply share a correlation id, so the reply is reported with the method it answers and the time it took — neither of which is in the reply itself.

| filter | |
| --- | --- |
| `peer` | only frames this peer sent or received — "mirror that device" |
| `namespace` | only this namespace; applies to replies too, since a reply is paired with its call first |
| `kinds` | any of `POST`, `SUCCESS`, `ERROR`, `EVENT` |
| `payloads` | include arguments, results and event payloads. **Off by default** |
| `ttl` | seconds before the tap drops itself. Default 300, maximum 3600 |

Payloads are off by default because the metadata is what a debugging session usually needs, and a plant bus carries values nobody meant to hand to whoever happened to be tapping. Several taps can run at once with different filters; each frame names the taps it matched, and payloads are carried only if one of them asked.

Taps expire on their own, because a console that closes without untapping would otherwise leave the broker building and emitting frames for a subscriber that is not there.

Traffic addressed *to* the broker is not tapped — only what it relays — so turning the tap on and reading it back does not feed itself.

### On MQTT, the console does the watching

There is no broker of ours on an MQTT network to hook, so the observation happens at the subscription instead: `<prefix>/rpc/+` under the 3.1.1 layout, each of `<prefix>/{req,rsp,evt}/+` under MQTT 5. A console started with `--broker` exposes the same `bus` namespace and watches for itself.

**The tap gets its own broker connection**, opened when the first tap starts and closed after the last one ends. A peer subscribed to both its own topic and the wildcard covering it has overlapping subscriptions, and a broker is permitted to deliver a matching message once per subscription — which for a request means the method runs twice. A separate connection is a separate client id and a separate session, so the two can never overlap. It also means an idle console costs a plant broker nothing.

Frames are reported without checking signatures: a tap holds no key for a conversation it is not part of, and what is on the wire is what it exists to show.

Either way the answer arrives the same: ask the console, and it turns on whatever it can reach.

```
$ source-rpc call myConsole console.tap '{"peer":"plantServer"}' --broker mqtt://localhost:1883
{ "token": "console-tap-1", "sources": ["this console"] }
$ source-rpc watch myConsole console.frame --broker mqtt://localhost:1883
```

`sources` says who is doing the watching — a broker's `bus` on socket.io, `this console` on MQTT, or both when it holds both links.

### In the console

The side panel has a **Traffic** tab next to Events and Chat. It is off until you press **tap**, and the setup above it decides what to ask for: arguments and results, only the selected peer, and which kinds. Once running it shows the source it found, a filter box, **pause**, and one row per frame — colour-coded by kind, with the reply carrying the method it answers and the time it took.

The tab stays tapping while you look at another tab; the count on the tab label is what arrived while you were away.

## peers, describe, call, watch

The console's verbs for a shell rather than a browser. Same network flags as `console`, one answer each, and an exit code:

```
source-rpc peers --hub http://bus:7843
source-rpc describe plantServer --hub http://bus:7843
source-rpc call plantServer plant.writeSetpoint 1200 auto --hub http://bus:7843
source-rpc watch plantServer plant.alarm --hub http://bus:7843
```

```
$ source-rpc describe plantServer --hub http://bus:7843
plantServer (contract 3) — arguments checked

plant@3  Plant
  writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
  read(): { celsius: number, bar: number }
  event alarm(string, number)  0 subscribers
```

**`call` exits 1 when the peer refuses**, which is the point: a smoke test is a line in a CI file rather than a program that parses output.

```
$ source-rpc call plantServer plant.writeSetpoint 3000 --hub http://bus:7843
msgrpc: plantServer.plant.writeSetpoint failed: InvalidParams: argument 0 is above the maximum 2000
$ echo $?
1
```

### Arguments come from the contract

A shell has only strings, so the peer is described first and **its own contract decides what each word means**. `1200` is a number where the schema says `number` and the text `1200` where it says `string`; `auto` matches a literal in a union; an object argument is JSON; `date` takes an ISO string and `bytes` takes hex. Where a peer publishes no contract the rule is JSON-if-it-parses and the literal text otherwise, so `42` is a number and `hello` is a string rather than a syntax error.

A word that cannot be what the contract asks for is refused before anything is sent, and the argument is named rather than numbered:

```
$ source-rpc call plantServer plant.writeSetpoint warm
msgrpc: argument 0 (value): expected a number, got 'warm'
```

`--args '[1200, "auto"]'` skips all of that and sends the array as it parses, for a call the contract cannot describe or a value the shell would mangle.

### Output

`--json` on every verb. Without it the output is for reading; with it, for `jq`. Which one is wanted is not guessed from whether stdout is a tty, because that guess is wrong exactly when it matters — in CI.

`call` puts the result on stdout and the timing on stderr, so a pipe carries the value and nothing else while a person still sees what it cost:

```
$ source-rpc call plantServer plant.read --hub http://bus:7843 | jq .celsius
84
```

`watch` writes one event per line as JSON, since it is the verb most likely to be piped somewhere and a stream that is pleasant to read is a stream nothing can parse:

```
$ source-rpc watch plantServer plant.alarm --hub http://bus:7843
msgrpc: watching plantServer.plant.alarm. Ctrl-C to stop.
{"at":1749047112004,"peer":"plantServer","namespace":"plant","event":"alarm","args":["pressure high",2]}
```

Ctrl-C drops the server's subscription as well as stopping the stream, rather than only walking away from it — a debugging session should not leave listeners behind on a device that outlives it.

### Waiting for a peer

`ready()` means the links are up, not that presence has arrived, and over MQTT retained presence lands a moment after the subscription does. Each verb waits up to `--wait` (5 s) for the peer to become addressable and then says so plainly, rather than failing intermittently for reasons nobody can reproduce:

```
$ source-rpc call plantServr plant.read --hub http://bus:7843
msgrpc: plantServr did not appear within 5000 ms. Run 'source-rpc peers' to see who is there.
```

### Sending a command twice on purpose

A redelivered *packet* is already handled — the server recognises the request id and answers from what it recorded rather than running the method again. What that cannot cover is a second **attempt**: a script that retries, or an operator pressing the button again, is a new request, and only the caller knows the two are one intent.

`--idempotency-key` is how the caller says so:

```
source-rpc call filler filling.dispense 500 --idempotency-key batch-4417 --hub http://bus:7843
```

Run that twice and the batch is dispensed once; the second call is answered from the record of the first. Run it without the key and it is dispensed twice, which is the correct reading of two commands that did not claim to be one.

It only means anything for a method declared `non-repeatable-command` on a server given a durable idempotency store — see [Commands](https://github.com/source-repo/rpc/tree/main/packages/rpc#commands). Without a store the key is carried and ignored, so a retry loop in a shell script is not protection by itself.

## Declaring the contract

The namespace is declared in the source, because static analysis cannot see the name a class is eventually exposed under at some `exposeClassInstance` call elsewhere. Methods opt in with `@rpc`, so the contract is the allow-list rather than everything on the prototype chain.

```typescript
import { rpc, rpcNamespace } from '@source-repo/rpc'

@rpcNamespace('plant', { version: '2' })
export class Plant {
    declare rpcEvents: { alarm: [message: string, severity: number] }

    @rpc async writeSetpoint(value: number, mode?: 'auto' | 'manual') { ... }
    async internalOnly() { ... }        // unmarked, so absent from the contract
}
```

Events are declared as a property type rather than inferred from `emit()` calls, which cannot be read statically with any confidence.

## extract

```
source-rpc extract --project tsconfig.json --out msgrpc.types.json
```

It describes **the files your tsconfig includes**, not everything they import. A decorated class in a dependency belongs to that dependency's contract, not yours.

Nothing is executed: the decorators are read from the syntax tree, so `extract` never runs your code.

### What it refuses to describe

Anything the type language cannot represent is **reported, never emitted as `any`**, and a run with any diagnostic writes no file. A schema that quietly degrades on the parts it could not read still looks like protection while checking nothing.

```
msgrpc: 3 types could not be described
  plant.fetch return is generic (T), which has no runtime type to check (src/plant.ts:6)
  plant.subscribe argument 0 is a function, which cannot be checked on the wire (src/plant.ts:12)
  plant.lookup return is a Map, which MsgPack does not carry; use an object or an array (src/plant.ts:18)
```

So far: generics, function parameters, `Map` and `Set`, and a type that is part dictionary and part declared shape — `{ name: string; [tag: string]: unknown }` — which would need describing both halves at once. Dropping either one produces a contract that looks checked and is not.

At most 25 diagnostics are printed, followed by a count of the rest.

### What it can and cannot see

`Date` and `Uint8Array` come through as values rather than encodings of them, because MsgPack carries both. Recursive types become named references. `Promise<T>` is unwrapped.

An index signature becomes a `record`, so `{ [tag: string]: Reading }` is described by its value type with the keys left open, and a wrong reading is still caught. `{ [id: number]: string }` gets a key pattern instead of a numeric key type, because a JS object key is always a string on the wire.

A generic instantiation is inlined rather than named: `Record<string, number>` and `Record<string, string>` share the symbol `Record`, so keying both under it would quietly make the second a reference to the first's value type.

What it cannot see is anything the type system does not carry. `value: number` becomes `{ kind: 'number' }` — a range like `0..2000` is a runtime invariant, invisible to TypeScript. Extraction gives you shape checking: types, arity, whether an argument is required. Bounds have to be added to the schema afterwards or expressed in the type.

## check

```
source-rpc check --project tsconfig.json --against msgrpc.types.json
```

Compares the source against a stored contract using the **same comparison the server applies at runtime** to a caller declaring an older version, so a change that would refuse a deployed peer fails the build instead:

```
$ source-rpc check
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
msgrpc: 1 breaking change against msgrpc.types.json
$ echo $?
1
```

Parameters may widen and returns may narrow; the reverse breaks callers. Adding an optional argument or field is safe, adding a required one is not. Events run the other way, since the server emits and the caller receives.

`extract --keep-history` moves the previous contract into `history` when the version changes, which is what lets both this check and the server recognise an older caller.

### Checking the device rather than the build

`check` against source catches a change before it ships. What it cannot answer is the question asked on site: the contract says this device offers `writeSetpoint(value, mode?)` — is that what the box on the wall is actually running?

```
$ source-rpc check --peer plantServer --against plant.types.json --hub http://bus:7843
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
  plant.read no longer exists
  plant.event alarm is no longer emitted, so a subscription to it would never fire
msgrpc: 3 breaking changes between plant.types.json and plantServer
$ echo $?
1
```

The peer describes itself and the answer runs through **the same comparison** the server applies to a caller declaring an older version — so a device behind its own contract is reported in exactly the words a stale caller would have got, and `check` in CI and `check --peer` on site agree about what "breaking" means.

A namespace the peer does not serve at all is reported apart from one that changed. **A peer running without a schema is reported as unchecked, not as passing**: it describes its method names and nothing else, and calling that "no breaking changes" would be the most useful-sounding lie available.

## diff

Why does cell 3 behave differently from cell 2? Usually because one of them is running last season's firmware.

```
$ source-rpc diff cell2 plantServer --hub http://bus:7843
cell2  vs  plantServer

  plant contract version
    cell2: 3
    plantServer: 4

  plant.read
    cell2: read(): { celsius: number(0..100), bar: number(0..10) }
    plantServer: —

  plant.writeSetpoint
    cell2: writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
    plantServer: writeSetpoint(value: number(0..500), mode?: "auto" | "manual"): boolean

  plant event alarm
    cell2: emitted
    plantServer: —
```

Signatures are compared as they read rather than structurally, because the answer is going to be read by a person standing in front of two cabinets. It exits 1 when anything differs, so a script can assert that two cells match; `--json` gives the same as data.

## serve

A peer built from a contract rather than from code, so an HMI has something to talk to and a test has a device willing to fail on request — which a real one is not.

```
source-rpc serve --contract plant.types.json --hub http://bus:7843 --name fakePlant
```

```
$ source-rpc describe fakePlant --hub http://bus:7843
fakePlant — arguments checked

plant@3  Fake
  halt()
  read(): { celsius: number(0..100), bar: number(0..10) }
  writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
  event alarm(string, number(1..3))  0 subscribers
```

It answers every method with a value of the declared shape, and **refuses what the real peer would refuse** — it is given the same schema, so the same validator runs:

```
$ source-rpc call fakePlant plant.writeSetpoint 3000 --hub http://bus:7843
msgrpc: fakePlant.plant.writeSetpoint failed: InvalidParams: argument 0: 3000 is above the maximum 2000
```

The contract is the one already extracted and committed for the deployed peer, so the stand-in cannot drift from it: `source-rpc check` fails the build when it would.

### What it generates

Deterministic, and inside whatever the type language carries — a fake whose readings wander is pleasant to look at and impossible to assert on.

| the schema says | you get |
| --- | --- |
| `number` with `min`/`max` | the midpoint, rounded if `integer` |
| `string` with `minLength`/`maxLength` | `sample`, padded or trimmed to fit |
| a union of literals | the first one that is not `null` |
| an object | its **required** fields only |
| an array | one element |
| `bytes` | four bytes, or `maxBytes` of them |
| `date` | now — a device reporting the epoch reads as a broken clock |

`pattern` is the one it cannot honour; satisfying an arbitrary regular expression is a different problem, so a constrained string comes back as the placeholder. A recursive type stops rather than descending forever.

### Scripting it

```
source-rpc serve --contract plant.types.json --script fake.json --fail plant.halt=Unauthorized --hub http://bus:7843
```

```json
{
  "returns": { "plant.read": { "celsius": 84, "bar": 3.2 } },
  "fails":   { "plant.writeSetpoint": "Timeout" },
  "emits":   [{ "event": "plant.alarm", "every": 2000 }]
}
```

`returns` replaces the generated answer. `fails` answers with an RPC error code instead — `Unauthorized`, `Forbidden`, `InvalidParams` and so on — and **`Timeout` is the special one: the call is never answered at all**, so the caller's own timeout is what fires. That is the failure an HMI handles worst and the one you otherwise stage by pulling a cable. Only the named method is affected; the rest of the peer keeps working, so a test can break one thing rather than the device.

`emits` sends a declared event on a timer, with parameters of the declared shape unless the script supplies them — the receiving half of an HMI otherwise has nothing to receive.

`--fail <ns.method=Code>` is the same thing without a file, and is repeatable.

**It says it is a fake** on startup and in the class name a console shows, because a stand-in mistaken for the device is worse than no stand-in at all.

### Simulating something that reacts

`returns` answers the same thing every time, which is enough for a screen that needs something to draw and not enough for the behaviour an HMI is usually wrong about: a pump that ramps toward the setpoint it was last given, a batch that will not start twice, a valve that reports closed until something opens it. Those need a variable and a method that can see what it was called with.

So a script may carry `state` and give methods a body. **This runs code the script supplied, so it is off unless `--allow-exec` is given**, and a script that asks for it without the flag is refused at startup rather than served with the handlers quietly dropped.

```
source-rpc serve --contract plant.types.json --script pump.json --allow-exec --hub http://bus:7843
```

```json
{
  "state": { "celsius": 20, "setpoint": 20 },
  "handlers": {
    "plant.setSetpoint": "(bar) => { state.setpoint = bar; return null }",
    "plant.read": "() => ({ celsius: state.celsius += Math.sign(state.setpoint - state.celsius) })"
  }
}
```

Each handler is a JavaScript function, called with the arguments the caller sent, sharing the mutable `state`. A handler wins over `returns` for the same method, so a script can carry both: bodies for what it simulates, canned values for the rest.

For a simulation with more arithmetic in it than a one-liner wants to hold, `python` runs a program instead. It is started once and keeps its own state in its own variables, which is usually why you reached for it:

```json
{
  "python": {
    "targets": ["plant.read", "plant.setSetpoint"],
    "program": "sp = {'v': 20}\n@rpc('plant.setSetpoint')\ndef s(bar):\n    sp['v'] = bar\n@rpc('plant.read')\ndef r():\n    return {'celsius': sp['v']}"
  }
}
```

`@rpc('namespace.method')` is supplied by a shim wrapped around the program; nothing needs importing and `python3` on `PATH` is the only requirement. Whatever the program prints that is not a reply is forwarded to stderr, so debugging with `print` works.

**What the flag is and is not.** It is the security boundary. The JavaScript context has no `require`, no `process` and no filesystem, and a handler that never returns is cut off rather than wedging the peer — but `node:vm` is documented as not being a security mechanism, and Python is a subprocess with the privileges of whoever started it and no confinement at all. This is the right tool for a simulator on a development machine and the wrong thing to reach from a plant network, which is why [the container](#in-a-container) ships without the flag and both `serve` and `mcp` say on startup when it is on.

## record and replay

The question a plant asks constantly and no test framework answers: *this new device is supposed to behave like the old one — does it?* Capture a session from the working plant, replay it at the replacement, and compare the answers.

```
source-rpc record --out session.jsonl --hub http://bus:7843
source-rpc replay session.jsonl --against newPlant --hub http://bus:7843
```

`record` opens a tap wherever it can — a broker's `bus` over socket.io, its own subscription over MQTT — and writes one frame per line:

```
{"msgrpc":"recording","version":1,"at":1785283506726,"filter":{"payloads":true},"sources":["plantBus"]}
{"at":1785283509702,"source":"hmi-3","target":"plantServer","kind":"POST","namespace":"plant","method":"read","id":"396f…","params":[]}
{"at":1785283509705,"source":"plantServer","target":"hmi-3","kind":"SUCCESS","id":"396f…","ms":3,"result":{"celsius":84}}
```

jsonl, so `grep`, `jq` and `wc -l` work on it. Lines are appended as they arrive, so a process killed mid-session still leaves what it saw — a recording is most wanted from the run that ended badly.

**Payloads are on by default here**, where the tap has them off: a recording without arguments and results cannot be replayed, which is the only reason to make one. `--no-payloads` turns them off and `record` says on startup that it is writing them.

### Replaying

`replay` re-issues the recorded calls, in their original spacing, and compares each answer with the one that was recorded:

```
$ source-rpc replay session.jsonl --hub http://bus:7843
  ≠ plantServer plant.read: expected {"celsius":84,"bar":3.2}, got {"celsius":12,"bar":3.2}
source-rpc replay: 12 calls, 9 matched, 3 differed, 0 failed, 0 uncompared
$ echo $?
1
```

**It exits 1 when anything differed or failed**, so a conformance check is a line in a CI file.

- `--against <peer>` sends every call to one peer instead of its original addressee, which is how a session captured from `plantServer` is played at `plantServer-v2`.
- `--speed <n>` scales the original gaps; `0` sends with no waiting. The spacing is kept by default because a device that only misbehaves at the rate it actually sees should be given that rate.
- **A call that failed the same way it failed when recorded is a match.** A replacement that refuses what the old one refused is behaving, and marking that a failure would make every recording of a real plant unusable.
- A call recorded without payloads is reported, not sent empty — calling the method with nothing and comparing that is a worse answer than saying the recording cannot be replayed.
- Nothing recorded to compare against is counted apart as *uncompared* rather than as a pass.

`Date` and `Uint8Array` are tagged in the file (`{"$date":…}`, `{"$bytes":…}`) and restored on the way back. JSON carries neither, and a timestamp that replayed as a string is not what the device received — which is the same reason this library speaks MsgPack.

Events are recorded but not replayed: sending a device's own events back at it would be a different thing entirely.

## bench

A device is fine at one call a second. What does it do at twenty? Finding that out is ordinarily done by writing a script, and it is always the same script.

```
$ source-rpc bench plantServer plant.read --rate 40 --for 3000 --hub http://bus:7843
plantServer plant.read  120 calls in 3.0s at 40/s
  ms   min 1  p50 3  p90 4  p95 4  p99 5  max 5
  ok   120   failed 0
```

**Percentiles rather than an average**, because an average hides exactly the calls worth knowing about: a device answering in 2 ms with one reply in four seconds averages out to something that looks healthy.

Failures are counted by code, since a device refusing arguments and a device that stopped answering are different findings with the same shape:

```
$ source-rpc bench plantServer plant.writeSetpoint 9999 --rate 20 --for 1500
plantServer plant.writeSetpoint  30 calls in 1.5s at 20/s
  ok   0   failed 30
       InvalidParams: 30
$ echo $?
1
```

Errors under load are the finding, so any failure exits 1. Arguments are coerced from the peer's own contract, exactly as `call` does.

`--concurrency` bounds how many calls may be outstanding at once; past that they are **not sent and counted as fallen behind**. Piling calls onto a device that is already behind measures the queue rather than the device, and a run that did it would report healthy latencies for a device that is drowning.

## broker

```
source-rpc broker --port 7843
```

A bus for networks that have no MQTT broker to share. It runs until Ctrl-C, relaying between the peers that connect to it and telling each of them who else is there — which is what MQTT gives you through retained presence and per-peer topics, over one WebSocket port instead.

```
source-rpc broker plantBus on port 7843
  + cellBus (:7843)
  + panel1 (:7843)
  + hmi (:7843)
```

Peers join it by dialling out, which is also the only thing a browser page can do:

```typescript
const panel = new RpcServer({ name: 'panel1', transports: [{ connect: 'http://bus:7843' }] })
panel.exposeClassInstance(new Panel(), 'panel')      // now callable by anything else on the bus
```

There is no separate broker implementation and there should not be: this is an `RpcServer` that exposes nothing. A peer addressing the broker by name gets `ClassNotFound`, which is the truth — it is a switchboard, not a service.

### Joining two brokers

`--upstream` dials another broker, and the two become one network. Each side's peers are advertised to the other, and a call crosses without either end knowing there was a hop:

```
source-rpc broker --port 7843 --name plantBus
source-rpc broker --port 8086 --name cellBus --upstream http://plant:7843
```

A peer on `cellBus` is then callable from `plantBus` and the other way round. Repeat `--upstream` to join more than one. Loops are handled — a peer is never advertised back along the link it came from, and frames carry a hop count and are dropped after 8 relays — so brokers dialling each other in a ring settle rather than storm.

### Authenticating the bus

Without `--auth` the broker relays for anything that can reach the port, and every peer name on it is an unchecked claim. It says so on startup. `--auth` is what changes that: a file of bearer tokens, each naming the one peer it admits.

```json
{
    "token": "the-one-this-broker-presents-upstream",
    "tokens": {
        "3f9a…": "plantServer",
        "c710…": { "name": "hmi", "roles": ["operator"] }
    }
}
```

```
source-rpc broker --auth /run/secrets/bus.json
source-rpc broker plantBus on port 7843, authenticating
```

`tokens` is what this broker accepts. `token` is what it presents when it dials an `--upstream`, so a broker joining another needs both: it is a bus to one side and a peer to the other. Every other command takes `--auth` too, and uses the `token` to join a hub that authenticates.

**One token per peer.** A token that maps to a name is evidence of who is calling; a single token everyone shares proves only that the caller got inside the fence. The peer presents it as its `credentials`, and its `--name` has to be the name the token was issued for — the bus drops frames claiming any other source, so a mismatch reads as every call timing out rather than as a refusal.

The flag names a path, never a secret, because `ps` is readable by everyone on the box. For a container there are `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS`, which say the same two things.

Two consequences worth knowing. The tap is gated with everything else, so `bus.tap()` is reachable only by a peer this broker admits. And an upstream broker is a peer of this one, not an operator of it: frames relay across the join as before, but a call to this broker's own `bus` namespace from across it is refused, because a connection this broker dialled is not one it authenticated.

### In a container

The broker is the piece of Source RPC that is infrastructure rather than a tool someone is holding, which is what makes it worth an image. [`Dockerfile`](https://github.com/source-repo/rpc/blob/main/packages/cli/Dockerfile) builds one whose entrypoint is the whole CLI, so a single image is a bus, a console, an MCP server or a recorder depending on the command:

```
docker run -d -p 7843:7843 \
    -e SOURCE_RPC_TOKENS='{"3f9a…":"plantServer"}' \
    ghcr.io/source-repo/rpc-cli:3                                  # no command: the default is broker

docker run --rm -e SOURCE_RPC_TOKEN=3f9a… ghcr.io/source-repo/rpc-cli:3 \
    peers --hub http://bus:7843 --name plantServer        # any other command, same image
```

[`docker-compose/network.yml`](https://github.com/source-repo/rpc/blob/main/docker-compose/network.yml) runs the whole thing — an MQTT broker, the bus, and a console watching both — which is the shape a plant deploys:

```
echo "CONSOLE_TOKEN=$(openssl rand -hex 32)" > docker-compose/.env
docker compose -f docker-compose/network.yml up -d
open http://localhost:7844
```

Note what the compose file does with the console, because it is the part that is easy to get wrong. `--host 0.0.0.0` is needed for the page to be reachable from outside the container at all, and it means anything that can reach the published port can call whatever the console is allowed to call — so the port is published to `127.0.0.1` rather than to every interface. The bus is not: peers have to reach it, and `--auth` is what makes that safe rather than the firewall.

### What it is not

**Not a store-and-forward broker.** Nothing is queued for a peer that is not connected: a frame is handed to a peer that is there now, or reported as unroutable. If a peer needs to receive what was sent while it was down, that is what MQTT and `persistentSession` are for.

**Not authenticated.** It listens on every interface and relays for whoever connects, without checking who they are, and it says so on startup. Put it behind a network you trust, or build one from the library with `authenticate` and a `relay` rule.

**The tap is only as gated as the broker is.** Anyone who can reach an unauthenticated broker can call `bus.tap()` and mirror everything crossing it. They could always have read the same traffic by impersonating a peer; this is merely one call. `authenticate` and `relay` are what restrict it, and the broker says as much on startup.

## mcp

```
source-rpc mcp --broker mqtt://localhost:1883
source-rpc mcp --hub http://hub:7843
```

Serves the network to an [MCP](https://modelcontextprotocol.io) client over stdio, so a model can look at a plant the way a person looks at the console. It takes the same network flags as `console`, including `--sign`.

| tool | what it does |
| --- | --- |
| `list_peers` | who is on the network right now |
| `describe_peer` | one peer's namespaces, methods, argument names and types, and events |
| `call_method` | call a method, with positional arguments, and return what it returns |
| `start_fake` | stand a peer up from a contract and put it on this network |
| `stop_fake` / `list_fakes` | take one off again; what is being served here |
| `check_peer` | compare a live peer with a contract and report what would break |
| `diff_peers` | what two live peers expose differently |
| `watch_traffic` | what other peers are saying to each other, for a few seconds |
| `watch_events` | what one peer emitted, for a few seconds |
| `save_contract` / `list_contracts` | only with `--contracts <dir>` |

### Standing something up

The awkward part of asking a model to test a device is that the device has to exist. `start_fake` takes a contract **inline** — no file, no shell, no second terminal — and puts a peer on the network that answers from it:

```
start_fake { name: "fakePlant", schema: {…}, script: { returns: { "plant.read": { celsius: 84 } } } }
→ fakePlant is on the network, answering plant from the contract. It is a fake: it answers from
  the contract, not from a device.
```

From there the ordinary verbs reach it, and it **refuses what the contract refuses** — so a model can check that its caller handles `InvalidParams` without touching anything real. `script` supplies canned returns, deliberate failures and timed events, including the `Timeout` code that never answers at all.

**A fake will not take a name a peer already answers to.** Standing one up under a live device's name would displace it, and calls meant for the plant would reach a stand-in that agrees with everything. That is refused, not resolved.

Fakes run inside the MCP server rather than as spawned processes, so they stop when it does and none are left behind.

### Where contracts go

`--contracts <dir>` is what makes `save_contract` and `list_contracts` exist at all. Without it they are **not in the tool list**, because a server that cannot write files should not advertise tools claiming it can. With it, a contract is written as `<name>.types.json` in that directory and nowhere else — a name that would climb out of it is refused rather than resolved — and what is written is the same file `source-rpc serve --contract` and `source-rpc check --peer --against` read.

So the loop closes: a model can draft a contract, save it where the CLI will find it, stand a peer up from it, drive that peer, and check a real device against the same file.

### Peers kept as scripts

`start_fake` is the two-minute answer, and it is gone when the conversation ends. `--scripts <dir>` is the other thing: a directory of peers written as programs, which the model can add to, change, start and stop — and which you can open in an editor, commit, and run by hand with `node`.

A script is not bound to one contract, so unlike a fake it can call as well as answer: drive a start-up sequence, poll a device and log what it sees, bridge two networks, or stand several peers up at once.

```
source-rpc mcp --hub http://bus:7843 --scripts ./scripts
```

| tool | |
| --- | --- |
| `save_script` | write `<name>.ts` (or `.mjs`) to the directory |
| `read_script` | its source, for changing part of it rather than rewriting the whole |
| `list_scripts` | what is there, and which of them are running |
| `start_script` / `stop_script` | run it as its own process, or stop it |
| `delete_script` | remove it, stopping it first if it is running |
| `script_output` | the last 200 lines it printed, stderr marked `!` |

**TypeScript by default, and Node runs it directly** — no build step and no loader, on Node 22.6 and later. That is the point rather than a convenience: this library's whole idea is that a class is the contract, so a script that says `import type { Pump } from '../plant.js'` gets the same typed proxy the rest of your code does. On an older Node, or for a script that would rather be plain JavaScript, save it as `mjs`.

**Each script is its own process.** So it can import whatever it likes; a script that throws or wedges cannot take the MCP server down with it; and starting and stopping are a spawn and a kill rather than a module cache to reason about. They are stopped when the server exits, rather than left holding peer names nobody is serving.

**The network is handed over, not hardcoded.** A script is started with `SOURCE_RPC_HUB`, `SOURCE_RPC_BROKER`, `SOURCE_RPC_PREFIX` and `SOURCE_RPC_TOKEN` set from the flags this server was given, so it reads its broker url rather than carrying one that is right on your machine and wrong on the next. Its working directory is the scripts directory, so relative imports mean what their author meant and `@source-repo/rpc` resolves from the project that directory sits in.

```typescript
// scripts/pump-sim.ts — started with start_script, or `node scripts/pump-sim.ts`
import { RpcServer } from '@source-repo/rpc'

const peer = new RpcServer({ name: 'pumpSim', transports: [{ connect: process.env.SOURCE_RPC_HUB! }] })
peer.exposeClassInstance(new Pump(), 'plant')
await peer.ready()
console.log('pumpSim is on the network')
```

**Scripts get their own dependencies.** A script is an ordinary Node program, so sooner or later one wants something off the registry — a date library, a CSV parser, a driver for whatever is on the other end of the serial port.

| tool | |
| --- | --- |
| `list_packages` | what is declared, and what is actually installed |
| `add_package` | install one into the scripts directory |
| `remove_package` | uninstall it |

The directory gets its own `package.json` and `node_modules`, so nothing is added to the project around it, and a script resolves its imports from next door. That manifest also carries `"type": "module"` — which a `.ts` script needs, because Node decides whether `import` is legal from the nearest manifest, and inside a CommonJS project it would otherwise warn on every run and put the warning in the script's own output.

**Install scripts are skipped by default.** A `postinstall` hook is unreviewed code from the registry running on your machine, and it is the part of `npm install` that is not about files at all. A package that genuinely needs one — anything with a native build — takes `allowInstallScripts`, and the asking is visible in the tool log.

This is not a new grant on top of `--scripts`: a script could already `child_process.exec('npm i …')` by itself. What the tools buy is that the dependency is *declared* — in the tool log and in a committed `package.json` — rather than acquired sideways.

**This is a bigger grant than `--allow-exec`, and separate from it on purpose.** A handler body runs in a context with no filesystem and a time budget; a script is an ordinary Node process with your privileges, which can open sockets and read your disk. Both are development-machine features, and neither is enabled by default in [the container](#in-a-container) — the image that has what they need is the `-dev` one.

### Two images

The published image comes in two flavours, because the CLI is two things.

| | |
| --- | --- |
| `ghcr.io/source-repo/rpc-cli` | what goes near a plant: the commands that are infrastructure, and nothing else in the image |
| `ghcr.io/source-repo/rpc-cli:dev` | the same CLI plus `npm` and `python3`, which `--scripts` and the Python half of `--allow-exec` need in order to work at all |

```
docker run --rm -v "$PWD/scripts:/scripts" ghcr.io/source-repo/rpc-cli:dev \
    mcp --hub http://bus:7843 --scripts /scripts
```

The bare name is the runtime one, and `latest` points at it — whoever pulls without thinking should get the image meant for a plant.

The difference is not cosmetic. The runtime image has **no fixable critical or high vulnerabilities**; the development one carries five, all from npm's own bundled dependencies (`tar`, `undici`, `brace-expansion`). Shipping npm means inheriting every advisory against them, which is the whole reason the runtime image drops it — nothing at runtime shells out to npm, and the CLI is installed by the time it goes. The release scans both: the runtime image blocks a release on anything fixable, the development image is reported and not enforced, because failing on npm's dependencies would mean never releasing.

Neither flag is on by default in the `-dev` image either. It *can* do these things when asked; started with no flags it behaves exactly like the runtime one.

One practical note: `add_package` installs into the scripts directory rather than globally, so a bind-mounted directory has to be writable by uid 1000, which is the `node` user both images run as.

Not one tool per method on the network. A peer set that changes while a model is mid-conversation would mean re-issuing the tool list on every arrival and departure; `describe_peer` hands over the argument types instead, which is the same information in a form that does not go stale.

A call a peer refuses comes back as tool content with `isError`, carrying the reason — `InvalidParams: argument 0: expected number, got string` — rather than as a JSON-RPC failure. A model should read that and fix its call, which it cannot do if the transport swallows it.

To wire it into a client, give it the command and its flags:

```json
{
  "mcpServers": {
    "plant": { "command": "source-rpc", "args": ["mcp", "--broker", "mqtt://localhost:1883"] }
  }
}
```

**stdout carries the protocol and nothing else**, so this is not for interactive use — startup goes to stderr, and a stray `console.log` anywhere in the process would corrupt the stream. There is no MCP SDK behind it: MCP is JSON-RPC 2.0 over newline-delimited stdio, which is little enough to speak directly, and this package is about not needing a second RPC framework.

**Anything a model can reach, it can call.** The peers this lists are real, and `call_method` will happily invoke one that opens a valve. Point it at a network where that is acceptable, or give it credentials that restrict it: `--sign` makes it a peer with an identity, and `authorize` on the servers decides what that identity may do.

**And it can put peers on that network.** `start_fake` adds one — it calls nothing and changes no device, and it refuses a name already in use, but it is a peer other things can find and call. The same `authorize` and `--sign` machinery governs what it may do once it is there. Writing files is the one capability that stays off unless asked for: no `--contracts`, no tools that write.

## Ports

`7843` is the Source RPC port and `7844` is the web port. Both are defaults, so neither has to be typed. They are deliberately not in the 80xx range, which is where everything else on a developer's machine already is — a default that collides with whatever is on 8080 today is a default nobody keeps.

| | |
| --- | --- |
| `1883` | MQTT |
| `8083` | MQTT over WebSocket |
| `7843` | `source-rpc broker` |
| `7844` | `source-rpc console` |

**A process needs only one of them.** The console serves its page and its RPC on the same listener — socket.io answers `/socket.io` and everything else is the static app — so `7844` is one port, not a pair. The second number exists because a bus and a console usually run on the same host, not because either needs two.

## Flags

Every flag of every command, for when you know what you want and need the spelling. Nothing here is new: each one is explained where its command is.

| flag | commands | default | meaning |
| --- | --- | --- | --- |
| `--project <tsconfig.json>` | extract, check | `tsconfig.json` | the project to read |
| `--out <file>` | extract | `msgrpc.types.json` | where to write the contract |
| `--against <file>` | check | `msgrpc.types.json` | the contract to compare against |
| `--peer <name>` | check | — | ask a live peer what it serves instead of reading source; needs `--broker`/`--hub` |
| `--keep-history` | extract | off | move the previous contract into `history` when the version changed |
| `--broker <url>` | console, mcp, verbs | — | an MQTT network, e.g. `mqtt://localhost:1883` |
| `--hub <url>` | console, mcp, verbs | — | a socket.io network, e.g. `http://hub:7843`. One of `--broker`/`--hub` is required; both watches both |
| `--prefix <topic>` | console, mcp, verbs | the transport's own | must match the network you are watching |
| `--port <n>` | console | `7844`, or `8844` with `--cert` | |
| `--host <address>` | console | `127.0.0.1` | see the warning it prints before widening this |
| `--base-path <path>` | console | `/` | publish under a path, for a reverse proxy that forwards the prefix instead of stripping it. See [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `--timeout <ms>` | console, mcp, verbs | `10000` | call timeout |
| `--name <peer>` | console | `console-<three words>` | how the console identifies itself to the network |
| `--sign <keyfile>` | console, mcp, verbs, serve | — | HMAC keys, so it can talk to a signed network |
| `--insecure-tls` | console, mcp, verbs, serve | off | accept any certificate on an `https`/`wss`/`mqtts` link. Unsafe by design: for a development bus with a self-signed certificate, never a plant |
| `--cert <file>` `--key <file>` | console, broker | — | serve TLS. Together they make the console HTTPS and the bus WSS, and move the default port to 8844 / 8843 |
| `--contracts <dir>` | mcp | — | let it save and load contracts here; without it those tools are not offered |
| `--contract <file>` | serve | — | the contract to serve; every namespace in it is exposed |
| `--script <file>` | serve | — | canned returns, deliberate failures and events on a timer |
| `--fail <ns.method=Code>` | serve | — | answer with that RPC error code; repeatable. `Timeout` never answers |
| `--out <file>` | record | — | where to write the recording, as jsonl |
| `--peer <name>` | record | — | only frames this peer sent or received |
| `--namespace <name>` | record | — | only this namespace |
| `--no-payloads` | record | off | leave arguments and results out |
| `--for <ms>` | record | — | stop after this long, instead of waiting for Ctrl-C |
| `--against <peer>` | replay | the original addressee | send every call here instead |
| `--speed <n>` | replay | `1` | higher is faster; `0` sends with no waiting |
| `--rate <n>` | bench | `10` | calls per second to aim for |
| `--for <ms>` | bench | `10000` | how long to keep going |
| `--concurrency <n>` | bench | `50` | calls outstanding before the rest count as fallen behind |
| `--name <peer>` | mcp | `mcp-<three words>` | how it identifies itself to the network |
| `--name <peer>` | verbs | `cli-<three words>` | how it identifies itself to the network |
| `--wait <ms>` | verbs | `5000` | how long to wait for the peer to appear before giving up |
| `--json` | verbs | off | machine-readable output |
| `--args <json>` | call | — | the whole argument list as a JSON array, instead of words |
| `--idempotency-key <key>` | call | — | names the command, so two attempts under one key are one command rather than two. See [Sending a command twice on purpose](#sending-a-command-twice-on-purpose) |
| `--port <n>` | broker | `7843`, or `8843` with `--cert` | listens on every interface |
| `--name <peer>` | broker | `broker-<three words>` | how the broker identifies itself |
| `--upstream <url>` | broker | — | join another broker; repeatable |
| `--auth <file>` | broker, console, mcp, verbs, serve | — | bearer tokens: which to accept, and which to present. See [Authenticating the bus](#authenticating-the-bus) |
| `--quiet` | broker | off | stop logging peers arriving and leaving |
