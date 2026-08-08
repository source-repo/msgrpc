# Patching a component snapshot

Working note. The component channel sends state whole, deliberately; this records what it would take to send a delta instead, why the usual objection does not apply to the shape below, and where the real cost sits. Nothing here is implemented.

## Why it comes up

A snapshot travels whole on every change. For the state the channel was designed for - a mode, a health, a handful of reported values - that is free and buys a great deal. It stops being free when a component carries a few hundred tags and one of them moves: three hundred values cross the wire so that one number can change, five times a second.

The receiving end of that is already solved and cost nothing in protocol: full frames mean a fast receiver can drop 999 frames in 1000 and remain exactly correct, and the console's tree now renders only the rows whose own value moved. What is not solved is the wire, and the wire is where a slow link lives. On a 1200 baud channel a 12 kB snapshot takes eighty seconds. One named field and a float takes a tenth of a second. That is not an optimisation; it is the difference between the link working and not working, and it is the case worth designing for because it is the case that cannot be fixed by publishing less often.

## The objection that does not apply

`Component.ts` says full snapshots make reconnect recovery a resend rather than "a patch chain that one missed frame corrupts", and `Context.ts` says the same about duplicate delivery and replay. Both are correct, and both are about a **blind delta stream**: patches applied in arrival order, where a lost frame silently produces a cache that disagrees with its owner and nothing detects it. That failure is invisible, which is what makes it unacceptable on a plant.

A patch that **names the base it applies to** is not that. Carry the epoch and revision the delta was computed against; the receiver applies it only if it holds exactly that revision, and discards it otherwise. Misapplication is then impossible rather than merely detectable - not because loss cannot happen, but because a receiver cannot fail to notice it. Applying such a patch yields a cache bit-identical to having received the whole snapshot, which is the property that matters and the one a blind stream cannot promise.

So the recorded reasoning does not forbid this. It forbids a weaker design that this one is not.

## The shape

A patch frame carries the base `{ epoch, revision }`, the resulting revision, and the changed paths with their values. The receiver checks the base against what it holds: apply, or discard and resynchronise.

**The sender does not have to diff.** `setState` already receives a partial - the changed fields are named by the caller at the moment of the commit - so the changed path set is known for free, and coalescing several commits into one publish is the union of their paths. This is the part that makes the idea cheap on the sending side, and it is worth noticing that it falls out of the existing API rather than needing a new one.

**Resynchronisation already exists.** Subscription is register-then-snapshot: the answer to `subscribe` *is* a full snapshot. A receiver that cannot apply a patch discards it and re-subscribes, and what comes back is its keyframe. No periodic keyframe schedule is needed, which matters on the slow link where a keyframe is the expensive thing - it is paid only by a receiver that actually lost its place.

**The contract already carries what the encoding needs.** `extract` publishes the props and state interfaces beside the method signatures, so both ends can derive the same canonical table of field paths from the same contract and name a field by a small integer rather than a string. A value can be encoded against its declared type - a three-option literal union is two bits, not a word - and a patch naming a path outside the type is unrepresentable, which is validation obtained for nothing. This is where the published interface earns its keep a second time.

The caveat is worth stating plainly, because it bites exactly where the payload is largest: a record's keys are data, not type, so they cannot be pre-enumerated. A patch to one of three hundred tags still carries `tag.147` as a key. The path table helps the typed part of the tree and not the wide part of it.

## What actually needs deciding

**Who holds the base.** With many subscribers at different revisions the sender either tracks each one's base - unbounded state for a subscriber that has gone quiet - or publishes deltas against the last thing it published and lets anyone who fell behind re-subscribe. The second is simpler and degrades correctly; it means one lossy subscriber costs a full snapshot, which on a slow link is the expensive outcome, so the choice interacts with the link rather than being decidable in the abstract.

**Retained messages.** MQTT's retained slot is how a late joiner learns current state without asking. A retained patch is useless to someone who holds no base, so the retained slot has to keep a full snapshot whatever the live stream carries. That is a real wrinkle for the MQTT wire format, not a detail.

**Whether it is worth it.** Three cheaper things come first and are additive rather than exclusive: `minPublishIntervalMs` already coalesces published snapshots and costs nothing to set; a per-subscriber projection would let an observer subscribe to the twenty tags its screen shows out of three hundred, cutting both wire and render while keeping every frame whole; and genuinely fast values belong in events or a stream, as `Component.ts` already says. Patches are what remain when the link itself is the constraint, and that is the case they should be justified by.

**The projection is now built**, which moves the bar for this note rather than clearing it. `component(ns, target, { paths })` carries a path list on the subscribe, the server narrows both the targeted first snapshot and every published one per subscriber, and the snapshot carries a `projection` field naming what it holds - because a projected snapshot and a component that dropped half its state are otherwise the same bytes.

Three things it turned up that are worth remembering here, since they are the same class of hazard a patch stream would have. The projection has to reach the wire: `on(event, handler)` sent only the event name, so the first working-looking version quietly sent everything, and nothing but measuring the link would have said so. It has to survive a reconnect: `resubscribe()` replayed the subscription without the paths, restoring the whole snapshot on exactly the link that cannot carry it. And a path reaching nothing must leave nothing rather than an empty branch, since `tags: {}` asserts that a record exists and is empty.

So the remaining case for patches is narrower than when this was written: it is a component where even the *projected* state is too large for the link, or where the twenty values a screen shows change often enough that resending those twenty is itself the cost. That is a real case and a much smaller one, and it should be measured against a projection rather than against the whole snapshot.

The two answers are not in tension. Whole frames are what let a fast receiver discard almost everything and stay correct; base-referenced patches are what let a slow one see anything at all. Which a channel uses is a property of the link, not of the state.
