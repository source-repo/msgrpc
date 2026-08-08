# Setting state from a console

Working note, prompted by what the context console currently does and should stop doing. It records why inferring a setter from a method's name is the wrong mechanism, and the two things that could replace it.

## What the console does today, and why it is wrong

The component panel offers an editor on a state field when the namespace publishes a one-argument method whose name is that field with `set` in front: `setpoint` gets an editor because `setSetpoint(celsius: number)` exists, and `temperature` gets none because nothing sets it. That reads well in a demo and it produces the right answer almost always.

Almost always is the problem. The rule infers **intent** from a **name**, in a library that carries `semantics` on every method precisely because the difference between a query and a command is too important to leave to what something is called. `setMode` might not assign `state.mode`; it might begin a mode *transition* with a purge cycle and an interlock behind it. `setPressure` might command a setpoint while `state.pressure` is the measurement beside it, in which case the console draws an edit button on a measured value and the operator's write appears to do nothing. The failure is not that the guess is often wrong. It is that when it is wrong it is wrong silently, in the direction of commanding a plant, and the operator has no way to see it from the row.

This is the same mistake in miniature that the library refuses elsewhere: a decision that looks like a property assignment, standing in for a method call whose meaning nobody declared.

## The declared marker

The house shape for this already exists twice over. `@rpc({ semantics: 'idempotent-command' })` declares what calling a method does to the world; `@rpc({ effect: 'program' })` declares which authority it needs. Neither is inferred from a name and both are read straight out of the extracted contract. A third of the same kind:

```typescript
@rpc({ semantics: 'idempotent-command', sets: 'setpoint' })
async setSetpoint(celsius: number) { … }
```

`extract` reads the option the way it reads `effect`, `MethodSchema` carries it, `describe()` surfaces it, and the console draws an editor on exactly the paths some method claims - no naming rule, nothing to get wrong when a class is minified, and a nested path like `zones.top.setpoint` becomes expressible where the naming rule could never reach it. The author who writes the method says what it sets, once, next to the semantics they were already declaring.

It also keeps what a per-field setter is *for*: the method can clamp, refuse while the door is open, and check an interlock. That validation is the reason a plant has `setSetpoint` rather than a writable field, and it survives intact.

## The generic setter

Per-field markers are right for the handful of commanded values on an oven and absurd for a component carrying three hundred tags. For that case the honest form is one method taking a path and a value, declared the same way:

```typescript
@rpc({ semantics: 'idempotent-command', sets: '*' })
async set(path: string, value: unknown) { … }
```

`sets: '*'` says this method sets any path, so one option covers both cases and the console's rule stays "what does the contract claim", never "what is this called". The type information needed to encode and check the value is already published with the state, so a wrong type can be refused at the boundary rather than discovered by writing it.

Two things stay the author's responsibility and should not be provided by the library. The method body is theirs to write, because a generic writer supplied by the framework is a writable field with extra steps and loses every validation a component exists to apply. And whether a given path may be written at all is theirs to decide inside it - the marker says a method *can* set paths, not that every path is open.

**Built**, with the gate below, as `allowStatePathWrites`. One thing had to change on contact with the extractor, and it is worth recording because the note had it wrong: the served method cannot carry the generic signature. `extract` describes a contract in a runtime type language and refuses `set<V>(path: RpcTypedPath<V>, value: NoInfer<V>)` outright - *argument 1 has no representation in the schema type language (NoInfer&lt;V&gt;)* - which is the same refusal an unresolved generic component gets, and correct: publishing `any` there would be a contract that checks nothing while looking as though it does.

So the wire method is concrete, `set(path: string[], value: unknown)`, and the compile-time half moves to the calling side as `RpcPathWriter` - an interface handed to `proxy<T>()`, which is existing machinery rather than anything new. The `NoInfer` argument in the section below is unaffected and still load-bearing; it simply belongs on the caller's declaration rather than the server's. And the loss is smaller than it first looks, because the state interface travels in the contract: the type at a path is published, so a console and the MCP `set_state` tool refuse a wrong value from the contract alone, before it travels.

The other thing worth writing down is the bluntness. A component declaring `'*'` claims *every* path by construction, so a console draws editors on measured values too and they fail when used. There is no way for the contract to say otherwise - the whole point is that the method decides - so this is the honest cost of one method standing in for three hundred markers, and another reason the plant answer stays per-field.

## The caller's side: paths that the compiler checks

A generic setter takes a path, and a path written as a string is the one part of an otherwise checked call that nothing checks - no completion, no rename safety, and no way for the compiler to know that `zones.top.setpoint` wants a number rather than the word `hot`. That is a poor trade in a library whose whole argument is that the class is the contract.

The fix is a proxy, used for the half a proxy is actually good at: recording what the caller meant. `rpcPath` and `rpcWrites` are implemented in `RPC/Paths.ts`.

```typescript
const state = rpcRoot<OvenState>()                       // once, wherever the type is known

await oven.set(rpcPath(state.zones.top.setpoint), 180)
const setpoint = await oven.get(rpcPath(state.zones.top.setpoint))   // typed number
```

The proxy records the properties that were read and returns the segments they spell, carrying the type at the end of them. Completion works, a rename moves it, a misspelling does not compile, the value written is checked against `number` rather than `unknown`, and the value read back needs no cast. That is strictly better typing than a string could ever carry, and it is the whole of what makes a generic setter pleasant to call.

The root exists because TypeScript will not infer one type argument while another is given, so a single `rpcPath<OvenState>((state) => …)` cannot both take the state type and work out the type at the end. Naming the root once is the smaller price, and the call sites outnumber it.

Two details in the signature are load-bearing, and both are the kind that produce the *appearance* of a check rather than a check. The value must be `NoInfer<V>`, or it becomes a second inference site and passing the wrong value simply widens `V` to include it - `set(path-to-a-number, 'hot')` compiles, and nothing warns. And `RpcPathOf` must be written `[T] extends [object]` so the conditional does not distribute, or a field typed `'idle' | 'heating'` arrives as one arm of the union rather than the union, and any word is accepted. Both are covered by `@ts-expect-error` assertions in `Paths.test.ts`, which fail the build if either regresses.

For several fields at once there is the draft, which buys back assignment syntax without giving up the outcome:

```typescript
await oven.apply(rpcWrites<OvenState>((state) => {
    state.zones.top.setpoint = 180
    state.mode = 'heating'
}))
```

Two fields, one command, one `await` with somewhere to put a refusal - which a per-field setter cannot offer and an assignment to a remote object cannot either. A draft is write-only in intent and cannot be made so in the type system, so the one rule is that it is never read from; a read hands back the path builder rather than a value.

Neither of these sends anything. They produce what to send, and the sending stays a method call. That boundary is the point rather than an omission: `oven.state.setpoint = 180` returns nothing, so a refusal by `authorize()`, a validation error, a timeout or an `UnknownOutcome` has nowhere to go but a floating promise or silence. It also invites `oven.count++` and `oven.items.push(x)`, which reintroduce read-modify-write against a stale cache and the array-mutation mess respectively. `rpcPath` and `rpcWrites` invite neither, because both are explicit about writing an absolute value at a named path.

## Reading one value out of a large state

Reading from a component that is already observed needs none of this: `component()` gives synchronous cached reads, so `oven.state.mode` is a local property access with no network hop and nothing to report.

It stops being free where the cache does. The cache is filled by a whole snapshot, so a caller that wants one value out of a large state pays for all of it - on a slow link, eighty seconds before the first read can execute. That is the same asymmetry as the write side and it has the same answer: name the path, ask for that.

```typescript
const setpoint = await oven.get(rpcPath(state.zones.top.setpoint))
```

The wire carries a path and one value in each direction. Typed by where it came from, so there is no cast and no string.

The subscription form is the one that matters more, and it is the per-subscriber projection already argued for in `component-snapshot-patches.md` as the thing to build before patches:

```typescript
const store = oven.observe([rpcPath(state.zones.top.setpoint), rpcPath(state.mode)])
```

What arrives is still a whole snapshot - of the projection - so duplicate delivery and reconnect replay stay harmless, and none of the properties that make the channel simple are given up. What changes is only how much of the state is in it. For the console's tag field that is a fifteen-fold reduction on the wire before any delta encoding is considered, and unlike patches it needs no base tracking, no keyframe schedule and no new counter.

A projection is a narrowing, so it needs none of the gating the generic setter does: asking for less than you are already entitled to exposes nothing new, and `authorize()` sees the paths like any other parameter.

The console needs none of this today, because it iterates everything it displays and holds the paths already. It would want it on a slow link, where a tree that subscribes only to its expanded branches is the same idea arriving from the other direction.

## Security, and where this belongs

A generic path setter is a development affordance. It is the shape of thing that should be off unless someone turned it on, and the repository already has the pattern: remote topology mutation is "refused wholesale unless the server opted in with `topology.allowRemoteMutation` - and gated by authorize() like any call". A generic state setter should be identical in shape - opt-in per server, default refused, and still passing through `authorize()` with the path and the caller both visible, so a plant's policy can rule on *which* path rather than only on the method.

**Built as `allowStatePathWrites`**, in that shape, with one addition the topology precedent did not need: a host with the gate shut does not *advertise* the claim either. `describe()` reports what the server will honour rather than what the source declared - the principle `effect` already follows - so `sets: '*'` is withheld, a console draws no editor from it and a model is offered no tool. A claim the next call would refuse is not a claim. Calling the method regardless still answers with a refusal naming the flag, so a developer who meets it learns which decision was never taken rather than merely that they may not.

That framing also settles the console's side of it. The console is primarily a development tool, and a development network is where a generic setter is worth having; on a plant the answer is the declared per-field markers, whose methods carry the interlocks. The console needs no mode of its own for this - it draws what the contract claims, and a peer that claims nothing offers no editors.

## What was done in the meantime, and what replaced it

Before `sets` existed the console still had to decide something, and there were only two honest options: offer no editors at all, or stop describing what it does as editing. The second was better and is what the panel did - the row proposes a **call**, shows the method and the argument it will send, and the operator commits that rather than a value. The naming rule survived only as a way of *suggesting* which method was relevant, never as a claim that the field was writable.

**The declared marker is now built**, and the naming rule is gone with it. `@rpc({ sets: 'zones.top.setpoint' })` is read by `extract`, carried on `MethodSchema`, reported by `describe()`, and matched against the path each row draws; a peer that declares nothing offers no editors. Two refusals landed at expose time rather than in the contract: `sets` on a class that is not an `RpcComponent` has no state for a path to name, and `sets` with `query` semantics is a contradiction in one breath. Neither is guessed at.

The half that stayed is the one worth keeping: the row still proposes a **call** and shows it in full before sending. A declared path says which method changes a value, not that the value is a writable field - the method body is still where the clamp and the interlock live, and `setSetpoint(180)` is still what the operator commits.

What `sets` deliberately did *not* get is a compatibility rule. A method that stops claiming a path removes an affordance from a console, which is a change in what tooling can offer rather than a promise to callers that has been broken - so `check` says nothing about it, where it would refuse an effect that escalated.
