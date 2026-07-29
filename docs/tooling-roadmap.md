# Tooling roadmap

What the CLI and console could become as a tool for testing and debugging a network of devices.
Written after a pass over the existing commands and a look at what MQTT monitoring tools
(MQTT Explorer, mqtt-spy, `mosquitto_sub -v -t '#'`) actually give people.

Ordered by what unlocks the most for the least. Nothing here is committed to; it is a list of what
is missing and what it would cost.

## Where it stands

Five commands — `extract`, `check`, `console`, `broker`, `mcp` — and one service, `ConsoleService`,
with five verbs: `peers`, `describe`, `call`, `watch`, `unwatch`.

Two observations from pointing the MCP server at a live network:

- **The broker is indistinguishable from a broken device.** `plantBus` appears in the peer list like
  anything else, and describing it gives `ClassNotFound: msgrpc.describe is not exposed` — the exact
  answer a real device gives when someone forgot `exposeIntrospection`. Nothing says "switchboard".
- **The console sees only its own traffic.** It shows calls it made and events it subscribed to.
  Traffic between two other peers is invisible to it, which is most of the traffic on a real network.

---

## 1. Headless verbs — done in msgrpc-cli 2.5.0

There is no way to call a peer from a shell. `console` needs a browser, `mcp` needs a model on the
other end, and CI has neither.

```
msgrpc peers      --hub http://bus:8080 [--json]
msgrpc describe   <peer> [--json]
msgrpc call       <peer> <namespace.method> [args...] [--json]
msgrpc watch      <peer> <namespace.event>          # jsonl until Ctrl-C
```

`ConsoleService` already does all of this; the verbs are that logic without the HTTP server, plus
exit codes so a failed call fails a build. Arguments are coerced against the peer's own contract —
`describe()` first, then the method's `params` decide whether `1200` is a number or a string — with
a JSON-else-string fallback when no contract is published.

This is the prerequisite for most of what follows: smoke tests in CI, a bash loop hammering a
device, `jq` over an event stream.

## 2. The traffic tap — done in msgrpc-cli 2.5.0

The MQTT-monitor feature, and the one thing the console genuinely cannot do. **Turned on at runtime
on a running broker rather than by restarting it with a flag** — a plant bus that has to be
restarted to be observed will not be observed.

Shipped: `bus.tap/untap/taps` on the broker, `TransportEvent.relayed` in the library, call/reply
pairing with latency, filters by peer/namespace/kind, payloads off by default, taps that expire.
Both backends are built — the broker hook for socket.io, the wildcard subscription for MQTT (on its
own connection, so overlapping subscriptions can never double-deliver a request). The console
exposes `tap`/`untap`/`taps` over both and the page has a Traffic tab.

Still open here: a tap is released only by `untap` or its ttl, so a page that closes leaves one
running for up to five minutes. Tying a tap to the peer that opened it would need the caller's
identity inside the method, which the RPC layer does not hand over today.

### Shape

The broker gains one namespace, `bus`:

```
bus.tap(filter?)      -> a token; frames start arriving as `bus.frame` events
bus.untap(token)
bus.taps()            -> who is tapping what
```

`filter` narrows by peer (either direction), namespace, or message kind, so "mirror everything
`plantServer` says and hears" is one call. Subscribers are ordinary msgrpc event subscribers, so
the console, the CLI's `watch`, and the MCP server all get it for free.

### The tension worth naming

The broker currently exposes nothing, deliberately: *"a peer addressing the broker by name gets
`ClassNotFound`, which is the truth — it is a switchboard, not a service."* Exposing `bus` makes
that sentence false, and it cannot be gated behind a start-up flag without reintroducing the restart
this is meant to avoid.

So: the namespace is always there, and the broker's startup warning grows a line. Anyone who can
connect to an unauthenticated broker can already impersonate any peer, so tapping is not a new
class of exposure — but it is a much more convenient one, and it should be refusable through the
existing `authenticate`/`relay` machinery rather than a flag of its own.

### Implementation

Two backends, one concept:

- **socket.io** — `SocketIoServerTransport.forward()` is the single point every relayed frame passes
  through. The tap is a hook there. This is the one that matters for the "add it to the live broker"
  case.
- **MQTT** — no broker of ours to hook, so the tap subscribes `<prefix>/rpc/+` (v1) or
  `<prefix>/{req,res,evt}/+` (v5) and decodes. The transport is already shaped for this:
  `MqttTransport` takes a `topic` option documented as "peer name to subscribe as",
  `topicAddressee()` already parses the addressee out of a topic, and there is a comment about
  watching a topic "on their behalf". It needs its own subscribe path rather than `topic: '+'`,
  since `isSafeTopicSegment` deliberately rejects wildcards.

### Why it beats a generic MQTT monitor

Those tools hand you a MsgPack blob on a topic. This knows what a frame is, so it can pair `POST`
with `SUCCESS`/`ERROR` by correlation id:

```
14:32:07.114  console-one → plantServer   plant.writeSetpoint(1200, 'auto')
14:32:07.156  plantServer → console-one   ok 42ms
14:32:09.001  plantServer => *            plant.alarm('pressure high', 2)
14:32:11.400  hmi-3       → plantServer   plant.read()
14:32:21.400  plantServer → hmi-3         Timeout 10000ms
```

On a signed network the tap still sees everything: signing wraps frames, it does not encrypt them.
Worth saying in the docs before someone assumes otherwise.

## 3. A problems panel — done in msgrpc-cli 2.5.0

All four transport reports — `rejected`, `unroutable`, `peerDisplaced`, `transportError` — now reach
a Problems tab and `console.problems`, kept in a bounded history so a page opened after the trouble
still sees it. Each peer also carries the link it was found on.

It did **not** explain item 9 below: the flakiness did not reproduce while the panel was watching,
and six healthy loads produced no reports at all. Worth retrying the next time it happens, which is
the whole point of the history being there.

## 4. A fake peer from a contract — done in msgrpc-cli 2.5.0

`msgrpc serve --contract plant.types.json`, with `--script` for canned returns, deliberate failures
and timed events, and `--fail ns.method=Code` as the shorthand. `Timeout` never answers at all.

Building it turned up a gap in the library: a method had no way to choose its error code, so every
throw reached the caller as `Exception` and fault injection could not stage `Unauthorized`. Errors
carrying a code the protocol defines are now honoured.

Still open: a mode that varies its answers over time. Deterministic was the right default - a fake
you cannot assert on is not a test fixture - but an HMI being demonstrated wants a reading that
moves, and `--script` cannot express that.

## 5. Record and replay — done in msgrpc-cli 2.5.0

`msgrpc record --out session.jsonl` and `msgrpc replay session.jsonl --against deviceUnderTest`,
exiting 1 on any difference.

Building it turned up the same race twice more: opening a tap and issuing the first call both
happened before presence had arrived, so a recorder found an empty network and a replay spent its
first call waiting out a timeout. Both now settle first, as the verbs already did. Worth watching
for anywhere else that acts immediately after `ready()`.

Not built: replaying events at a device, which would be a different thing - sending a device its own
output back. Recorded, though, so a later comparison could use them.

## 6. Contract conformance against a live peer — done in msgrpc-cli 2.5.0

`check` today is source-vs-file. Add peer-vs-file:

```
msgrpc check --peer plantServer --against plant.types.json
```

Call `describe()` on the device and run the same `namespaceProblems` comparison. Answers "is this
device running the firmware we think it is". Every piece exists; this is the wiring.

Sibling: `msgrpc diff <peerA> <peerB>` for "why does cell 3 behave differently from cell 2".

## 7. Bench

```
msgrpc bench plantServer plant.read --rate 20 --for 60s
```

p50/p95/p99 and an error breakdown. `call()` already returns `ms`; the console shows it once and
discards it. Finding the device that falls over at 10 calls a second is a real plant problem.

## 8. Console polish

Mostly the feature set MQTT monitors have converged on, and mostly missing:

- **Event stream: filter, pause, export.** Capped at 200 in memory, no filter, no pause, args
  `JSON.stringify`d onto one line with no expand. The Traffic tab has the first three; the Events
  tab still has none of them.
- **Latency kept per method** across the session, plus a "call it 100 times" button.
- **Call history with re-run**, and a **copy as CLI** button — pairs with the verbs above.
- **Saved argument presets** per method. Switching peers loses everything typed.
- **Watch all events on this peer** in one click.
- **Peer role labels** — broker / console / page / device — so a switchboard does not read as a
  broken node. A broker could advertise itself in presence; failing that, infer it from `describe`
  failing while the peer demonstrably relays.
- **Presence timeline.** Arrivals and departures with timestamps. A flapping device is a classic
  field problem and the console renders it as a dot that changes colour and forgets.

## 9. Somewhere to put a contract, and something to start from it

Anders' idea, and a good one: a model can write a contract JSON easily enough, but *where it goes*
and *how to stand something up from it* are steps that need a shell and a convention. An MCP tool
pair - write a contract to a known place, start and stop a fake from it - would close the loop, so a
model could scaffold a device, point an HMI at it and drive the whole thing without leaving the
conversation.

Worth designing carefully rather than quickly, because it widens what the MCP server can do from
"call things on a network" to "write files and start processes". The existing warning that anything
a model can reach it can call would need a companion.

## 10. The page sometimes fails to reach the console on load

Found while testing the Traffic tab, and **pre-existing** - it reproduces with the console page as
it was before any of this, on a console that has not changed either, roughly one load in two when
loads follow each other quickly. The page reports
`cannot reach the console: Timeout: no response to console.on within 10000 ms` and lists no peers; a
reload usually fixes it.

It does not reproduce outside a browser: a Node client doing the same three subscriptions over the
same link succeeds every time, including with abrupt closes between attempts, so the suspect is what
the browser does with the previous page's socket across a navigation rather than anything in the
subscription path.
