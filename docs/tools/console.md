# The console

```
source-rpc console --broker mqtt://localhost:1883      # an MQTT network
source-rpc console --hub http://hub:7843               # a socket.io network
source-rpc console --broker mqtt://... --hub http://... # both at once
```

Opens a console at `http://127.0.0.1:7844` listing every peer that is up, what each one exposes, a form to call it, and a live stream of its events.

**Discovery costs nothing.** Every peer announces itself, so the console is handed everyone already online the moment it connects. There is no scan, no probe and no configured list of hosts. Over MQTT that is retained presence under `<prefix>/presence/+`; over socket.io the hub keeps the list.

With both, one list covers both networks and each peer is called over the link it was found on — which is the useful shape when a plant runs on a broker and the HMIs are browser pages. A peer hosted *in* a browser shows up like any other, since a page that dials a hub can serve as well as call.

**Descriptions stay honest without being fetched on sight.** The console describes a peer when someone selects it, and caches what that taught — but presence carries a short hash of each peer's served description, so a peer that restarts with a different surface, or exposes something new after it started, is noticed the moment it announces. The console drops what it cached and re-describes on next use; an open panel refreshes itself rather than waiting to be reselected, and an unchanged peer costs no extra describes.

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

### State, and what it is drawn from

Press **observe** on a component and the panel fills with its props and state — not as a JSON blob, but as a tree built from the interfaces the contract publishes. `extract` reads a component's `Props` and `State` from the source, `describe()` carries them over, and the console has never seen the file: it knows `zones.top.setpoint` is a number and `door` is one of two words because the contract says so.

That is also why a field currently `null` is **labelled rather than omitted**. A tree drawn from the values alone cannot tell "this oven has no work order" from "this oven does not have work orders", and on a plant those are different facts.

The status sits beside the values and keeps its meaning: a dropped link marks the picture stale and **keeps it readable**, with the revision and "last known 14:03" next to it. Nothing blanks.

**Every leaf subscribes to its own path.** A component carrying 300 tags, one of which moves five times a second, would otherwise re-render 300 rows to move one number — so each leaf reads its own value through `useSyncExternalStore`, and a primitive that did not change bails out before React does any work. Branches subscribe to as little as they need to know their shape; the panel header reads only the status and whether data has arrived. Observing a 300-tag component for fifteen seconds, measured in headless Chrome:

| | script | layout |
| --- | --- | --- |
| re-render the tree from the snapshot | 312 ms | 34 ms |
| each leaf subscribes to its own value | 39 ms | 35 ms |

Layout is unchanged, which is the point worth keeping: React's diffing already kept the *DOM* work to the row that moved. What the arrangement saves is the render pass — the JS spent deciding that 299 rows still say what they said.

### Changing a value is calling a method

A state row is never written. Where the contract offers a way to change a field, the row **proposes a call** and shows it in full — `setSetpoint(180)` — and what the operator commits is that call, not a value.

**Which method is read from the contract, never guessed from a name.** A row gets an editor when some method declares [`@rpc({ sets: 'setpoint' })`](../guide/components.md#saying-what-a-method-sets) for that path, and gets none otherwise. A peer that declares nothing offers no editors at all, which is the honest answer rather than a guess.

The panel used to look for a one-argument `set<Field>`, which is right almost always — the residue being methods like `setMode`, which may begin a transition with an interlock behind it rather than assign `state.mode`, or `setPressure` sitting beside a measured `state.pressure`. A guess that is wrong is wrong *silently*, in the direction of commanding a plant, and nothing on the row shows it. Reading the declaration instead also reaches where a naming rule never could: `zones.top.setpoint` gets an editor two levels down, and the `zones.top.temperature` beside it — same shape, same type — correctly gets none.

A component carrying a few hundred tags declares one [generic setter](../guide/components.md#the-generic-setter-and-its-gate) instead of a marker per field, and then every leaf gets an editor — the path travels as an argument. That is coarser on purpose: the contract cannot say which of those paths the method will actually accept, so some attempts are refused by the component and the refusal arrives where the value would have been. A host that did not opt in publishes no such claim at all, and the panel offers nothing.

Nothing is written locally on success. The number on screen moves when the plant publishes its next snapshot, which is the only report that the plant agrees — an optimistic row would show a setpoint the oven refused. A refusal arrives where the value would have been.

### Context

Each node's panel can also show what it **inherits**: the site it stands in, the work order it is running, the maintenance window that applies to it. Type a token id — `acme.site` — pick the axis, and the console watches it; what it watches is remembered per peer.

The answer comes from the node's own host, over [`contextAt()`](../guide/context.md#asking-about-another-peers-node). The console does not resolve chains itself and does not graft itself into the topology next to whatever it wants to read, which would be a claim about the plant that is false. A `collect` token shows the whole chain, nearest first, each entry naming where it was provided.

**There is no list of tokens to pick from, and that is deliberate.** Context has no enumeration surface: listing what ambient data a plant carries is reconnaissance, and a token whose provider declares `exposure: 'local'` is filtered from remote answers silently rather than refused — a refusal would confirm it exists. So an operator types the ids they are entitled to know.

The axis is picked rather than guessed for the same reason it is elsewhere: it belongs to the token's definition, the console has not seen that definition, and there is no fallback between the two.

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
