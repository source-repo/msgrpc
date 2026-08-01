# Source RPC Relay over Sparkplug B: a private tunnel, named as one

**Status:** Proposed design specification, deferred — not built until a paying deployment states the need
**Target:** A separate package, `@source-repo/sparkplug-relay`, deliberately outside `@source-repo/sparkplug`
**Companions:** `source-rpc-sparkplug-projection-design-spec.md` (the standards-based projection, which this is not) and `../ai-boundary/source-rpc-ai-boundary-design-spec.md`
**Audience:** Whoever eventually implements this, and — more importantly — whoever has to decide whether a site should adopt it

## 1. What this is, said plainly

This specification describes carrying **complete Source RPC frames through Sparkplug `Bytes` metrics**, so that peers on opposite sides of a Sparkplug-only boundary can call each other with Source RPC semantics intact.

That is a private tunnel. It is not native Sparkplug, it is not interoperable with any standard Host Application, and it is not what the projection specification sells.

This document exists because an earlier draft of the projection spec tried to have it both ways: it rejected "the opaque byte tunnel" and then kept a deferred relay carrying complete self-contained Source RPC frames in two transient `Bytes` metrics. External review named the contradiction — by any normal description, that *is* the tunnel — and the resolution taken was honesty rather than vocabulary. The projection carries no Source RPC bytes at all. The relay carries them, lives here, ships separately if it ever ships, and is adopted by a deployment as a **stated policy exception** rather than switched on as a dormant feature of a standards-based product.

The distinction is not pedantry. A Sparkplug-only site imposed that constraint because it wanted traffic at the boundary to be *inspectable*, and the projection's entire security story is that the boundary can read what crosses it. A tunnel through the same boundary honours the letter of the policy and defeats its purpose. A site may still decide that trade is right for it — but it decides, in the open, with this document on the table.

## 2. When it is the wrong answer

Before the design, the cases it should not be reached for:

- **A dev stage at a Sparkplug-only site.** A dev stage is not on the production broker; granting a private topic on the dev broker is almost always available and always preferable to tunnelling.
- **Anything the projection can express.** State, lifecycle and allowlisted idempotent commands cross natively, inspectably, and are understood by every Host on the bus. Reach for the tunnel only for what genuinely cannot be a metric.
- **Durable queued work.** `@source-repo/queue` exists for that. A relay that starts holding work for absent peers has become a queue with none of a queue's guarantees.
- **Anything safety-related.** Per the AI boundary specification's §11 — this is security and operational integrity, never a safety mechanism, and the fact that this profile is the least inspectable thing in the family makes that worth repeating here.

## 3. Shape

A Host-side relay that is a plain relay-only `RpcServer`: the library already relays between transports, so the relay is configuration and a transport, not a new routing engine.

- **One MQTT client, many virtual transports.** One Sparkplug session multiplexed into one virtual Source RPC transport per Edge Node — per Device only where a Device independently hosts a peer. Not one MQTT connection per device.
- **Two transient `Bytes` metrics per endpoint**: `SourceRPC/Outbound` (DDATA/NDATA) and `SourceRPC/Inbound` (DCMD/NCMD), declared in BIRTH with a protocol version and a maximum frame size, marked transient so historians do not archive them as process values.
- **Complete self-contained frames.** The MQTT 5 wire format keeps routing in packet properties, so its payload cannot be lifted as-is — but Source RPC transports own their wire format, and the socket.io transport already frames complete messages through its codec. The relay frame is that framing plus the ordering fields, not a new protocol.
- **The ordering vocabulary is the event cursors'** — an epoch per incarnation and a sequence that only orders within it, with "cannot know" across a restart. Sparkplug's own `seq` diagnoses outer-message gaps and is not the Source RPC ordering identifier.

## 4. Delivery, honestly

Sparkplug data and commands are QoS 0 on clean sessions: at most once, no acknowledgement, no retry, no broker-side queueing. The relay does not pretend otherwise.

**`retry-until-deadline` is the first and default profile.** The caller retains the request and retransmits the same request id until a result, an error, or the original deadline expires. The relay holds no custody, re-originates no request ids, stores and forwards nothing for peers already offline, and recovers from its own restart by doing nothing at all — because the caller still holds the request. Duplicate suppression and durable idempotency at the *target* decide what a retry is allowed to do, exactly as they do on any other transport.

**Commands are serialised per target** — one in flight, the next leaves when the first resolves — which makes the `setMode`-then-`start` reordering hazard structurally impossible at a latency cost industrial command streams mostly cannot notice. Bounded out-of-order windows are an optimisation to add with evidence, later.

**Errors stay conservative.** `TransportError` only where the frame provably never left; once a QoS 0 frame has been emitted, silence is `Timeout` or `UnknownOutcome`, never a claim that nothing happened. A retransmission carries the **remaining** TTL and never restarts a deadline, or a command can execute long after its caller stopped waiting.

**Per interaction:** state converges by snapshot; queries and idempotent commands retry freely; non-repeatable commands retry only against a durable idempotency store and otherwise end in `UnknownOutcome` stated plainly; ordinary events are best-effort; audit-grade facts belong to the queue.

**`durable-relay`** is a later, stronger profile: the relay journals a request before acknowledging custody, and only then may a caller forget it. An acknowledgement transfers custody, so it must never be sent before the journal write. It must not quietly become an offline work queue.

One architectural note for the reader who knows the functional-safety world: the black channel treats the entire fieldbus as untrusted transport and puts all responsibility at certified endpoints — the same shape as these caller-owned retries over QoS 0. That tier concluded long ago that you do not trust the middle. This design applies the shape one tier up and — per the AI boundary specification's §11 — never claims to be the tier below.

## 5. Adoption

A site adopting this records, in its own deployment documentation and not merely in a config file: that Source RPC frames cross the Sparkplug boundary opaquely; that boundary inspection of those frames requires Source RPC-aware tooling rather than a standard Sparkplug Host; which peers may be reached across the relay and which methods they expose; and who approved the exception. The relay package refuses to start without an explicit acknowledgement flag naming that decision — the same fail-closed instinct the rest of the family uses for consequential grants.

## 6. Milestone

One, and it does not begin until a paying deployment has named the need, per the projection spec's own rule. Its exit criterion: two Edge Nodes calling each other through the relay across a broker, with a deliberately lost frame and a relay restart in the middle, ending in the same answers a direct call would have produced — or in `UnknownOutcome` said plainly where that is the truth.
