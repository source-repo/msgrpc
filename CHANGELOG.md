# Changelog

## msgrpc 2.4.0 and msgrpc-cli 2.5.0

- **The traffic tap.** `msgrpc broker` now exposes a `bus` namespace — `tap(filter?)`, `untap`,
  `taps()` — and emits a `frame` event carrying what it is relaying. A console only ever sees its
  own calls and the events it subscribed to, which on a real network is a small fraction of what is
  happening; the broker sees everything, because it is the thing forwarding it.
  - **Turned on by a call, not by a flag.** A plant bus that has to be restarted before it can be
    watched will not be watched: the run worth looking at is the one already going wrong.
  - **It knows what a frame is**, which is what a topic browser pointed at the same wire cannot do.
    A call and its reply share a correlation id, so the reply is reported with the method it answers
    and the time it took — neither of which is in the reply itself.
  - Filters narrow by peer (either direction — "mirror that device"), namespace, and kind. Several
    taps run at once with different filters, and each frame names the taps it matched.
  - **Payloads are off by default.** The metadata is what a debugging session usually needs, and a
    plant bus carries values nobody meant to hand to whoever happened to be tapping. They are
    carried only if one of the taps that matched asked for them.
  - Taps expire on their own (300 s by default, 3600 s at most). A console that closes without
    untapping would otherwise leave the broker building and emitting frames for a subscriber that is
    not there. The calls awaiting replies are dropped with the last tap, so nothing accumulates
    between debugging sessions.
  - Traffic addressed *to* the broker is not tapped, only what it relays, so reading the tap back
    does not feed itself.
- **The broker describes itself.** It used to expose nothing at all, so a peer addressing it got
  `ClassNotFound` — true, and the plainest possible statement that this is a switchboard rather than
  a service. It was also indistinguishable from a device whose server was started without
  `exposeIntrospection`, which is what a broker in a peer list actually looked like. It now ships a
  contract and answers `describe`, so `msgrpc describe plantBus` says `bus@1` instead of an error
  that reads like a fault.
- **The tap works on MQTT too**, where there is no broker of ours to hook: the observation happens
  at the subscription instead — `<prefix>/rpc/+` under 3.1.1, each of `<prefix>/{req,rsp,evt}/+`
  under MQTT 5 — and a console started with `--broker` exposes the same `bus` and watches for
  itself. `MqttTransport` takes a `tap` option for it, and reports what it decodes rather than
  delivering it: a tap answers no calls and runs no methods.
  - **It gets its own broker connection**, opened when the first tap starts and closed after the
    last ends. A peer subscribed to both its own topic and the wildcard covering it has overlapping
    subscriptions, and a broker may deliver a matching message once per subscription — which for a
    request means the method runs twice. A separate instance is a separate client id and session, so
    the two can never overlap; there is a test asserting the device ran the method exactly once per
    call while tapped. It also means an idle console costs a plant broker nothing.
  - Frames are reported without checking signatures. A tap holds no key for a conversation it is not
    part of, and what is on the wire is what it exists to show.
- **`console.tap`, `untap` and `taps`**, so the page asks the console rather than hunting for a
  broker from the browser. The console turns on whatever it can reach — a broker's `bus` over
  socket.io, its own subscription over MQTT, both when it holds both links — and says which in
  `sources`. Frames arrive on one `frame` event either way.
  - Peers are described **in parallel** when looking for a bus. One peer that is registered but no
    longer answering — a page whose tab was closed — takes the whole call timeout to fail, and in
    sequence that was one timeout per stale peer before the tap started at all.
  - The console's record of a tap is given the same life as the tap it stands for, so a page that
    reloads without untapping takes its entry with it instead of leaving one for the life of the
    console.
- **A Traffic tab in the console**, next to Events and Chat: off until asked, with the filter set up
  before it starts, then one row per frame colour-coded by kind, a search box and a pause. It stays
  tapping while another tab is showing — unmounting it would have stopped the watching exactly while
  you looked away — and the count on the tab label is what arrived meanwhile.
- **`msgrpc bench`** calls one method over and over and reports what it cost. A device is fine at one
  call a second; what it does at twenty is the question, and answering it is ordinarily done with a
  script that is always the same script. **Percentiles rather than an average**, because an average
  hides exactly the calls worth knowing about - a device answering in 2 ms with one reply in four
  seconds averages out to something that looks healthy. Failures are counted by code, since a device
  refusing arguments and a device that stopped answering are different findings with the same shape,
  and any failure exits 1 because errors under load are the finding.
  - `--concurrency` bounds what may be outstanding; past that calls are **not sent and counted as
    fallen behind**. Piling them onto a device that is already behind measures the queue rather than
    the device, and would report healthy latencies for a device that is drowning.
- **Console polish.** The events pane gained the filter, pause and export the traffic tab already
  had - pausing stops the buffer filling rather than only the list rendering, and export writes the
  jsonl `msgrpc record` writes and `jq` reads. **Watch all** takes every event in a namespace in one
  click, which is the usual first move on an unfamiliar peer. Each method keeps its timings, with
  **×20** to call it repeatedly and report `20 calls · p50 1 ms · last 1 ms` - `bench` in miniature,
  for when the question is smaller than a benchmark. **copy as CLI** puts the equivalent `msgrpc
  call …` on the clipboard with the network flags this console was started with, because a call
  worth making in a browser is usually one worth putting in a script and retyping `--hub http://…`
  from memory is where that stops happening.
- **The MCP server can stand a peer up, and reaches the rest of this release.** Asking a model to
  test a device runs into the device having to exist first, and the steps that closed that gap -
  write a JSON file somewhere, open a second terminal, start the CLI - are exactly the ones a
  conversation cannot take. `start_fake` takes a contract **inline** and puts a peer on the network
  that answers from it; `stop_fake` and `list_fakes` manage them. They run inside the MCP server
  rather than as spawned processes, so they stop when it does and none are left behind.
  - **A fake will not take a name a peer already answers to.** Standing one up under a live device's
    name would displace it, and calls meant for the plant would reach a stand-in that agrees with
    everything. Refused, not resolved.
  - `check_peer` and `diff_peers` are the conformance verbs; `watch_traffic` returns what other
    peers said to each other over a few seconds, and `watch_events` what one peer emitted, dropping
    the subscription again so looking leaves nothing behind. Both are bounded, since a model asking
    for an hour would get one and the conversation would look hung.
  - `save_contract` and `list_contracts` appear **only when `--contracts <dir>` names somewhere to
    write**. A server that cannot write files should not advertise tools claiming it can. Contracts
    are written as `<name>.types.json` in that directory and nowhere else - a name that would climb
    out of it is refused rather than resolved - and the file is the one `msgrpc serve --contract`
    and `msgrpc check --peer --against` already read, so the loop closes.
- **`msgrpc check --peer`** points the build-time check at a device. `check` against source catches a
  change before it ships; what it could not answer is the question asked on site - the contract says
  this device offers `writeSetpoint(value, mode?)`, is that what the box on the wall is running? The
  peer describes itself and the answer runs through **the same comparison** the server applies to a
  caller declaring an older version, so a device behind its own contract is reported in exactly the
  words a stale caller would have got, and CI and the site agree about what "breaking" means.
  - A namespace the peer does not serve at all is reported apart from one that changed, and **a peer
    running without a schema is reported as unchecked rather than as passing**. It describes its
    method names and nothing else, and calling that "no breaking changes" would be the most
    useful-sounding lie available.
- **`msgrpc diff <peerA> <peerB>`** for the question that follows: why does cell 3 behave differently
  from cell 2? Contract versions, methods one has and the other does not, signatures that changed and
  events one no longer emits, side by side. Signatures are compared as they read rather than
  structurally, because the answer is read by a person standing in front of two cabinets. Exits 1 on
  any difference, so a script can assert that two cells match.
- **`msgrpc record` and `msgrpc replay`.** The tap already produces correlated, self-describing
  frames, so a recording is that stream in a file - jsonl, so `grep`, `jq` and `wc -l` work on it,
  and appended as frames arrive so a process killed mid-session still leaves what it saw. What it is
  for is the question a plant asks constantly and no test framework answers: this new device is
  supposed to behave like the old one, does it? `replay` re-issues the recorded calls in their
  original spacing, compares each answer with the one recorded, and **exits 1 when anything differed
  or failed**, so a conformance check is a line in a CI file.
  - `Date` and `Uint8Array` are tagged in the file and restored on the way back. JSON carries
    neither, and a timestamp that replayed as a string is not what the device received - the same
    reason this library speaks MsgPack in the first place.
  - **A call that failed the same way it failed when recorded is a match.** A replacement that
    refuses what the old one refused is behaving, and counting that against it would make every
    recording of a real plant unusable. A call with nothing recorded to compare against is counted
    apart rather than as a pass, and one recorded without payloads is reported rather than sent
    empty - calling the method with nothing and comparing that is the worse answer.
  - Payloads are on by default for `record`, where the tap has them off: a recording without
    arguments and results cannot be replayed, which is the only reason to make one. It says so on
    startup.
- **`msgrpc serve`** stands a peer up from a contract, so an HMI has something to talk to and a test
  has a device willing to fail on request — which a real one is not. It answers every method with a
  value of the declared shape and **refuses what the real peer would refuse**, since it is handed the
  same schema and runs the same validator. The contract is the one already extracted and committed
  for the deployed peer, so the stand-in cannot drift from it: `msgrpc check` fails the build when it
  would.
  - Generated values are deterministic and inside whatever the type language carries — the midpoint
    of a range, required fields only, the first non-null option of a union. A fake whose readings
    wander is pleasant to look at and impossible to assert on. `pattern` is the one constraint it
    cannot honour, and a recursive type stops rather than descending forever.
  - `--script` supplies canned returns, deliberate failures and events on a timer; `--fail
    ns.method=Code` is the same without a file. **`Timeout` is the special code: the call is never
    answered at all**, so the caller's own timeout is what fires — the failure an HMI handles worst
    and the one otherwise staged by pulling a cable. Only the named method is affected, so a test can
    break one thing rather than the device.
  - It says it is a fake on startup and in the class name a console shows, because a stand-in
    mistaken for the device is worse than no stand-in at all.
- **A method can choose its error code** by throwing an error carrying one. Everything a method threw
  came back as `Exception`, so a service that wanted to say "you may not do that" could say it only
  in the message, and a caller reading `code` to decide whether to retry, re-authenticate or give up
  learned nothing from it. Restricted to the codes the protocol already defines — `Unauthorized`,
  `Forbidden`, `InvalidParams`, `IncompatibleVersion`, `ClassNotFound`, `MethodNotFound`,
  `TransportError`, `Timeout` — so an error carrying an unrelated `code`, a Node `ENOENT` say, is
  still reported as the exception it is. **This changes what callers see** from a method that already
  throws such an error: the code is now that one rather than `Exception`, and the message is
  unchanged.
- **A Problems tab**, and `console.problems` behind it. The transports have always emitted
  `rejected`, `unroutable`, `peerDisplaced` and `transportError`, and the console listened to none
  of them — it wired up `peerOnline`/`peerGone` and dropped the rest. Between them those four cover
  every way a call disappears without an answer: refused before the RPC layer, nowhere to deliver
  it, a name two peers are both answering to, or a link that failed underneath. Until now all of it
  arrived as an unexplained timeout, which is the hardest kind of problem to diagnose and the one
  this tooling exists to make visible.
  - **Kept as well as streamed.** Nothing to switch on, a bounded history, and the page is handed
    what happened before it was opened — because nobody opens the console until something is already
    wrong.
- **Each peer says which link it was found on.** `console.ts` looped over `network.transports` to
  build the online set and threw the transport away, so a console holding a browser link, a broker
  and a hub at once could not say which one a peer was on. Peers already connected when the console
  starts get theirs from the registry, which is how they were discovered in the first place.
- The console's own contract now **declares its events**. It described five methods and none of its
  three events, so a console pointed at another one showed an empty event list on a service that
  emits `event`, `peer` and now `frame`.
- **`TransportEvent.relayed`** reports a frame a server is passing between two other peers — the
  only place traffic nobody here sent or received can be observed. Emitted from the one point both
  relay paths cross, so a frame moving to another transport is reported too and a tap on a mixed
  network does not quietly miss half of it. Guarded on the listener count, since it runs per frame
  and building the object for nobody is the cost.

- **`msgrpc peers`, `describe`, `call` and `watch`** — the console's verbs for a shell rather than a
  browser. Everything the network could be asked was reachable only through `console`, which needs a
  browser, or `mcp`, which needs a model on the other end; a shell script and a CI job had neither.
  These take the same network flags, answer once, and exit 1 when a peer refuses, which is what
  makes a smoke test a line in a CI file instead of a program that parses output.
  - **Arguments come from the peer's own contract.** A shell has only strings, so the peer is
    described first and its schema decides what each word means: `1200` is a number where the
    contract says `number` and the text `1200` where it says `string`, `auto` matches a literal in a
    union, `bytes` takes hex and `date` takes an ISO string. Without this,
    `msgrpc call plant plant.writeSetpoint 1200` sends `"1200"` and comes back
    `InvalidParams: expected number, got string` — correct, and useless. Where a peer publishes no
    contract the rule is JSON-if-it-parses and the literal text otherwise, so `42` is a number and
    `hello` is a string rather than a syntax error. `--args '[…]'` is the escape hatch.
  - A word that cannot be what the contract asks for is refused before anything is sent, and the
    argument is **named rather than numbered**: `argument 0 (celsius): expected a number, got 'warm'`.
  - `--json` on every verb, rather than guessing from whether stdout is a tty — that guess is wrong
    exactly when it matters. `call` puts the result on stdout and the timing on stderr, so a pipe
    carries the value and nothing else. `watch` writes jsonl, since a stream that is pleasant to
    read is a stream nothing can parse.
  - Each verb waits up to `--wait` for the peer to become addressable. `ready()` means the links are
    up, not that presence has arrived, and a one-shot command that gave up on that gap would fail
    intermittently for reasons nobody could reproduce.
  - Ctrl-C on `watch` drops the server's subscription as well as stopping the stream, so a debugging
    session leaves no listeners behind on a device that outlives it.
- Joining a network is now one function rather than three copies of twenty lines. `console`, `mcp`
  and the verbs built the same transport list each, which is three places to forget `--prefix` in,
  and the same two checks — that there is something to join, and that a `--name` does not contradict
  the name the key file belongs to.

### Security

- Anyone who can reach an unauthenticated broker can now call `bus.tap()` and mirror everything
  crossing it. They could always have read the same traffic by impersonating a peer — the broker
  has never checked who anyone is — but not this conveniently. `authenticate` and `relay` are what
  gate it, and the broker now says so on startup next to the warning it already printed about
  relaying for whoever connects.

## msgrpc-cli 2.4.1

- The `msgrpc` binary is made executable at build time. `tsc` writes `dist/index.js` with a shebang
  but no executable bit; npm sets it when installing a published tarball, so the published package
  was fine and a workspace checkout was not. `npx @source-repo/msgrpc-cli` run from inside this repo
  resolves to the workspace copy and died with `sh: 1: msgrpc: Permission denied` - which an MCP
  client reports only as "Connection closed".

## msgrpc 2.3.0 and msgrpc-cli 2.4.0

- **`msgrpc mcp`** serves a live network to an [MCP](https://modelcontextprotocol.io) client over
  stdio, so a model can look at a plant the way a person looks at the console. Three tools -
  `list_peers`, `describe_peer`, `call_method` - rather than one tool per method on the network: a
  peer set that changes mid-conversation would mean re-issuing the tool list on every arrival and
  departure, and `describe_peer` hands over the argument types instead. A call a peer refuses comes
  back as tool content carrying the reason, not as a JSON-RPC failure, because a model can act on
  the first and not the second. No MCP SDK behind it - MCP is JSON-RPC 2.0 over newline-delimited
  stdio, and this package is about not needing a second RPC framework.
- **A name collision is reported on MQTT 3.1.1 too**, where it has to be inferred rather than read:
  3.1.1 has no reason codes, so a session taken over looks exactly like the link dropping - except
  that it does not stop, because two peers sharing a client id evict each other on sight and neither
  connection outlives the next one's arrival. Three connections in a row that die young are reported
  as a suspected collision, and said to be a guess, since a network flapping this hard looks the
  same. MQTT 5 still says so outright with reason code `0x8E`.

### Fixed

- **`SocketIoClientTransport.close()` returned before the connection was closed.** `disconnect()`
  only starts it: a close packet goes out and it returns, leaving the engine's ping timer armed
  until the transport is actually torn down. So a promise that was supposed to mean "closed"
  resolved while the connection was still running - the mirror of what the server transport already
  got right, where `io.close()` and the HTTP server's close are both awaited. This was also the
  intermittent hang after a passing test suite, which ava 8 reports as a failure rather than a
  warning: 4 reproductions in 40 runs before, 0 in 40 after.
- socket.io connections are refused while a server is closing, at the handshake, so one completing
  inside that window cannot outlive the sweep that was meant to disconnect it.
- `GenericModule.ready()` polled with no way out, so a module that never became ready - one that
  failed to start, or was closed while something still awaited it - spun on a 10 ms timer for the
  life of the process, which is also enough to keep the process alive with nothing left to do. It
  now gives up and returns false.

## msgrpc 2.2.0 and msgrpc-cli 2.3.0

**Discovery and routing over socket.io**, so a network with no broker works the way an MQTT one
always has - and so a server hosted in a browser page is a peer like any other.

- **Readable peer names.** The default is three hyphenated words from the BIP-39 English list
  (`brisk-otter-cable`) rather than a UUID. That list is 2048 words chosen to be unambiguous in
  their first four letters; the rest of BIP-39 - entropy sizes and a checksum - is for seed phrases
  and does not apply. A name is what a caller addresses, what presence lists, what a log line blames
  and, over MQTT, the broker's client id, and a UUID is none of those things legibly.
  `readableNameFrom(seed)` derives the same name from the same seed, for a peer meant to be
  recognised across restarts.
- **A browser can host an `RpcServer`.** `RpcServer` in Node is `NodeRpcServer`, which adds
  `{ port }`, `{ server }` and `{ brokerurl }`; in a browser the same name is the portable base,
  which has none of them. Source that sticks to `{ connect }` and transport instances is portable
  between the two, and `{ port: 8080 }` in browser code is a compile error rather than a runtime
  throw. Nothing a browser resolves imports socket.io's server or the MQTT client, so neither
  reaches the bundle without any bundler configuration.
- A listener that cannot bind now fails `ready()` with the reason - a port already in use is not
  something more waiting fixes - instead of being waited out for the full `readyTimeout`.
- **`RpcServer.proxy()`**, the mirror of `RpcClient.proxy`. A peer that both serves and calls now
  needs one object and one connection, under one name, rather than an `RpcServer` and an
  `RpcClient` under two - which over MQTT meant two broker sessions. Its subscriptions are replayed
  on reconnect the way a client's are.
- **A bus without a broker.** An `RpcServer` that exposes nothing and only relays is one; everything
  else joins with `{ connect: url }` and gets presence, addressing by name, and any-to-any calling.
- **More than one hop.** A peer announces the peers reachable *through* it as well as its own name,
  so a server that is a hub for its own peers and a member of a bus makes each visible to the other.
  Calls, replies and events all traverse it, and departures propagate. Verified to three hops.
  Split horizon - never advertising a peer back along the link it came from, in the broadcasts and
  in the snapshot handed to a newly connected peer - keeps two hubs from concluding the other is
  the way to a peer and losing it. Frames carry a hop count and are dropped after 8 relays, since a
  mesh that has just lost a link can hold a cycle until the tables settle. A peer offered by two
  links keeps the first and falls back to the second; a peer announcing itself outranks one merely
  carried.

- **Every peer announces itself on connect**, and is told who else is there. A socket.io server used
  to learn a peer only from the header of a frame it sent, so a peer that merely listened was
  invisible and could not be addressed at all. `peerOnline` and `peerGone` now come from both
  transports, so code watching a network no longer cares which one it is on.
- **`transports: [{ connect: url }]`** lets an `RpcServer` serve over a connection it opens. A
  browser cannot listen, so this is the only way a page can host a service; the hub relays calls to
  it.
- **A server relays for its connected peers.** A frame addressed to another peer it can see is
  forwarded instead of executed locally. `relay: false` forwards nothing, and a predicate decides
  per connection. The decision is remembered per pair of peers, because a rule written about the
  caller would otherwise strand the reply travelling the other way. A relaying server with no
  `authenticate` warns once, the first time it actually forwards something.
- **A server holding both a socket.io listener and a broker connection bridges them.** A browser
  peer discovers a peer that exists only on MQTT and calls it, with the call arriving under the
  browser peer's own name rather than the bridge's, so per-peer authorization and subscriptions
  still mean something. The bridge subscribes to the reply and event topics of the peers it
  forwards for, and publishes presence on their behalf - without that, a departing browser peer
  left its event subscriptions on the MQTT server forever.
- **`msgrpc console --hub <url>`**, on its own or alongside `--broker`. With both, one list covers
  both networks and each peer is called over the link it was found on.
- **`msgrpc broker`** runs a WebSocket bus until Ctrl-C, for networks with no MQTT broker to share:
  it relays between the peers that connect and tells each who else is there. `--upstream <url>`
  joins another broker, repeatable, and the two become one network - a peer on either is callable
  from the other. It is an `RpcServer` exposing nothing; there is no separate implementation.
- **A `record` kind in the schema type language**, for a dictionary whose keys are not known in
  advance: `{ [tag: string]: Reading }`, which is how plant data usually arrives. `extract` used to
  refuse an index signature outright, because describing one as an object with no properties
  produces a type that rejects every value. A record checks every value against one type and leaves
  the keys open, or constrains them with `keyPattern` - which is what a numeric index signature
  becomes, since a JS object key is always a string on the wire - and `maxEntries` bounds it the way
  `maxItems` bounds an array. It was also the first thing needed to describe msgrpc's own
  introspection output, which is built out of `{ [name: string]: TypeNode }`.
- **`describe()` describes itself.** The `msgrpc` namespace ships a contract extracted from its own
  source, so a peer reading a server sees the type it will get back. Its named types are prefixed
  `msgrpc.*`, because the schema has one type map shared by every namespace and a plant defining its
  own `TypeNode` should not find `describe()` described against it. A schema that already defines
  `msgrpc` is left untouched.
- **The console and the page it serves ship contracts too**, so pointing one console at another
  gives argument fields rather than `call(...)` and `say(...)`. `npm run contract` regenerates all
  three; a test asserts they still match the source they came from.
- **A name collision is reported rather than silent.** Both transports emit
  `TransportEvent.peerDisplaced` and warn once when a second peer turns up under a name already in
  use. The newcomer still takes the address - a peer reconnecting after a blip announces itself
  while the old connection may still look live, and refusing it would lock a peer out of its own
  name - but two peers genuinely sharing one used to send each other's replies into the wrong place,
  which reads as calls timing out for no reason. Over socket.io the server sees both connections;
  over MQTT the client id is derived from the peer name, so the broker hands the session over and
  tells the displaced peer why with reason code `0x8E` (MQTT 5 only).

### Fixed

- **A socket.io server executed calls addressed to another peer.** The target was tested only for
  being a name the server had heard of, never for being the server itself, so a call meant for
  someone else was answered by whoever it reached - with that server's own implementation, reported
  as success. It now forwards, or refuses; it never substitutes itself. A frame that can be neither
  delivered nor relayed is reported as `unroutable` rather than dropped in silence, which callers
  only ever saw as an unexplained timeout.
- `MqttTransport` set the response topic of a forwarded request to its own address, so a
  non-msgrpc peer honouring it would have replied to the wrong peer.
- A socket.io server reported itself ready before its port was bound, and had no handler for the
  listener's `error`. A port already in use therefore announced a running server and then took the
  process down with an unhandled event; it now waits for `listening` and reports the failure.
- `exposeIntrospection` with `validation: 'required'` refused `msgrpc.describe`, so the one call a
  peer makes to find out what a server offers was the only undescribed thing on it.
- `validateValue` returned "valid" for a node whose `kind` it did not recognise - a typo, or a
  document written for a later version of the language - which is an unchecked value wearing a
  checked type. It now refuses.
- `extract` keyed a generic instantiation under its bare alias, so `Record<string, number>` and
  `Record<string, string>` collapsed into one named type and the second silently became a reference
  to the first's value type. Instantiations are inlined instead.
- Every console page derived its peer name from the console's host, so every browser pointed at one
  console produced the same name and their replies went to whichever the server registered last. A
  page now takes a random readable name, kept in `sessionStorage` so a reload comes back as the same
  peer; `?name=` overrides it, the page's version of `--name`.

### Tests

- MQTT test peers get a 10 s session expiry. Names became unique per run in 2.1.1, which fixed one
  problem and created another: a server keeps a persistent session for an hour by default, so every
  run left another one behind. After a day of runs the broker held 1024 sessions and 3628
  subscriptions and stopped accepting connections. The one test that is *about* the hour-long
  default keeps it and clears its own session afterwards.

### Breaking

- `new SocketIoClientTransport(url, sources, options)` is now
  `new SocketIoClientTransport(name, url, sources, options)`. A peer has to know its own name to
  announce it, the same way `MqttTransport` has always taken one. `RpcClient` passes its `name`
  through, so this only affects code constructing the transport directly.
- `TypeNode` gains a `record` variant. A schema written by hand needs no change, but code that
  switches exhaustively over the union has a new case to handle.

## msgrpc 2.1.1

Documentation and test hygiene; no change to shipped code.

- The quick start did not compile: `Calculator` was neither exported by the server snippet nor
  imported by the client one, and the client needs the class as a type to get a typed proxy. It is
  now a shared `calculator.ts` the client pulls in with `import type`, which is the point being
  made and was the thing left out.
- The MQTT example gave the server `prefix: 'site-4'` and the client no prefix at all, so the two
  could never reach each other. An `mqtt://` url takes the default prefix and there is no client
  option to change it, so the section now shows building the `MqttTransport` and says what the
  mismatch looks like: a bare call timeout.
- A **Connecting** section, which was missing entirely - transports against urls, peer names and
  targets, `ready()`/`close()`, and the MsgPack/JSON choice. The README went from the quick start
  to decorators and schemas without ever saying how to point a client at a real server.
- Reordered so the basics come first: exposing, errors, events, then schemas and versioning, then
  introspection, authentication and MQTT. Security and broker detail used to arrive before the
  ordinary reader had been shown a second method call.
- The opening sentence said "expose an instance", which read as though instances were incidental.
  It now says the instance is one live object that every call runs against, and the quick start
  demonstrates state surviving between calls.
- Exposing more than one namespace, and `exposeObject`, are both shown.

### Tests

- The MQTT tests gave every peer a fixed name, and a peer name is the broker's client id. A server
  keeps a persistent session, so a second run resumed the first run's session and was handed
  whatever it still had queued - which showed up as an occasional failure that never reproduced
  when the file was run on its own. Names and topic prefixes now carry a per-run suffix.
- `rpc traffic is published per peer` waited for two messages on the observed prefix before
  asserting, which the two presence announcements could satisfy on their own, leaving the reply
  still in flight. It now waits for the rpc topics it is actually about.

## msgrpc-cli 2.2.0

- **`msgrpc console` is now a React app, and it reaches the CLI over msgrpc itself.** The CLI runs
  an `RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace
  (`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events; the browser is
  an ordinary `RpcClient`. The REST endpoints and the server-sent event stream are gone. The
  console is now the library's own first client, so a fault in event routing surfaces here before
  it reaches a plant.
- **A method folds open into a form with one field per argument**, built from that argument's type:
  a number input carrying the schema's bounds, a dropdown for a union of literals, a checkbox for a
  boolean, a picker for a date, a hex field for bytes, and for an object a JSON box pre-filled with
  the shape's required fields. Optional arguments have a checkbox deciding whether they are sent at
  all. Previously the whole call had to be written as one JSON array.
- JSON typed into a field is walked against the type before it is sent, so an ISO string where the
  schema says `date` becomes a `Date`. Without this any object carrying a timestamp was rejected by
  the server that asked for one.
- The browser waits longer than the console's own `--timeout`, which the console reports. Both
  defaulted to 10 s, so a call into an unreachable peer used to time out in the browser at the same
  moment the console was forming the answer that said why.
- Everything is bundled into `dist/web`; nothing is fetched at runtime.

## msgrpc 2.1.0

- `MethodSchema.paramNames` carries parameter names, and `msgrpc.describe()` reports them. Tooling
  that has to present a call to a person needs a label, and "argument 0" is not one. Optional and
  never used for checking, so a hand-written schema can leave it out. `msgrpc extract` writes it.

## msgrpc-cli 2.1.0

- `msgrpc console --sign <keyfile>` lets the console take part in a signed network. Without it the
  console lists peers, because presence is unsigned retained state, and then every call times out
  with nothing to say why. Keys come from a file rather than a flag, since a secret on a command
  line is visible to anyone who can run `ps`, and a `--name` contradicting the key file is refused
  rather than left to surface as that same timeout.
- README corrected: it claimed broker credentials and signing already applied to the console, which
  they did not, and documented none of the console's flags.

## msgrpc 2.0.1

- README rewritten. It documented 3 of 14 server options, described the MQTT v1 topic layout as
  current when MQTT 5 has been the default since 2.0.0, and its low-level examples wired converters
  that 2.0.0 removed. No code change.
- `repository.directory` and `homepage` added, so npm and GitHub can find each package in the tree.

## 2.0.0

A near-complete rework of everything below the API. The class-as-contract surface is unchanged —
`exposeClassInstance` and `proxy<T>()` still look the same — but correlation, addressing,
reconnection, security and the MQTT wire format were all rebuilt.

Published as `@source-repo/msgrpc` and, new in this release, `@source-repo/msgrpc-cli`.

### Breaking

| change | what to do |
| --- | --- |
| Output moved from `dist/src/*` to `dist/*`, with an `exports` map | Use the package name; deep imports into `dist/src` no longer resolve |
| ESM only, Node >= 18.17 | — |
| `RpcClient` extends `EventEmitter` | Only matters if you subclassed it |
| `ready()` throws after `readyTimeout` (default 30 s) instead of waiting forever | Catch it, or set `readyTimeout: 0` for the old behaviour |
| `RpcErrorPayload.exception` replaced by `error`, and error payloads carry `id` | The old field always encoded to `{}`; read `error.message` |
| `MqttTransport(name, url, options, sources)` — options are an object | `topic` and broker options move into it |
| MQTT defaults to protocol 5 on prefix `msgrpc/v2` | Set `protocol: 4` for the old `$`-header layout on `msgrpc/v1`; the two never share a topic |
| `manageRpc` is no longer exposed remotely | Set `exposeManagement: true` if you relied on remote `createRpcInstance` |
| Transports carry messages, not bytes; encoding lives in the transport | Only matters if you wrote a transport or wired the module chain by hand |
| `GenericModule.knownSources` static removed | Each `RpcServer`/`RpcClient` owns a `PeerRegistry` |
| `MessageSigner`/`MessageVerifier` take canonical bytes plus a context | One signer now serves both wire formats |
| An event is delivered only to the peer and namespace it came from | Previously every subscriber of that event name received it |
| `uuid` 14, `@types/node` 22 | — |

`exposeClassInstance(instance)` may now omit the name when the class declares `@rpcNamespace`.

### Security

Several of these were exploitable in 1.x. If you ran 1.x where untrusted peers could reach the
transport, assume they were reachable.

- **Replies were broadcast to every connected socket.** An unauthenticated socket could read another
  client's payloads; clients merely filtered on arrival. Replies now go to one socket.
- **`ManageRpc` exposed itself**, so any peer could construct any `exposeClass`'d class with chosen
  arguments, or overwrite an exposed name and deny service to everyone else.
- **MQTT peer names were interpolated into topics unchecked.** A peer named `#` subscribed to every
  other peer's traffic. Names are now validated as a single topic level.
- Optional `authenticate` / `authorize`, with identity bound to the connection rather than looked up
  by a claimed name, so one peer cannot address messages as another.
- Optional frame signing (HMAC-SHA256 or Ed25519) with replay protection, which gives MQTT peers a
  verifiable identity without trusting the broker.

### Added

- **MQTT 5 frame layout** — reply address, correlation and method travel as packet properties, so a
  peer with no msgrpc code can take part and standard tooling can read the traffic. See
  `docs/mqtt5-frame-spec.md`.
- **Argument checking** against a schema, with `@rpc` marking which methods are exposed at all.
- **Contract versions**, compared structurally: a caller built against an older contract keeps
  working unless the two genuinely disagree.
- **`msgrpc.describe()`** reporting namespaces, methods, events and live instances. Off by default.
- **`@source-repo/msgrpc-cli`** — `extract` reads a contract from TypeScript source, `check` fails a
  build on a breaking change, `console` serves a browser view of a live network.
- MQTT shared subscriptions for server replicas, bounded sessions, and presence.
- Connection lifecycle events, configurable `callTimeout`, and fail-fast on disconnect.

### Fixed

- MsgPack round-tripped through JSON, turning every `Uint8Array` into `{"0":1,…}`.
- A server-side throw never rejected the caller; it timed out after 10 s with the error discarded.
- Pending-call bookkeeping never drained, leaking a timer per call.
- Repeated `on()` stacked a server-side listener each time and none could be removed.
- Clients did not re-subscribe after a reconnect, and servers never released a departed peer's
  subscriptions.
- `off()` was never handled by the server, so unsubscribing did nothing.
- Peer routing lived in one process-wide static, so two servers in a process could deliver each
  other's replies to the wrong client.
- `open()` ran twice per client, and `close()` left socket.io's reconnect timer armed.
- Browser builds pulled in the MQTT client whether or not they used it.
