# Changelog

## Unreleased

### The AI grants document: closed by default, on every node

What an AI principal may do here is now a small declarative document rather than something an authorizer has to be written to express — because a console can render data and cannot render a callback, and a reviewer can diff a file and cannot diff a decision made inside somebody's `authorize`.

`aiGrants` on `RpcServer` takes a schema-versioned document carrying a monotonic revision and the grants that are open: `ai.tool.write`, `ai.tool.program`, `ai.program.write`, `ai.program.program`, and `ai.sponsor` for `security-admin`-effect calls. Each may be scoped `to` peer names or `roles`, given an `expiresAt` lease, and bounded by `maxGeneration` so a grant can say how far down a chain of programs it reaches.

The properties that matter: **closed is the default everywhere** — a node with no document refuses every AI write and programming call, and there is nothing to switch on to be safe; **enforcement runs before `authorize`**, so a node whose author wrote no authorizer still refuses, with `authorize` remaining the fine-grained veto above it; **observation stays open**, because a badged principal that can see everything and touch nothing is useful on day one; **one grant never covers another**, which is what `effect` was added for; and **a malformed document refuses the server** rather than being read as granting nothing. `onAiDecision` receives every gated decision with the sentence explaining it — the open half of the audit story.

Behaviour note for anyone who adopted 4.6.0's derived credentials: scripts carry `ai-program`, so their state-changing calls are refused until a grant opens that rung. That is the intended shape rather than a regression, and observation is unaffected.

### A tap ends with the page that opened it

A console tap was released only by `untap` or its five-minute ttl, so every page that closed left one running — and a debugging session is mostly reloads. A tap now records the peer that opened it, taken from the invocation handle rather than a parameter, since a caller-supplied name would be a claim and what this decides is whose tap to stop. A page is a peer on the console's own listener, so a closed tab takes its tap with it. The ttl stays as the backstop for an opener that left without a goodbye, and `taps()` now reports the owner — which answers *who is tapping what* rather than only what is being tapped.

`injectInvocation` could not be used on a method whose last real parameter is optional, which `tap(filter?)` is. TypeScript refuses a required parameter after an optional one, and both the extractor and `WithoutInvocation` demanded exactly `RpcInvocationHandle` rather than the `| undefined` that an optional declaration produces. Both now admit the optional form, and neither admits a trailing `unknown` — the trap the bidirectional check exists for, since `unknown` accepts a handle without being one and stripping it would silently shorten an honest signature. `NonNullable<unknown>` is `{}`, which is not a handle, so that stays true. There is a type-level test, because a regression here does not throw: it publishes a handle in somebody's proxy signature.

The wire contract is unchanged — the handle never reaches callers — and `ConsoleTap` gains `owner`.

### The grants document, reachable from the command line

`aiGrants` was enforced by the library and offered by nothing the CLI had, so `source-rpc node` — the command whose entire purpose is running scripts, and whose scripts carry `ai-program` — had no way to be given one. `node` and `mcp` now take `--grants <file>`, and a `node` task takes `grants` as a path.

A path rather than flags, because the document is data with a revision: a console can render it and a reviewer can diff it, which is why it is a document and not somebody's `authorize`. It is also not a secret, so unlike `sign` and `auth` it is never written inline in a task file — the revision exists so policy can be replaced on its own cadence.

A document that cannot be read refuses the node rather than starting with nothing granted. Startup prints what is open whether or not one was given, since closed-by-default means "it is running" and "it can do something" are separately true. Refusals are printed as they happen, with the sentence explaining them; permitted calls are not, because burying a refusal is the way to make it useless.

`SIGHUP` re-reads the document on `node`, on `mcp` and on every node a task file started, so a grant can be closed without stopping a node in the middle of something. A failed reload keeps the document already in force; a revision that goes backwards is applied and said out loud.

### One host process from a task file

`source-rpc run host.tasks.json` starts console, node and contract-backed serve roles in one process. Shared network settings remove the repeated broker URL while every task keeps a distinct peer name and signing file, so combining supervision does not combine authority. Paths are relative to the task file, unknown fields and duplicate identities are refused before startup, a later failure closes roles that already started, and SIGINT/SIGTERM closes them in reverse order.

Console startup now reports listener errors such as `EADDRINUSE` to its caller and closes the network connection it had already opened. Previously that error escaped as an uncaught server event, which made reliable multi-role rollback impossible and left an announced peer behind after the listener failed.

### Credentials a task file can carry, and a generated one to start from

`sign` and `auth` each take a path or the secrets themselves, so a host whose roles are deployed as one unit can keep one file instead of four. `sign` inline is the peer's own HMAC identity and the `peers` it verifies; `auth` inline is the `token` a hub is shown and the `derive` secret a node mints its scripts' credentials with. `tokens` and `issuers` are refused inline, because they say what a bus accepts and no task type is a bus — an `auth` file may still carry them, since that file is what `broker` reads. `network.mqtt` gives the broker account a place in the file, replacing `SOURCE_RPC_MQTT_USERNAME` and `SOURCE_RPC_MQTT_PASSWORD` rather than merging with them, so half a credential can never come from each. A task file that carries secrets gets the mode warning key files have always had.

Two things a task file could not do before this, both of which looked configured and were not: a node started from one now mints derived credentials for its scripts, where previously `derive` had nowhere to go and every script started unauthenticated; and a task can present a bearer token to a hub that authenticates, where previously there was no way to give it one.

`source-rpc run --init host.tasks.json` writes a task file with the three roles, fresh signing secrets from the system generator, each role's `peers` naming the others, and `--scriptable-by` in all of them. Mode `600`, and it refuses to overwrite — the file it would replace holds the identities every other machine on the network was told to expect.

With no file named, `run` and `run --init` both use `source-rpc.tasks.json` in the working directory — so a set-up host is `source-rpc run` and nothing else. The working directory and nowhere else: this does not walk up the tree the way `package.json` is found, because a task file is an identity and which one ran must not depend on where the shell happened to be. The filename is defaulted and the command is not; bare `source-rpc` still prints usage, and now mentions a task file when it sees one rather than starting it.

A `console` task also takes `cert` and `key` now, so a host already serving an HTTPS console can move to a task file without quietly becoming plain HTTP — which it would have, since a file that says nothing about certificates is a valid file. Both together or neither, and a certificate moves the default port to 8844 exactly as `--cert` does.

## Source RPC 4.6.0

Two pieces of the AI boundary's foundation, both prerequisites rather than the boundary itself, and one behaviour change worth reading before upgrading a node that runs scripts.

### Derived credentials: a script gets one of its own

A node that runs scripts used to hand each one its own bearer token. That was wrong twice: a token is pinned to exactly one peer name, so the script could not authenticate under its own name with it anyway — and passing it put the node's credential into the environment of an arbitrary program, which for a program an AI wrote is precisely what the boundary work exists to prevent. **The node's token no longer reaches a script at all.**

`mintDerivedCredential` and `createDerivedAuthenticator` are the mechanism: an issuer holds a secret the bus also knows, mints a short-lived signed credential naming the child, and the bus verifies it without having been configured with anything about that child in advance — which is the point, since a node may start a script the operator has never heard of. What a bus is configured with is which nodes it lets vouch for their children. `firstAuthenticator` composes it with `createTokenAuthenticator`, so operators hold tokens and nodes vouch for programs on the same bus.

In the CLI: `derive` in a node's auth file, `issuers` in the bus's. A script is started with `SOURCE_RPC_NAME` and `SOURCE_RPC_TOKEN`, its identity carries `ai-program` in roles and the issuer, generation and chain in claims — visible to `authorize` and the invocation handle at every dispatch. Without `derive` a script starts with no credential rather than borrowing the node's, which on an authenticating bus means it reaches only what an unauthenticated peer may reach. Honest, and the previous behaviour was not.

Lifetimes are short and there is no renewal, so a stopped node's credentials expire on their own; immediate revocation is separate work and does not exist yet. HMAC is symmetric — whoever can verify one of these can mint one — so the secret is shared only between a bus and the nodes it trusts to speak for their children.

### `effect`: what kind of power a method exercises

Declared beside `semantics` and deliberately orthogonal to it, because the two answer different questions and one field cannot carry both: `deployProgram(bundle)` and `setSetpoint(value)` can be equally honest `idempotent-command`s, and permission to move a setpoint is not permission to deploy a program. `@rpc({ semantics, effect })` takes `observe`, `operate`, `program` or `security-admin`; `exposeMethods` takes it too, so code that cannot use decorators is not locked out.

Undeclared defaults conservatively — a declared `query` observes, anything else operates — because an unclassified method is not a harmless one. `describe()` always reports an effect so a consumer never reimplements that rule; `extract` records only what the source declared, and a mistyped effect is a loud diagnostic rather than a silent omission, since this is the field a future grant is written against. `check` treats an escalation as breaking and a dropped declaration as breaking, while *adopting* a declaration where there was none is deliberately not flagged: saying out loud what a method always did must never be the change that fails a build.

Nothing enforces this against AI principals yet — that is the AI boundary work, and this classification is its prerequisite. It lands first because contracts are long-lived and the field is cheapest to add while the only contracts in the world are ours.

## Source RPC 4.5.0

One thing, both halves: code that cannot use decorators can now say everything the decorators say.

### Decorator-free marking that can say everything, and a CLI that strips

`@rpc` and `@rpcNamespace` are standard ECMAScript decorators, V8 does not ship decorators, and Node's type stripping — how the scripts directory runs — dies on the `@` with a SyntaxError. The population that cannot compile was locked out of exactly the options the field trial proved scripts need most. Two answers, one mechanism:

`exposeMethods` now takes an object form carrying the same options the decorator takes — `exposeMethods(ChatService, { say: { injectInvocation: true }, status: { semantics: 'query' } })` — and `declareRpcNamespace(ChatService, 'chat', { version })` is the decorator-free `@rpcNamespace`. Both write the records the decorators write, so semantics, conflation, authority and the invocation handle are no longer privileges of code with a build step. The array form of `exposeMethods` stays as the nothing-declared shorthand.

`source-rpc strip <file…> --out <dir>` writes the decorator-free twin of a decorated source file: decorators blanked in place, the marks re-said as those runtime calls on each class's closing-brace line, line numbers unchanged so stack traces read against the source. Only the library's decorators are understood — anything else is refused, never guessed at — and the output refuses to overwrite the input, because the decorated source stays the one you edit and the one `extract` reads. The MCP server now teaches this in its instructions and in `save_script`, so a model writing a script learns the rule before hitting the SyntaxError instead of after.

## Source RPC 4.4.0

The first fruits of the first field trial: an agent that had never seen the system used it for an afternoon (`notes/session-feedback-2026-08-01.md`), and what it stumbled on became issues. This release is their fixes — one behaviour change (the broker's bind, below), everything else additive.

### The invocation handle: who is actually calling

A method that opts in with `@rpc({ injectInvocation: true })` receives a branded `RpcInvocationHandle` as its final parameter: the routed `source`, the transport-vouched `identity` when there is one, the request id, the caller's `ttl` and its idempotency key. The parameter never exists for callers — the proxy type strips it and `extract` omits it from the wire schema, diagnosing both half-declared states — and absent optional arguments cannot shift it out of its seat. The console's chat is the first consumer: a message now files under who actually called, and the field trial's spoof (`say('page-…', …)` from a CLI) lands under the CLI's own name, with `from` surviving only as display data. Explicit rather than ambient by design: no AsyncLocalStorage, so a browser page hosting services behaves exactly like Node.

### The broker binds loopback until told otherwise

**Behaviour change.** `source-rpc broker` now binds `127.0.0.1` by default, the same instinct as the console, and states on startup which of the two surprises applies: a bare broker that the next bench cannot reach, or a `--host 0.0.0.0` one the whole segment can. It bound every interface silently before; a deployment that relied on that passes `--host 0.0.0.0` now — the container image and `docker-compose/network.yml` already do, since inside a container the `-p` mapping is what decides reachability. The library's `HttpServerOptions` gains the `host` field that makes the bind expressible at all; absent, a service binds wide as it always has.

### `peersSettled()`: presence-settled ready

`ready()` means the link is up, not that presence has arrived, so asking who is there immediately found an empty network on a bus that was plainly there — and every script re-wrote the same poll-for-peers loop. `await peer.peersSettled()` on both `RpcClient` and `RpcServer` resolves when the first presence sweep has landed — the retained burst read on MQTT (ended by a quiet gap after the subscription is acknowledged, since MQTT has no "that was everyone" packet), the announced list delivered on socket.io — and returns the names known at that moment. Settled means the first picture arrived, not that every peer that will ever exist has; the bounded wait resolves rather than throws. `source-rpc peers` and `source-rpc find` now use it in place of a flat one-second sleep, so a settled network answers in tens of milliseconds.

### A description hash in presence, so caches notice a peer changed shape

The console caches what a describe taught until the peer is reselected, and the MCP holds a thirty-second describe cache — so a peer restarting under the same name with new namespaces showed its old shape, which bites an agent that describes once and acts on the answer for minutes. Presence now carries a short hash of each server's described surface: over socket.io in announcements and hub snapshots, over MQTT 5 as a user property beside the retained `online` payload old peers never look at (on 3.1.1 it does not travel). The hash covers what a cached description answers questions about and deliberately not what moves on its own — subscriber counts and topology epochs shift while the surface stands still. A change is `TransportEvent.peerShape`, emitted only on change; `peers.shapeOf(name)` reads the latest. The bargain stands: nothing describes on sight — the console and MCP drop their caches and re-describe *when next asked*, the console's open panel refreshes itself instead of waiting for a reselection, and an unchanged peer costs no extra describes. Exposing something after `ready()` re-announces, so surfaces that grow in place invalidate too.

### Event cursors: "saw nothing" can now mean "missed nothing"

A server keeps an emission counter per `(namespace, event)` — from expose time for declared events, whether or not anyone is subscribed — and each delivery is stamped with its `seq` and the server's `epoch` (the component channel's discipline applied server-wide: a sequence only orders within one incarnation). `msgrpc.eventCursor(namespace, event)` reads the counter, behind the same introspection opt-in and `authorize()` gate as `describe()`. The MCP's `watch_events` uses it to report `loss` per watched stream: gapless, missed N, **unknowable** when the server restarted between watches (a fresh incarnation cannot say what an old one dropped, and does not guess), or unable-to-say for a peer that predates cursors. Additive on the event payload and the introspection contract; peers that never ask notice nothing.

### MCP: a second door — streamable HTTP on localhost

stdio means exactly one client, and the field trial lived the consequence: a node attached to another session, and the second agent's fallback forked the scripts state the node was custodian of. `source-rpc mcp --port <n>` now serves streamable HTTP beside stdio — one POST, one JSON-RPC message, one JSON answer, no SDK — and every client shares one view of the scripts, fakes, watches and loss cursors, because there is only one of everything in the process. The bind is the console's instinct (`127.0.0.1`, `--host` to widen with the warning naming what that means), and access control was designed before the port opened: the bearer token comes from `SOURCE_RPC_MCP_TOKEN` or `--mcp-auth <file>` (never a flag value), a widened door without a token refuses to start, and a loopback door without one says plainly that any process on this machine can drive the node.

### `@source-repo/queue` 0.2.2

No behaviour change. `QueuePeer` is loosened to `Promise<unknown>` with casts at the queue's own boundary, so it stops chasing the library's per-release proxy type - which this release's `RemoteSurface` stripping would otherwise have forced on it.

### Small things

`source-rpc --version` prints the version; there was previously no way to ask. The MCP server's `serverInfo.version` now comes from the manifest too - a hardcoded copy had sat at 3.0.0 for two majors.

`mcp` and `node` print one line at start when the scripts directory's `@source-repo/rpc` major differs from the CLI's, naming both versions — the field trial ran an afternoon against a two-majors-old sandbox and nothing noticed. A statement, never a refusal: old scripts against their own pinned library are legitimate. What is installed outranks what is declared.

## Source RPC 4.3.1

No code changes in any package. The documentation moved to **[source-repo.github.io/rpc](https://source-repo.github.io/rpc/)** — the full guide with an always-visible sidebar and search, including four chapters nothing had documented before: observable components, command authority, topology, and structural context. The READMEs npm shows are now the short form — the pitch, install, one example, and the feature list with links into the site — which is this release's reason to exist.

## Source RPC 4.3.0

The final milestone of the adopted architecture: **structural context** — inherited, cached, versioned ambient data, resolved through exactly one declared topology axis. Everything is additive over 4.2.0.

### Structural context

`defineRpcContext` declares a token: a namespaced id, a schema version, exactly one axis (`physical` or `logical` — there is no logical-then-physical search, by design), `nearest` or `collect` resolution, a stale policy, a capture policy, and an exposure. A host provides at most one value per token per topology node through `server.provideContext()`, owned by a handle nothing remote can reach; a restarted provider is a new provider epoch. `server.contextOf(node, token)` returns a live store — the same `getSnapshot()`/`subscribe()` shape the component channel proved against React — and `requireContext()` is the policy gate that fails closed.

Resolution crosses hosts the way the topology does: the physical chain root to root, the logical chain through remote owners, one register-then-snapshot subscription per upstream host with full frames only, token sets widened by re-subscribing, and reconnects replayed with retry. Twenty tokens inherited over one host cost one subscription. The public lifecycle is `initializing | live | stale | missing | invalid | closed` with a `transitionReason`: a lost providing host is `stale` with the last value kept and its age on it; an owner reassignment is an **atomic remount** — a new mount epoch, never a mixture, the old world only as `previous`, which `require()` never returns; and a cross-host owner ring is caught before the resolver would subscribe its way around it forever, reported `invalid` with the ring's path named.

The `$context` protocol is served at the dispatch level, and its authorization is the design: every `read` and `subscribe` passes `authorize()` with the node and every token id visible, there is no enumeration surface, and a value whose token declares `exposure: 'local'` is filtered from remote answers *silently* — a refusal would confirm the secret exists. `captureRpcContext` packages what a node currently sees for a payload: explicit-capture tokens only, local values never, the aggregate bounded before anything accepts it.

### `@source-repo/queue` 0.2.0

The `latest` queued-context mode is real: a consumer resolves the named tokens against the source host's `$context` when execution starts — the task runs under the world as it is, not as it was — and hands them to the handler as `context.resolvedContext`. An unresolvable `latest` fails the delivery through the ordinary retry-then-dead-letter path with the reason on the dead letter, never running the handler context-blind. The wire type gains an optional `node` on the `latest` variant (default `$host`). Requires a 4.3.0 server for the `$context` surface; against older servers, `latest` tasks dead-letter honestly.

## Source RPC 4.2.0

The release that ships the adopted architecture: observable components, command authority, the federated topology core, capability discovery — and the first tool node, `@source-repo/queue`, published for the first time. Everything is additive over 4.0.0 with one event-payload change noted below.

### Observable components

A long-lived instance can extend `RpcComponent<Props, State>`: cached `props` and `state` snapshots ride epoch/revision ordering with a race-free targeted snapshot on subscribe, and `client.component()` (and `server.component()` — a page that hosts a service observes over the same link) resolves to a typed proxy whose reads are synchronous from a local cache. The store beneath it — `getSnapshot()`/`subscribe()` — is exactly what React's `useSyncExternalStore` consumes, with a per-channel status of `initializing | live | stale | closed`: a dropped link marks the picture stale and keeps it readable with its age on it, and a reconnect repairs it with one snapshot. Component shapes travel in the schema (`extract` resolves them through the base-type chain), the compatibility checker treats them as output, and `describe()` reports structure and a live observer count, never the values. `validateComponentSnapshots` checks each commit against the contract before it becomes current.

### Command authority and the owner fence

`$acquire`/`$release` bring the plant's arbitration concept to any component — granted, visible in every snapshot as `authority`, and always expiring, with `authorityChanged` saying why. Only methods declaring `requiresAuthority` are ever gated, which is the safety rule stated positively: an E-stop never declares it and is therefore provably never behind a held lease. Refusals are `NotInControl`, naming the holder, checked at the door and again after any queue wait. Above it sits the topology fence: `$with({ ownerEpoch })` carries the caller's observed owner generation, and a target whose durable record moved answers `OwnershipChanged` — certainly not run, never blindly retried.

### The topology core, federated

Every host now answers for its own components' `parent` (physical) and `owner` (logical) edges: records with per-link epochs under compare-and-set, a synthetic durable `$host` root carrying the deployment's declared `place`, and the one permitted cross-host physical edge, root to root. Local physical invariants are refused at commit; owner cycles — which no host can police alone — are detected at derivation as invalid topology with the path named. Epochs are durable where the store is (`JsonFileTopologyStore` writes whole and renames; restart never rotates an epoch), and the volatile default says so through the capabilities record `describe()` now serves. Remote mutation is opt-in (`topology.allowRemoteMutation`) and still passes `authorize()`; ids refuse control characters at the boundary. Labels are free Unicode — exactly what the drawings say — and display only.

### Capability discovery

`class Compiler implements UiBuilder` becomes `@scope/contracts/UiBuilder` in the extracted schema — qualified by the package that declares the interface, with the `extends` closure flattened in, so a search for the parent finds the child's implementor as a flat string match. An interface from the class's own package is a loud diagnostic, never a bare name. `describe()` serves capabilities from the schema — a bundled class named `m` still advertises correctly — and `source-rpc find <capability>` plus the MCP `find_capability` tool answer with who implements what. A capability nobody implements is an empty list, not an error, and the MCP's discovery cache validates `call_method` arguments locally: a wrong shape fails `InvalidParams` before spending a network hop.

### The console

The peer list is a tree over what descriptions have taught — hosts attached root-to-root nest, with the declared place beside each name — and the selected peer shows its structure panel with both axes, labels beside ids, and cross-peer owners as links. Observable components render live: status badge, values with per-value quality (`forced` deliberately distinct from `stale`), last-known data dimmed but readable while stale. Write dialogs grade by the contract: a `non-repeatable-command` arms and confirms in the console's own chrome, and the repeat button exists only where the contract says repeating is free.

### `@source-repo/queue` 0.1.0 — the first tool node

Published for the first time: a lease-based work queue over Source RPC — at-least-once stated plainly, acquire-ID replay for uncertain outcomes, lease tokens fencing stale completions, reject-new-only capacity with `QueueFullError`, retries into dead letters with a paged, authorized admin surface, and metrics riding an observable component. One conformance suite over in-process, socket.io and MQTT 5. Its own package with its own version, deliberately outside the versions-together rule, and the release workflow now publishes it whenever its version is new.

### Changed

- **`resubscribeFailed` carries identities, not a count.** The event's payload is now `FailedResubscription[]` — peer, namespace, event and the error for each subscription a reconnect could not restore — because a shadow cannot mark the right values stale from a number. Anything listening to this event reads the array instead.

### Also

- Per-call timeouts: `$with({ timeoutMs })`, with `0` honestly meaning no timer and no ttl — the zero-timeout next-tick bug is fixed.
- A client's event subscriptions are reference-counted, so one handler leaving no longer unsubscribes the rest; peer lifecycle events (`peerOnline`, `peerGone`, `peerDisplaced`) forward through `RpcClient`.
- socket.io clients retry after `io server disconnect`, so a restarted server's peers come back without help.
- `RpcServer.close()` awaits its own construction, closing a race that could leak a listener.
- Graded execution defaults: declared commands serialise per instance, queries run parallel, with a bounded mailbox answering `Busy` and setpoint-shaped commands able to `conflate` into `Superseded`.
- One exported `SCHEMA_VERSION` and a written compatibility policy (`docs/schema-compatibility.md`): what is additive, what forces a bump, what a consumer may assume.

## Source RPC 4.0.0

**`proxy()` returns the remote instance.** It used to return a record — `{ name, target?, remote }` — so every call read `proxy.remote!.method()`. The wrapper carried two fields nothing in the library, the CLI or the console ever read, and a `remote` that was typed optional but could not be absent. What that cost was a word in front of every method and an assertion at every one of 142 call sites, to describe a record halfway through being assembled rather than the one handed back.

```typescript
const calculator = await client.proxy<Calculator>('calculator')
await calculator.square(3)          // was calculator.remote!.square(3)
```

Every call site changes, which is the whole of the break. `$with` is unaffected — `pump.$with({ idempotencyKey }).dispense()` reads as it did, one word shorter.

### `then` is now a reserved name

A remote class could never expose `$with`. It can no longer expose `then` either, and the reason is worth stating because it is inherent rather than a shortcut: `proxy()` is async, so `await` probes what it returns for `then`. The proxy's trap answers every property with a caller for a remote method of that name, so it answered one for `then`, the runtime concluded it had a thenable and adopted it, and the await waited forever for a call nothing would ever answer.

The trap returns `undefined` for `then`. The old wrapper hid this by accident, being a plain object whose `.remote` was only touched after the await had settled — 214 tests hung the moment it was removed, every one of them presenting as a network timeout rather than as a language rule. There is a test on it now, because the next person to touch the trap would reintroduce a hang that does not look like a bug in the trap.

### Migrating

Delete `.remote` from every call. `.remote!.` and `.remote?.` become `.`; a bare `.remote` used as a value goes entirely. Nothing read `name` or `target`, but if you did, they are no longer there — `proxy()` was given both, so the caller already knows them.

## Source RPC 3.4.3

**Nothing in either package has changed.** Both exclude tests from what they publish, and the two commits since 3.4.2 are a test and two workflow files, so the tarballs are the same code 3.4.2 shipped. The release is worth making for the image, which floats on `node:24-alpine` and runs `apk upgrade`, so rebuilding is how it picks up whatever has been fixed in the base since — the case the scheduled scan exists to notice.

### Also

- **A test waited on the wrong party.** The discovery test that calls between two servers waited for the hub to hold a socket for the callee before calling it. That says the callee has connected; it says nothing about whether the announcement has reached the caller, which is what decides whether the call can be routed — and the second call, made the other way, waited for nothing at all. Fast enough to pass everywhere until a loaded Windows runner lost the race and failed with `no route to …`, which is the switch refusing rather than silently dropping. Each caller now waits on its own registry.
- **The workflow actions are off the deprecated Node 20 runtime.** `checkout` and `setup-node` to v7; `build-push-action` to v7 and `login`, `setup-buildx` and `setup-qemu` to v4. Every one of those majors is the same change underneath — Node 24 as the default runtime, and a move to ESM. `trivy-action` stays pinned where it was.

## Source RPC 3.4.2

### Fixed

- **A chat message arriving at the console changed nothing on screen.** The call succeeded and the page answered `delivered` — `ChatService` ran and the message went into state — but the log is keyed by the peer selected in the sidebar and chat is one tab of five, so it was only ever visible to someone who already had that exact peer selected with that exact tab open. Traffic and problems have carried a count since they were written; chat had none, which left it the one pane whose arrivals passed in silence, and the only one of the three another peer can provoke deliberately. There is now a count on the chat tab for the total and a count beside the peer that sent it, since the tab says something is waiting and only the sidebar can say whose. Both clear when you look at that peer's chat, including when the message lands while it is already open.

## Source RPC 3.4.1

Five faults, all of them found from one command line that should not have started: `source-rpc mcp --hub http://localhost:7843 --scripts --contracts`.

### Fixed

- **A flag would take the next flag as its value.** That command is two flags with no directory between them, and the word after a flag was read unchecked — so `--scripts` took the literal string `--contracts`, and `--contracts`, by then the last word on the line, found nothing after it and fell back to its default, which switched it off. The server started, offered script tools aimed at a directory named `--contracts`, offered no contract tools at all, and said nothing about either. Every value-taking flag was affected: `--sign --scripts ./x` took `"--scripts"` as the key file just as willingly. Nothing any of them takes — a directory, a url, a peer name, a key file, a number — begins with `--`, so a value that does is a missing one, and the command is now refused with the flag named. The refusal is a sentence rather than a stack trace: these are read before any promise exists, so the entry point needed its own catch.
- **`save_contract` could not create its own directory.** It wrote straight to the path, so `--contracts ./contracts` worked only if you had already made the directory by hand — a tool advertised at startup and then failing `ENOENT` on the first thing asked of it, which reads as a broken server rather than as a directory nobody created. `saveScript` has made the scripts directory since it was written; this now matches it.
- **`list_contracts` reported a directory that did not exist yet as an error.** `list_scripts` answers with an empty list from the same state, for the reason written above it: not yet created is not an error, it is an empty directory. A directory that is there and cannot be read still is one.
- **A failure repeated its own code.** `node:fs` errors already open with theirs, so prefixing produced `ENOENT: ENOENT: no such file or directory` — the same thing appearing to have gone wrong twice. An RPC error carries its code apart from its message, which is the case the prefix exists for, so the prefix is now added only when it is not already there.
- **`list_scripts` says which directory it read.** An empty list from the directory you meant and an empty list from one you did not are the same two characters, and the first fault above produces exactly the second. The tool returns `{ directory, scripts }` rather than a bare array, or `{ node, scripts }` when aimed at another machine, whose directory is a path this server cannot see. The `scripting` RPC contract behind it is unchanged.

## Source RPC 3.4.0

### `source-rpc node`

A machine that can be scripted from elsewhere, and does nothing else. `mcp --scripts --scriptable-by` already offered this, and on the machine a model is attached to that is the right shape — on a PLC in the corner of a test hall it is not, since there is no model and no use for a stdio protocol sitting idle beside the part that matters.

```
source-rpc node --scripts ./scripts --scriptable-by bench --broker mqtt://bus:1883 --sign plc.json
```

Both flags are required, unlike on `mcp` which can sensibly take one without the other. A node with no directory has nothing to offer and one that names nobody offers it to nobody; either way it takes a peer name and does nothing, which reads as though it works. It also says at startup when it is on a broker without `--sign`, because nothing can prove who a caller is there and every scripting call will be refused.

### Fixed

- **A scripting namespace could be exposed a moment too late.** Both this command and the `mcp` wiring exposed the service after `ready()`. A resumed MQTT session is handed its queued messages the instant it connects, so a request waiting there reached a peer that had not exposed the namespace yet and was answered `ClassNotFound` by a peer that serves it perfectly well a second later — the hazard the frame spec lists under known limits. `connectNetwork` takes an `expose` callback that runs before `ready()`, so both are fixed at one seam.

## Source RPC 3.3.0

**Node 22 or later.** The floor was `>=18.17`, which claimed two majors that are both end of life — 18 since April 2025, 20 since April 2026 — and that CI had never once run. A supported range nobody tests is a guess with a version number on it.

22 rather than 24: it is what CI runs, what the Windows job runs, and what a current Windows IoT box has. Nothing else changed, so a peer already on 22 needs nothing from this release.

A major by the letter of semver, since a consumer pinning `engine-strict` on an older Node gets a hard failure rather than a warning. Released as a minor because the runtimes being dropped are unmaintained and were never verified against, which makes this a correction to a claim rather than a withdrawal of support.

## Source RPC 3.2.0

### Scripting a node from another node

`--scripts` could only reach the machine it was running on. `--scriptable-by <peer>` offers the same capability as an ordinary RPC namespace, so a bench drives a hall of nodes instead of a row of remote desktops. Every MCP script tool gains a `node` argument, absent meaning this one.

- **A service, not a server subclass** — `ScriptingService` composes onto whatever a node already is, the way `BusService` and `ConsoleService` do. Everything built for calling a peer then works on it: argument checking from the contract, `describe()`, the verbs, and the command semantics, which are declared and now committed as a contract that `check` polices.
- **The grant is made on the node being scripted.** Name nobody, the default, and the namespace is not published at all — `--scripts` alone is a machine that can script itself and cannot be scripted. A call arriving over RPC is refused unless the caller is authenticated *and* named; local use is the object held directly, with no RPC involved.
- **Through a bus it has to be signed.** Identity is per connection and does not survive a relay, so a hall of nodes on one socket.io bus cannot use this and no flag makes it — the information is not there. A signature is on the frame, so MQTT with `--sign` at both ends is the arrangement that works. Both working shapes have tests.

### Fixed

- **A Python simulator whose interpreter stopped reading took the whole fake down.** Writing to a dead child's stdin raises EPIPE, and an unhandled `'error'` on a stream is an uncaught exception. Failed calls now, rather than a failed process.
- **`npm` could not be run on Windows.** It was reached through `npm.cmd`, which Node refuses to spawn without a shell since the fix for CVE-2024-27980 — and a shell would have turned the `>`, `<`, `|` and `^` that are legal in a version range into a command line. It goes through `npm-cli.js` and the current Node instead.
- **`python3` is not the interpreter name on Windows.** Candidates are per platform now, `py` first there, and probed rather than assumed, since Windows ships a `python` that is a Store stub and fails like a missing one.
- `--scripts` announces itself on startup the way `--allow-exec` does. It is the larger grant of the two and was the quieter one.

### Also

- CI runs build, typecheck and the suite on `windows-latest`. No broker there — service containers are Linux-only — so the MQTT tests skip, and why that is an acceptable gap is written in the workflow.
- The suite passes against Mosquitto as well as EMQX, so what it tests is MQTT 5 rather than one vendor's reading of it.

## Source RPC 3.1.0

Additive throughout: new modules, optional fields on existing interfaces, new flags. Nothing that existed in 3.0.0 changes behaviour.

### Simulating something that reacts

A fake built from a contract answers the same value every time, which is enough for a screen that needs something to draw and not enough for the behaviour an HMI is usually wrong about — a pump that ramps toward the setpoint it was last given, a batch that will not start twice.

- **`state` and `handlers` on a fake's script.** A method gets a JavaScript body, called with the caller's arguments over shared mutable state. `python` runs a program instead, started once and keeping state in its own variables, with `@rpc('namespace.method')` supplied by a shim. A handler wins over `returns` for the same method, so one script can carry both.
- Fakes now pass call arguments to their methods, which were previously discarded — the change that makes a handler worth having.
- **`--allow-exec` gates both**, and is off by default. A script asking for them without the flag is refused at startup rather than served with its handlers quietly dropped, because that failure looks like it worked. The JavaScript context has no `require`, `process` or filesystem and a handler that will not finish is cut off; `node:vm` is not a security mechanism and Python has no confinement at all, so the flag is the boundary rather than the runtime.

### Peers kept as scripts

- **`--scripts <dir>` on `mcp`** — a directory of peers written as programs, which a model can add to, change, start, stop and read the output of. Unlike a fake, a script is not bound to one contract and can call as well as answer.
- **TypeScript by default**, run directly by Node with no build step, so a script can `import type` a class and get the same typed proxy the rest of the codebase does. The `--experimental-strip-types` flag is passed only on the versions that need it, and a Node older than 22.6 is told to use `.mjs` rather than failing obscurely.
- Each script is its own process, handed the network as `SOURCE_RPC_HUB`, `SOURCE_RPC_BROKER`, `SOURCE_RPC_PREFIX` and `SOURCE_RPC_TOKEN` so it reads its broker url rather than carrying one. Stopped when the server exits rather than orphaned holding peer names.
- **`list_packages`, `add_package`, `remove_package`** give the directory its own dependencies, in its own `package.json` and `node_modules`. Installs pass `--ignore-scripts` unless asked otherwise, because a `postinstall` hook is unreviewed code from the registry. Not a new grant — `--scripts` already permits arbitrary processes — but a declared one.
- That manifest also carries `"type": "module"`, which a `.ts` script needs: Node decides whether `import` is legal from the nearest manifest, and inside a CommonJS project it would otherwise warn on every run and put the warning in the script's own output.

### Two images

- **`ghcr.io/source-repo/rpc-cli:dev`** carries `npm` and `python3`, which `--scripts` and Python handlers need in order to work at all. The default image drops npm entirely: nothing at runtime shells out to it, and keeping it means inheriting every advisory against its bundled `tar`, `undici` and `brace-expansion`. The runtime image has no fixable critical or high vulnerabilities; the development one has five, which is the trade the split exists to make.
- On Node 24 (active LTS) with `apk upgrade`, and `latest` still points at the runtime image.
- The release scans what it is about to push and **blocks on anything fixable**; a weekly workflow scans what is already published, since an image is frozen at the day it was built and the advisory usually arrives later.

### Documentation

- Three task-shaped guides that cross both packages: [deploying a network](docs/deploying-a-network.md), [writing a simulator](docs/writing-a-simulator.md), and [the security model](docs/security-model.md). The package READMEs stay the complete reference, since they are also the npm pages.
- The front page now says what this is for and, early, who should use [tRPC](https://trpc.io) instead. Both package READMEs were reordered — the browser console was the last section of the CLI README and a 42-row flag table was the third screen.

### Corrections to the documentation

Found by reading the source rather than the prose:

- The introspection namespace is `msgrpc`, not `source-rpc`; the README said both.
- A client's default name is three readable words, not a UUID — and the reasoning was inverted, since the readable name exists *because* a UUID says nothing in a log.
- Multi-hop routing is covered by a test at two hops, not three.
- An undeliverable frame is now *answered* with a `TransportError` down the link it arrived on, not merely reported as `unroutable`.
- `MqttTransportOptions.tap` was missing from the options table.
- **Handler-chosen error codes** and **`--idempotency-key`** were both shipped and tested but undocumented.

## Source RPC 3.0.0

**Renamed.** `msgrpc` is now Source RPC: `@source-repo/rpc` → `@source-repo/rpc`, `@source-repo/rpc-cli` → `@source-repo/rpc-cli`, and the command `msgrpc` → `source-rpc`. `msg` was always meant as *message*, which is what this is about, but it is a short word full of other people's abbreviations and it reads as a puzzle to anyone meeting it for the first time.

**The protocol did not change.** Topic prefixes are still `msgrpc/v1` and `msgrpc/v2`, introspection is still the `msgrpc` namespace, MQTT 5 user properties still carry the `mr-` prefix, and the 3.1.1 header is unchanged. Those are on the wire: renaming them would strand every deployed peer and buy nothing. The default contract filename stays `msgrpc.types.json` for the same reason - it is what existing projects have on disk, and a rename would break their `--against` for tidiness alone.

Both packages go to 3.0.0 together, since a renamed package is a breaking change however compatible the code is.

### Industrial command semantics

Most RPC libraries make it easy to call a function. Rather fewer distinguish *the call failed* from *I lost the answer to a command that may well have run*, and on a plant that is the distinction that decides whether an operator sends a second start.

- **A method can say what calling it does to the world**: `@rpc({ semantics: 'query' })`, `'idempotent-command'` or `'non-repeatable-command'`. It is part of the contract rather than a comment - `extract` reads it off the decorator, `describe()` reports it, and `check` calls it a breaking change when a method becomes *more* dangerous to repeat than the version a caller was built against. Every type still lines up in that case, which is why nothing else catches it. Undeclared stays undeclared: the library will not guess that a method is safe to repeat.
- **`UnknownOutcome`**, a new error code, for a request that was sent and whose fate is not known. `TransportError` now means the request never left, so the command certainly did not run. Both used to be reported the same way, which told a caller that a command had failed when what the library knew was that it had lost track of it.
- **A durable idempotency hook.** `RpcIdempotencyStore` given to `RpcServer` records what a non-repeatable command did, so a redelivery after the process died is answered from the record rather than executed again - the one failure an in-memory duplicate cache cannot cover, since the memory is what died. No database ships with it; the seam is the deliverable. The outcome is recorded *before* the answer goes out, and a store that cannot be reached refuses the command rather than running it - failing open would produce exactly the double execution it prevents.
  - Consulted only for non-repeatable commands, so reads pay nothing for it.
  - `proxy.$with({ idempotencyKey })` lets a caller say that two attempts are one command, which is the case the request id cannot cover: an operator pressing the button again is a new request but the same intent. Carried as `mr-idem` on MQTT 5 and signed like everything else acted on.
- **An execution policy per exposed instance.** `@rpcNamespace('cell', { execution: 'serial' })` runs one call at a time; a key function runs one at a time per key, which is how a server fronting many devices orders each device without serialising itself behind the slowest. Calls into one mutable instance could otherwise interleave and leave a machine in a state neither caller asked for. `parallel` stays the default because a serial instance that calls back into itself deadlocks, and changing the default would break re-entrant designs silently and only under load.
  - The deadline is read *after* waiting in that queue, so a command that queued until its caller gave up is refused rather than run late.
- Stated plainly in the README, because it is true and usually unwritten: **delivery and execution are at least once unless the method is guarded by a durable idempotency store.**

Deliberately not built, with reasons in the README: cancellation, `online-only` delivery, a per-call invocation context for handlers, and global admission limits.

### A bus you can deploy

- **Well-known ports.** `defaultWebSocketPort` is **7843** and `defaultWebPort` is **7844**, where anything serving a browser listens. `source-rpc broker` and `source-rpc console` default to them, replacing 3000 for the library default, 8080 for the broker and 7300 for the console — one number to remember instead of three. Deliberately clear of the 80xx range: 8080, 8081 and 8085 are taken on any machine that has been worked on for a while, and a default that collides on the laptop is a default nobody keeps. A single process still needs only one port, since a page and its RPC share a listener; the second number is for running a bus and a console on one host.
- **`source-rpc broker --auth <file>`**, and `authenticate` on `startBroker`. The library has had an `authenticate` hook since 2.0, but nothing on the broker forwarded it and no flag reached it — so the command printed *"use authenticate to gate that"*, which was advice its own user could not take. A bus can now be put on a network that is not already trusted.
  - **`createTokenAuthenticator`** packages the common case: a map from bearer token to the peer it admits. One token per peer, deliberately, with no single-secret form — a token that maps to a name is evidence of who is calling, and a shared one proves only that the caller is inside the fence. Blank tokens, grants with no name and an empty map throw rather than construct.
  - `--auth` names a path, never a secret; `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS` say the same two things for a container. The same flag gives every other command the credentials to join a hub that authenticates, which `hubCredentials` previously had no way to receive.
- **A container.** `packages/cli/Dockerfile` builds an image whose entrypoint is the whole CLI, so one image is a bus, a console, an MCP server or a recorder depending on the command. `docker-compose/network.yml` runs an MQTT broker, a bus and a console together.
- **The console can be published under a path by a reverse proxy.** Its assets were already relative, but two runtime paths were not: it fetched `/console.json` and connected to `window.location.origin`, both of which leave the mount point behind and land on whatever else is published at the root. The page now derives both from `document.baseURI`, so no configuration is needed as long as the proxy strips the prefix and the published path ends in a slash.
  - **`--base-path`** covers the proxy that forwards the prefix instead. The page, its assets, `console.json` and socket.io all move to it, `/` stops answering — the rest of that origin belongs to whatever is published beside the console — and the mount point without its trailing slash redirects to the one with it, which is the only place relative paths can be put right.

### Security

- **An authenticating socket.io transport registered peer names it had just rejected.** A frame's source is recorded in the shared peer registry as the header is parsed, which is right for MQTT — the broker is the authority there and there is no connection anyone could check — but on a transport with an authenticator it happened before the identity check, and so applied to frames that were then dropped. Sending one rejected frame was enough to have a bus advertise a peer that did not exist, and to point lookups for a real peer's name at a transport where nothing answers to it. Delivery was never affected — that reads a map only the post-check path writes — so the effect was disruption rather than interception. Registration now happens where the trust decision is made. Nothing changes without an authenticator, where a name was never evidence to begin with.
- **A signed MQTT 5 frame's content type was not covered by its signature**, and altering it could change what the frame said while the signature stayed valid. The reasoning written into the code was that content type only says how to read bytes that are themselves signed, so changing it could make a payload fail to parse but never change what was authorised. That is wrong, and the counterexample is one byte long: `0x31` is the JSON text `"1"`, the number 1, and is also a MsgPack positive fixint, the number 49. Both parse. Both verified. Flipping one unsigned property therefore turned a signed `write(1)` into a signed `write(49)`.
  - The **error code** and the **declared contract version** were uncovered for the same reason and are now signed too. The code is what a caller acts on when a call fails, and the contract version decides whether the call is accepted at all - neither is merely transported.
  - **Signed frame version 2.** A frame signed under version 1 no longer verifies, which is deliberate: accepting either would let a sender choose the weaker form. The gate is on the *signing* path only, so **plain MQTT 5 peers written against version 1 keep working** - an unsigned frame's version says nothing about security, and the interop that makes this a protocol rather than a library is worth keeping. A peer that signs must be upgraded.
  - **An unknown content type is refused** rather than falling back to MsgPack. Guessing how to read somebody else's bytes decides what the values mean.
  - Found in the OpenAI review of 2.3.0, whose reasoning was right in every particular.
- **TLS certificate verification was off by default.** The socket.io client transport set `rejectUnauthorized: false` before applying the caller's own options, so every Node peer accepted any certificate at all - which on this library's traffic means accepting an impersonated server for industrial commands. Node's default is now left alone. Where a development server really does have a self-signed certificate there is `allowInsecureTls`, on the client, the transport and the CLI's `--insecure-tls`, which says what it does, warns when it is used on a TLS link, and is off. A plant with its own certificate authority should pass the CA instead, which keeps verification on rather than switching it off.
- **`{ https: true }` opened a server with no certificate.** It called `createHttpsServer()` with nothing in it: the port listened, and every handshake then failed. Replaced by `tls: { cert, key }`
  - the material is what asks for HTTPS, because there is no useful HTTPS server without it. The old spelling is refused with a message pointing at the new one, in the types and at runtime, rather than silently falling back to plain HTTP.
- **The incoming MQTT 5 Response Topic is now honoured.** A request's reply used to go to a topic derived from `mr-src` rather than to the Response Topic the packet named. The interop tests passed only because the third-party client happened to choose the same topic msgrpc would have derived; a standards-compliant caller picking any other valid topic was never answered where it was waiting. The topic is validated (no wildcards, no control characters, not under `$`) and must sit under the transport's prefix, which `allowResponseTopic` overrides - a caller now chooses a topic somebody else publishes to, so it needs a boundary. It is signed for the same reason. A request naming a topic outside the rule is refused rather than quietly answered elsewhere.
- **A request could execute after its caller had given up.** The call timeout defaulted to 10 seconds and the MQTT request expiry to 30, set independently, so a queued request could be delivered and run twenty seconds after the operator had been told the call failed. For a read that is wasted work; for `start pump` or `reset fault` it is a machine moving when nobody expects it.
  - A request now carries `mr-ttl`, the milliseconds its caller will still wait, and **the broker's expiry is derived from it** rather than set independently.
  - The server **checks the budget immediately before invoking the method** and answers `Timeout` instead of running it. The broker's expiry only covers the queue at the broker; a request that arrived promptly and then waited on something slow inside the serving process needs the check.
  - **A duration, not an absolute deadline** - which is where this departs from the review's suggestion. An absolute deadline is only as good as the agreement between two clocks, and one of the peers here is a browser page whose clock belongs to whoever is sitting at it: a wrong clock would refuse every command that page sent, which is a worse failure than the one being fixed. The receiver counts from its own arrival stamp, and on MQTT 5 the broker's decremented expiry accounts for the queueing - so nobody's clock is ever compared to anybody else's. `mr-ttl` is signed, and the expiry may only narrow it.
  - `refuseExpiredCalls` on the server handler turns the refusal off for anyone who wants the old behaviour.

### Fixed

- **Piping a verb into `head` printed a stack trace.** Closing stdout early makes Node emit an unhandled `error` event, so `source-rpc describe plantServer | head -4` ended in `EPIPE` and a stack trace instead of simply stopping. Handled at the entry point, since every verb writes to stdout and half the documented examples are pipelines. Found by running one of those examples.

### Everything below shipped as msgrpc 2.4.0 and msgrpc-cli 2.5.0

- **The traffic tap.** `msgrpc broker` now exposes a `bus` namespace — `tap(filter?)`, `untap`, `taps()` — and emits a `frame` event carrying what it is relaying. A console only ever sees its own calls and the events it subscribed to, which on a real network is a small fraction of what is happening; the broker sees everything, because it is the thing forwarding it.
  - **Turned on by a call, not by a flag.** A plant bus that has to be restarted before it can be watched will not be watched: the run worth looking at is the one already going wrong.
  - **It knows what a frame is**, which is what a topic browser pointed at the same wire cannot do. A call and its reply share a correlation id, so the reply is reported with the method it answers and the time it took — neither of which is in the reply itself.
  - Filters narrow by peer (either direction — "mirror that device"), namespace, and kind. Several taps run at once with different filters, and each frame names the taps it matched.
  - **Payloads are off by default.** The metadata is what a debugging session usually needs, and a plant bus carries values nobody meant to hand to whoever happened to be tapping. They are carried only if one of the taps that matched asked for them.
  - Taps expire on their own (300 s by default, 3600 s at most). A console that closes without untapping would otherwise leave the broker building and emitting frames for a subscriber that is not there. The calls awaiting replies are dropped with the last tap, so nothing accumulates between debugging sessions.
  - Traffic addressed *to* the broker is not tapped, only what it relays, so reading the tap back does not feed itself.
- **The broker describes itself.** It used to expose nothing at all, so a peer addressing it got `ClassNotFound` — true, and the plainest possible statement that this is a switchboard rather than a service. It was also indistinguishable from a device whose server was started without `exposeIntrospection`, which is what a broker in a peer list actually looked like. It now ships a contract and answers `describe`, so `msgrpc describe plantBus` says `bus@1` instead of an error that reads like a fault.
- **The tap works on MQTT too**, where there is no broker of ours to hook: the observation happens at the subscription instead — `<prefix>/rpc/+` under 3.1.1, each of `<prefix>/{req,rsp,evt}/+` under MQTT 5 — and a console started with `--broker` exposes the same `bus` and watches for itself. `MqttTransport` takes a `tap` option for it, and reports what it decodes rather than delivering it: a tap answers no calls and runs no methods.
  - **It gets its own broker connection**, opened when the first tap starts and closed after the last ends. A peer subscribed to both its own topic and the wildcard covering it has overlapping subscriptions, and a broker may deliver a matching message once per subscription — which for a request means the method runs twice. A separate instance is a separate client id and session, so the two can never overlap; there is a test asserting the device ran the method exactly once per call while tapped. It also means an idle console costs a plant broker nothing.
  - Frames are reported without checking signatures. A tap holds no key for a conversation it is not part of, and what is on the wire is what it exists to show.
- **`console.tap`, `untap` and `taps`**, so the page asks the console rather than hunting for a broker from the browser. The console turns on whatever it can reach — a broker's `bus` over socket.io, its own subscription over MQTT, both when it holds both links — and says which in `sources`. Frames arrive on one `frame` event either way.
  - Peers are described **in parallel** when looking for a bus. One peer that is registered but no longer answering — a page whose tab was closed — takes the whole call timeout to fail, and in sequence that was one timeout per stale peer before the tap started at all.
  - The console's record of a tap is given the same life as the tap it stands for, so a page that reloads without untapping takes its entry with it instead of leaving one for the life of the console.
- **A Traffic tab in the console**, next to Events and Chat: off until asked, with the filter set up before it starts, then one row per frame colour-coded by kind, a search box and a pause. It stays tapping while another tab is showing — unmounting it would have stopped the watching exactly while you looked away — and the count on the tab label is what arrived meanwhile.
- **`msgrpc bench`** calls one method over and over and reports what it cost. A device is fine at one call a second; what it does at twenty is the question, and answering it is ordinarily done with a script that is always the same script. **Percentiles rather than an average**, because an average hides exactly the calls worth knowing about - a device answering in 2 ms with one reply in four seconds averages out to something that looks healthy. Failures are counted by code, since a device refusing arguments and a device that stopped answering are different findings with the same shape, and any failure exits 1 because errors under load are the finding.
  - `--concurrency` bounds what may be outstanding; past that calls are **not sent and counted as fallen behind**. Piling them onto a device that is already behind measures the queue rather than the device, and would report healthy latencies for a device that is drowning.
- **A Presence tab.** A peer that flaps is one of the commonest faults on a plant and the hardest to catch in the act: the console showed it as a dot that changed colour and then forgot, so a device dropping every thirty seconds looked exactly like one that was simply up. The console keeps the arrivals and departures and hands them over when a page connects, so opening it after the trouble still shows it, and a peer that has arrived three times or more in the window is called out by name.
- **Peers say what they are** - broker, console, page, device, or served without a contract. Learned from descriptions the console was already making when someone selects a peer or when it goes looking for a bus to tap, so the labels fill in as the network is used and an idle console costs what it always did. The worry that this needed a describe per peer on sight is what had kept it out; it does not.
- **Argument presets**, per method and kept in the browser. Keyed by namespace and method rather than by peer, so a set saved against one cell is offered on the next - the reason to save a setpoint sequence usually being that five more cabinets are coming. Named by what they hold, so there is no dialog to name them in.
- **Console polish.** The events pane gained the filter, pause and export the traffic tab already had - pausing stops the buffer filling rather than only the list rendering, and export writes the jsonl `msgrpc record` writes and `jq` reads. **Watch all** takes every event in a namespace in one click, which is the usual first move on an unfamiliar peer. Each method keeps its timings, with **×20** to call it repeatedly and report `20 calls · p50 1 ms · last 1 ms` - `bench` in miniature, for when the question is smaller than a benchmark. **copy as CLI** puts the equivalent `msgrpc call …` on the clipboard with the network flags this console was started with, because a call worth making in a browser is usually one worth putting in a script and retyping `--hub http://…` from memory is where that stops happening.
- **The MCP server can stand a peer up, and reaches the rest of this release.** Asking a model to test a device runs into the device having to exist first, and the steps that closed that gap - write a JSON file somewhere, open a second terminal, start the CLI - are exactly the ones a conversation cannot take. `start_fake` takes a contract **inline** and puts a peer on the network that answers from it; `stop_fake` and `list_fakes` manage them. They run inside the MCP server rather than as spawned processes, so they stop when it does and none are left behind.
  - **A fake will not take a name a peer already answers to.** Standing one up under a live device's name would displace it, and calls meant for the plant would reach a stand-in that agrees with everything. Refused, not resolved.
  - `check_peer` and `diff_peers` are the conformance verbs; `watch_traffic` returns what other peers said to each other over a few seconds, and `watch_events` what one peer emitted, dropping the subscription again so looking leaves nothing behind. Both are bounded, since a model asking for an hour would get one and the conversation would look hung.
  - `save_contract` and `list_contracts` appear **only when `--contracts <dir>` names somewhere to write**. A server that cannot write files should not advertise tools claiming it can. Contracts are written as `<name>.types.json` in that directory and nowhere else - a name that would climb out of it is refused rather than resolved - and the file is the one `msgrpc serve --contract` and `msgrpc check --peer --against` already read, so the loop closes.
- **`msgrpc check --peer`** points the build-time check at a device. `check` against source catches a change before it ships; what it could not answer is the question asked on site - the contract says this device offers `writeSetpoint(value, mode?)`, is that what the box on the wall is running? The peer describes itself and the answer runs through **the same comparison** the server applies to a caller declaring an older version, so a device behind its own contract is reported in exactly the words a stale caller would have got, and CI and the site agree about what "breaking" means.
  - A namespace the peer does not serve at all is reported apart from one that changed, and **a peer running without a schema is reported as unchecked rather than as passing**. It describes its method names and nothing else, and calling that "no breaking changes" would be the most useful-sounding lie available.
- **`msgrpc diff <peerA> <peerB>`** for the question that follows: why does cell 3 behave differently from cell 2? Contract versions, methods one has and the other does not, signatures that changed and events one no longer emits, side by side. Signatures are compared as they read rather than structurally, because the answer is read by a person standing in front of two cabinets. Exits 1 on any difference, so a script can assert that two cells match.
- **`msgrpc record` and `msgrpc replay`.** The tap already produces correlated, self-describing frames, so a recording is that stream in a file - jsonl, so `grep`, `jq` and `wc -l` work on it, and appended as frames arrive so a process killed mid-session still leaves what it saw. What it is for is the question a plant asks constantly and no test framework answers: this new device is supposed to behave like the old one, does it? `replay` re-issues the recorded calls in their original spacing, compares each answer with the one recorded, and **exits 1 when anything differed or failed**, so a conformance check is a line in a CI file.
  - `Date` and `Uint8Array` are tagged in the file and restored on the way back. JSON carries neither, and a timestamp that replayed as a string is not what the device received - the same reason this library speaks MsgPack in the first place.
  - **A call that failed the same way it failed when recorded is a match.** A replacement that refuses what the old one refused is behaving, and counting that against it would make every recording of a real plant unusable. A call with nothing recorded to compare against is counted apart rather than as a pass, and one recorded without payloads is reported rather than sent empty - calling the method with nothing and comparing that is the worse answer.
  - Payloads are on by default for `record`, where the tap has them off: a recording without arguments and results cannot be replayed, which is the only reason to make one. It says so on startup.
- **`msgrpc serve`** stands a peer up from a contract, so an HMI has something to talk to and a test has a device willing to fail on request — which a real one is not. It answers every method with a value of the declared shape and **refuses what the real peer would refuse**, since it is handed the same schema and runs the same validator. The contract is the one already extracted and committed for the deployed peer, so the stand-in cannot drift from it: `msgrpc check` fails the build when it would.
  - Generated values are deterministic and inside whatever the type language carries — the midpoint of a range, required fields only, the first non-null option of a union. A fake whose readings wander is pleasant to look at and impossible to assert on. `pattern` is the one constraint it cannot honour, and a recursive type stops rather than descending forever.
  - `--script` supplies canned returns, deliberate failures and events on a timer; `--fail ns.method=Code` is the same without a file. **`Timeout` is the special code: the call is never answered at all**, so the caller's own timeout is what fires — the failure an HMI handles worst and the one otherwise staged by pulling a cable. Only the named method is affected, so a test can break one thing rather than the device.
  - It says it is a fake on startup and in the class name a console shows, because a stand-in mistaken for the device is worse than no stand-in at all.
- **A method can choose its error code** by throwing an error carrying one. Everything a method threw came back as `Exception`, so a service that wanted to say "you may not do that" could say it only in the message, and a caller reading `code` to decide whether to retry, re-authenticate or give up learned nothing from it. Restricted to the codes the protocol already defines — `Unauthorized`, `Forbidden`, `InvalidParams`, `IncompatibleVersion`, `ClassNotFound`, `MethodNotFound`, `TransportError`, `Timeout` — so an error carrying an unrelated `code`, a Node `ENOENT` say, is still reported as the exception it is. **This changes what callers see** from a method that already throws such an error: the code is now that one rather than `Exception`, and the message is unchanged.
- **A Problems tab**, and `console.problems` behind it. The transports have always emitted `rejected`, `unroutable`, `peerDisplaced` and `transportError`, and the console listened to none of them — it wired up `peerOnline`/`peerGone` and dropped the rest. Between them those four cover every way a call disappears without an answer: refused before the RPC layer, nowhere to deliver it, a name two peers are both answering to, or a link that failed underneath. Until now all of it arrived as an unexplained timeout, which is the hardest kind of problem to diagnose and the one this tooling exists to make visible.
  - **Kept as well as streamed.** Nothing to switch on, a bounded history, and the page is handed what happened before it was opened — because nobody opens the console until something is already wrong.
- **Each peer says which link it was found on.** `console.ts` looped over `network.transports` to build the online set and threw the transport away, so a console holding a browser link, a broker and a hub at once could not say which one a peer was on. Peers already connected when the console starts get theirs from the registry, which is how they were discovered in the first place.
- The console's own contract now **declares its events**. It described five methods and none of its three events, so a console pointed at another one showed an empty event list on a service that emits `event`, `peer` and now `frame`.
- **`TransportEvent.relayed`** reports a frame a server is passing between two other peers — the only place traffic nobody here sent or received can be observed. Emitted from the one point both relay paths cross, so a frame moving to another transport is reported too and a tap on a mixed network does not quietly miss half of it. Guarded on the listener count, since it runs per frame and building the object for nobody is the cost.

- **`msgrpc peers`, `describe`, `call` and `watch`** — the console's verbs for a shell rather than a browser. Everything the network could be asked was reachable only through `console`, which needs a browser, or `mcp`, which needs a model on the other end; a shell script and a CI job had neither. These take the same network flags, answer once, and exit 1 when a peer refuses, which is what makes a smoke test a line in a CI file instead of a program that parses output.
  - **Arguments come from the peer's own contract.** A shell has only strings, so the peer is described first and its schema decides what each word means: `1200` is a number where the contract says `number` and the text `1200` where it says `string`, `auto` matches a literal in a union, `bytes` takes hex and `date` takes an ISO string. Without this, `msgrpc call plant plant.writeSetpoint 1200` sends `"1200"` and comes back `InvalidParams: expected number, got string` — correct, and useless. Where a peer publishes no contract the rule is JSON-if-it-parses and the literal text otherwise, so `42` is a number and `hello` is a string rather than a syntax error. `--args '[…]'` is the escape hatch.
  - A word that cannot be what the contract asks for is refused before anything is sent, and the argument is **named rather than numbered**: `argument 0 (celsius): expected a number, got 'warm'`.
  - `--json` on every verb, rather than guessing from whether stdout is a tty — that guess is wrong exactly when it matters. `call` puts the result on stdout and the timing on stderr, so a pipe carries the value and nothing else. `watch` writes jsonl, since a stream that is pleasant to read is a stream nothing can parse.
  - Each verb waits up to `--wait` for the peer to become addressable. `ready()` means the links are up, not that presence has arrived, and a one-shot command that gave up on that gap would fail intermittently for reasons nobody could reproduce.
  - Ctrl-C on `watch` drops the server's subscription as well as stopping the stream, so a debugging session leaves no listeners behind on a device that outlives it.
- Joining a network is now one function rather than three copies of twenty lines. `console`, `mcp` and the verbs built the same transport list each, which is three places to forget `--prefix` in, and the same two checks — that there is something to join, and that a `--name` does not contradict the name the key file belongs to.

### Fixed

- **The console page sometimes failed to reach the console on load**, reporting `no response to console.on within 10000 ms` and listing no peers, on roughly one load in two when loads followed each other quickly. The page opened an `RpcServer` and closed it in React's effect cleanup, which does not run when a document is torn down by a navigation - so every page navigated away from left its connection behind, and remained a peer in everyone's list, still being sent the events it had subscribed to, until the console reaped it. socket.io connects over HTTP long-polling, so each of those held a long-lived request against the console's origin, and Chrome allows six concurrent connections per host: five stale pages plus a new one's handshake is exactly six, and the new page's poll queued behind requests that would not return. It now closes on `pagehide`, which covers navigation, tab close and the back/forward cache where `unload` is unreliable. Three loads left five stale peers before and none after.
  - The page also **retries the handshake** three times before giving up, so the console recovers rather than sitting there with an error and an empty peer list - a poor answer from the thing you opened to find out what was wrong.

### Security

- Anyone who can reach an unauthenticated broker can now call `bus.tap()` and mirror everything crossing it. They could always have read the same traffic by impersonating a peer — the broker has never checked who anyone is — but not this conveniently. `authenticate` and `relay` are what gate it, and the broker now says so on startup next to the warning it already printed about relaying for whoever connects.

## msgrpc-cli 2.4.1

- The `msgrpc` binary is made executable at build time. `tsc` writes `dist/index.js` with a shebang but no executable bit; npm sets it when installing a published tarball, so the published package was fine and a workspace checkout was not. `npx @source-repo/rpc-cli` run from inside this repo resolves to the workspace copy and died with `sh: 1: msgrpc: Permission denied` - which an MCP client reports only as "Connection closed".

## msgrpc 2.3.0 and msgrpc-cli 2.4.0

- **`msgrpc mcp`** serves a live network to an [MCP](https://modelcontextprotocol.io) client over stdio, so a model can look at a plant the way a person looks at the console. Three tools - `list_peers`, `describe_peer`, `call_method` - rather than one tool per method on the network: a peer set that changes mid-conversation would mean re-issuing the tool list on every arrival and departure, and `describe_peer` hands over the argument types instead. A call a peer refuses comes back as tool content carrying the reason, not as a JSON-RPC failure, because a model can act on the first and not the second. No MCP SDK behind it - MCP is JSON-RPC 2.0 over newline-delimited stdio, and this package is about not needing a second RPC framework.
- **A name collision is reported on MQTT 3.1.1 too**, where it has to be inferred rather than read: 3.1.1 has no reason codes, so a session taken over looks exactly like the link dropping - except that it does not stop, because two peers sharing a client id evict each other on sight and neither connection outlives the next one's arrival. Three connections in a row that die young are reported as a suspected collision, and said to be a guess, since a network flapping this hard looks the same. MQTT 5 still says so outright with reason code `0x8E`.

### Fixed

- **`SocketIoClientTransport.close()` returned before the connection was closed.** `disconnect()` only starts it: a close packet goes out and it returns, leaving the engine's ping timer armed until the transport is actually torn down. So a promise that was supposed to mean "closed" resolved while the connection was still running - the mirror of what the server transport already got right, where `io.close()` and the HTTP server's close are both awaited. This was also the intermittent hang after a passing test suite, which ava 8 reports as a failure rather than a warning: 4 reproductions in 40 runs before, 0 in 40 after.
- socket.io connections are refused while a server is closing, at the handshake, so one completing inside that window cannot outlive the sweep that was meant to disconnect it.
- `GenericModule.ready()` polled with no way out, so a module that never became ready - one that failed to start, or was closed while something still awaited it - spun on a 10 ms timer for the life of the process, which is also enough to keep the process alive with nothing left to do. It now gives up and returns false.

## msgrpc 2.2.0 and msgrpc-cli 2.3.0

**Discovery and routing over socket.io**, so a network with no broker works the way an MQTT one always has - and so a server hosted in a browser page is a peer like any other.

- **Readable peer names.** The default is three hyphenated words from the BIP-39 English list (`brisk-otter-cable`) rather than a UUID. That list is 2048 words chosen to be unambiguous in their first four letters; the rest of BIP-39 - entropy sizes and a checksum - is for seed phrases and does not apply. A name is what a caller addresses, what presence lists, what a log line blames and, over MQTT, the broker's client id, and a UUID is none of those things legibly. `readableNameFrom(seed)` derives the same name from the same seed, for a peer meant to be recognised across restarts.
- **A browser can host an `RpcServer`.** `RpcServer` in Node is `NodeRpcServer`, which adds `{ port }`, `{ server }` and `{ brokerurl }`; in a browser the same name is the portable base, which has none of them. Source that sticks to `{ connect }` and transport instances is portable between the two, and `{ port: 8080 }` in browser code is a compile error rather than a runtime throw. Nothing a browser resolves imports socket.io's server or the MQTT client, so neither reaches the bundle without any bundler configuration.
- A listener that cannot bind now fails `ready()` with the reason - a port already in use is not something more waiting fixes - instead of being waited out for the full `readyTimeout`.
- **`RpcServer.proxy()`**, the mirror of `RpcClient.proxy`. A peer that both serves and calls now needs one object and one connection, under one name, rather than an `RpcServer` and an `RpcClient` under two - which over MQTT meant two broker sessions. Its subscriptions are replayed on reconnect the way a client's are.
- **A bus without a broker.** An `RpcServer` that exposes nothing and only relays is one; everything else joins with `{ connect: url }` and gets presence, addressing by name, and any-to-any calling.
- **More than one hop.** A peer announces the peers reachable *through* it as well as its own name, so a server that is a hub for its own peers and a member of a bus makes each visible to the other. Calls, replies and events all traverse it, and departures propagate. Verified to three hops. Split horizon - never advertising a peer back along the link it came from, in the broadcasts and in the snapshot handed to a newly connected peer - keeps two hubs from concluding the other is the way to a peer and losing it. Frames carry a hop count and are dropped after 8 relays, since a mesh that has just lost a link can hold a cycle until the tables settle. A peer offered by two links keeps the first and falls back to the second; a peer announcing itself outranks one merely carried.

- **Every peer announces itself on connect**, and is told who else is there. A socket.io server used to learn a peer only from the header of a frame it sent, so a peer that merely listened was invisible and could not be addressed at all. `peerOnline` and `peerGone` now come from both transports, so code watching a network no longer cares which one it is on.
- **`transports: [{ connect: url }]`** lets an `RpcServer` serve over a connection it opens. A browser cannot listen, so this is the only way a page can host a service; the hub relays calls to it.
- **A server relays for its connected peers.** A frame addressed to another peer it can see is forwarded instead of executed locally. `relay: false` forwards nothing, and a predicate decides per connection. The decision is remembered per pair of peers, because a rule written about the caller would otherwise strand the reply travelling the other way. A relaying server with no `authenticate` warns once, the first time it actually forwards something.
- **A server holding both a socket.io listener and a broker connection bridges them.** A browser peer discovers a peer that exists only on MQTT and calls it, with the call arriving under the browser peer's own name rather than the bridge's, so per-peer authorization and subscriptions still mean something. The bridge subscribes to the reply and event topics of the peers it forwards for, and publishes presence on their behalf - without that, a departing browser peer left its event subscriptions on the MQTT server forever.
- **`msgrpc console --hub <url>`**, on its own or alongside `--broker`. With both, one list covers both networks and each peer is called over the link it was found on.
- **`msgrpc broker`** runs a WebSocket bus until Ctrl-C, for networks with no MQTT broker to share: it relays between the peers that connect and tells each who else is there. `--upstream <url>` joins another broker, repeatable, and the two become one network - a peer on either is callable from the other. It is an `RpcServer` exposing nothing; there is no separate implementation.
- **A `record` kind in the schema type language**, for a dictionary whose keys are not known in advance: `{ [tag: string]: Reading }`, which is how plant data usually arrives. `extract` used to refuse an index signature outright, because describing one as an object with no properties produces a type that rejects every value. A record checks every value against one type and leaves the keys open, or constrains them with `keyPattern` - which is what a numeric index signature becomes, since a JS object key is always a string on the wire - and `maxEntries` bounds it the way `maxItems` bounds an array. It was also the first thing needed to describe msgrpc's own introspection output, which is built out of `{ [name: string]: TypeNode }`.
- **`describe()` describes itself.** The `msgrpc` namespace ships a contract extracted from its own source, so a peer reading a server sees the type it will get back. Its named types are prefixed `msgrpc.*`, because the schema has one type map shared by every namespace and a plant defining its own `TypeNode` should not find `describe()` described against it. A schema that already defines `msgrpc` is left untouched.
- **The console and the page it serves ship contracts too**, so pointing one console at another gives argument fields rather than `call(...)` and `say(...)`. `npm run contract` regenerates all three; a test asserts they still match the source they came from.
- **A name collision is reported rather than silent.** Both transports emit `TransportEvent.peerDisplaced` and warn once when a second peer turns up under a name already in use. The newcomer still takes the address - a peer reconnecting after a blip announces itself while the old connection may still look live, and refusing it would lock a peer out of its own name - but two peers genuinely sharing one used to send each other's replies into the wrong place, which reads as calls timing out for no reason. Over socket.io the server sees both connections; over MQTT the client id is derived from the peer name, so the broker hands the session over and tells the displaced peer why with reason code `0x8E` (MQTT 5 only).

### Fixed

- **A socket.io server executed calls addressed to another peer.** The target was tested only for being a name the server had heard of, never for being the server itself, so a call meant for someone else was answered by whoever it reached - with that server's own implementation, reported as success. It now forwards, or refuses; it never substitutes itself. A frame that can be neither delivered nor relayed is reported as `unroutable` rather than dropped in silence, which callers only ever saw as an unexplained timeout.
- `MqttTransport` set the response topic of a forwarded request to its own address, so a non-msgrpc peer honouring it would have replied to the wrong peer.
- A socket.io server reported itself ready before its port was bound, and had no handler for the listener's `error`. A port already in use therefore announced a running server and then took the process down with an unhandled event; it now waits for `listening` and reports the failure.
- `exposeIntrospection` with `validation: 'required'` refused `msgrpc.describe`, so the one call a peer makes to find out what a server offers was the only undescribed thing on it.
- `validateValue` returned "valid" for a node whose `kind` it did not recognise - a typo, or a document written for a later version of the language - which is an unchecked value wearing a checked type. It now refuses.
- `extract` keyed a generic instantiation under its bare alias, so `Record<string, number>` and `Record<string, string>` collapsed into one named type and the second silently became a reference to the first's value type. Instantiations are inlined instead.
- Every console page derived its peer name from the console's host, so every browser pointed at one console produced the same name and their replies went to whichever the server registered last. A page now takes a random readable name, kept in `sessionStorage` so a reload comes back as the same peer; `?name=` overrides it, the page's version of `--name`.

### Tests

- MQTT test peers get a 10 s session expiry. Names became unique per run in 2.1.1, which fixed one problem and created another: a server keeps a persistent session for an hour by default, so every run left another one behind. After a day of runs the broker held 1024 sessions and 3628 subscriptions and stopped accepting connections. The one test that is *about* the hour-long default keeps it and clears its own session afterwards.

### Breaking

- `new SocketIoClientTransport(url, sources, options)` is now `new SocketIoClientTransport(name, url, sources, options)`. A peer has to know its own name to announce it, the same way `MqttTransport` has always taken one. `RpcClient` passes its `name` through, so this only affects code constructing the transport directly.
- `TypeNode` gains a `record` variant. A schema written by hand needs no change, but code that switches exhaustively over the union has a new case to handle.

## msgrpc 2.1.1

Documentation and test hygiene; no change to shipped code.

- The quick start did not compile: `Calculator` was neither exported by the server snippet nor imported by the client one, and the client needs the class as a type to get a typed proxy. It is now a shared `calculator.ts` the client pulls in with `import type`, which is the point being made and was the thing left out.
- The MQTT example gave the server `prefix: 'site-4'` and the client no prefix at all, so the two could never reach each other. An `mqtt://` url takes the default prefix and there is no client option to change it, so the section now shows building the `MqttTransport` and says what the mismatch looks like: a bare call timeout.
- A **Connecting** section, which was missing entirely - transports against urls, peer names and targets, `ready()`/`close()`, and the MsgPack/JSON choice. The README went from the quick start to decorators and schemas without ever saying how to point a client at a real server.
- Reordered so the basics come first: exposing, errors, events, then schemas and versioning, then introspection, authentication and MQTT. Security and broker detail used to arrive before the ordinary reader had been shown a second method call.
- The opening sentence said "expose an instance", which read as though instances were incidental. It now says the instance is one live object that every call runs against, and the quick start demonstrates state surviving between calls.
- Exposing more than one namespace, and `exposeObject`, are both shown.

### Tests

- The MQTT tests gave every peer a fixed name, and a peer name is the broker's client id. A server keeps a persistent session, so a second run resumed the first run's session and was handed whatever it still had queued - which showed up as an occasional failure that never reproduced when the file was run on its own. Names and topic prefixes now carry a per-run suffix.
- `rpc traffic is published per peer` waited for two messages on the observed prefix before asserting, which the two presence announcements could satisfy on their own, leaving the reply still in flight. It now waits for the rpc topics it is actually about.

## msgrpc-cli 2.2.0

- **`msgrpc console` is now a React app, and it reaches the CLI over msgrpc itself.** The CLI runs an `RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace (`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events; the browser is an ordinary `RpcClient`. The REST endpoints and the server-sent event stream are gone. The console is now the library's own first client, so a fault in event routing surfaces here before it reaches a plant.
- **A method folds open into a form with one field per argument**, built from that argument's type: a number input carrying the schema's bounds, a dropdown for a union of literals, a checkbox for a boolean, a picker for a date, a hex field for bytes, and for an object a JSON box pre-filled with the shape's required fields. Optional arguments have a checkbox deciding whether they are sent at all. Previously the whole call had to be written as one JSON array.
- JSON typed into a field is walked against the type before it is sent, so an ISO string where the schema says `date` becomes a `Date`. Without this any object carrying a timestamp was rejected by the server that asked for one.
- The browser waits longer than the console's own `--timeout`, which the console reports. Both defaulted to 10 s, so a call into an unreachable peer used to time out in the browser at the same moment the console was forming the answer that said why.
- Everything is bundled into `dist/web`; nothing is fetched at runtime.

## msgrpc 2.1.0

- `MethodSchema.paramNames` carries parameter names, and `msgrpc.describe()` reports them. Tooling that has to present a call to a person needs a label, and "argument 0" is not one. Optional and never used for checking, so a hand-written schema can leave it out. `msgrpc extract` writes it.

## msgrpc-cli 2.1.0

- `msgrpc console --sign <keyfile>` lets the console take part in a signed network. Without it the console lists peers, because presence is unsigned retained state, and then every call times out with nothing to say why. Keys come from a file rather than a flag, since a secret on a command line is visible to anyone who can run `ps`, and a `--name` contradicting the key file is refused rather than left to surface as that same timeout.
- README corrected: it claimed broker credentials and signing already applied to the console, which they did not, and documented none of the console's flags.

## msgrpc 2.0.1

- README rewritten. It documented 3 of 14 server options, described the MQTT v1 topic layout as current when MQTT 5 has been the default since 2.0.0, and its low-level examples wired converters that 2.0.0 removed. No code change.
- `repository.directory` and `homepage` added, so npm and GitHub can find each package in the tree.

## 2.0.0

A near-complete rework of everything below the API. The class-as-contract surface is unchanged — `exposeClassInstance` and `proxy<T>()` still look the same — but correlation, addressing, reconnection, security and the MQTT wire format were all rebuilt.

Published as `@source-repo/rpc` and, new in this release, `@source-repo/rpc-cli`.

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

Several of these were exploitable in 1.x. If you ran 1.x where untrusted peers could reach the transport, assume they were reachable.

- **Replies were broadcast to every connected socket.** An unauthenticated socket could read another client's payloads; clients merely filtered on arrival. Replies now go to one socket.
- **`ManageRpc` exposed itself**, so any peer could construct any `exposeClass`'d class with chosen arguments, or overwrite an exposed name and deny service to everyone else.
- **MQTT peer names were interpolated into topics unchecked.** A peer named `#` subscribed to every other peer's traffic. Names are now validated as a single topic level.
- Optional `authenticate` / `authorize`, with identity bound to the connection rather than looked up by a claimed name, so one peer cannot address messages as another.
- Optional frame signing (HMAC-SHA256 or Ed25519) with replay protection, which gives MQTT peers a verifiable identity without trusting the broker.

### Added

- **MQTT 5 frame layout** — reply address, correlation and method travel as packet properties, so a peer with no msgrpc code can take part and standard tooling can read the traffic. See `docs/mqtt5-frame-spec.md`.
- **Argument checking** against a schema, with `@rpc` marking which methods are exposed at all.
- **Contract versions**, compared structurally: a caller built against an older contract keeps working unless the two genuinely disagree.
- **`msgrpc.describe()`** reporting namespaces, methods, events and live instances. Off by default.
- **`@source-repo/rpc-cli`** — `extract` reads a contract from TypeScript source, `check` fails a build on a breaking change, `console` serves a browser view of a live network.
- MQTT shared subscriptions for server replicas, bounded sessions, and presence.
- Connection lifecycle events, configurable `callTimeout`, and fail-fast on disconnect.

### Fixed

- MsgPack round-tripped through JSON, turning every `Uint8Array` into `{"0":1,…}`.
- A server-side throw never rejected the caller; it timed out after 10 s with the error discarded.
- Pending-call bookkeeping never drained, leaking a timer per call.
- Repeated `on()` stacked a server-side listener each time and none could be removed.
- Clients did not re-subscribe after a reconnect, and servers never released a departed peer's subscriptions.
- `off()` was never handled by the server, so unsubscribing did nothing.
- Peer routing lived in one process-wide static, so two servers in a process could deliver each other's replies to the wrong client.
- `open()` ran twice per client, and `close()` left socket.io's reconnect timer armed.
- Browser builds pulled in the MQTT client whether or not they used it.
