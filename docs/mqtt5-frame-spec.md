# msgrpc over MQTT 5 — frame layout

**Status: implemented.** `MqttTransport` speaks this by default (`protocol: 5`); `protocol: 4`
keeps the older `$`-delimited header for brokers that need it. Verified against a live broker with
vanilla mqtt.js on the far side, in `src/Mqtt5.test.ts`.

Not yet implemented, and independent of the frame layout: shared subscriptions for server replicas
(a deployment subscribes `$share/<group>/...` itself; msgrpc has no option for it yet) and MQTT 5
`sessionExpiryInterval`, which would let a client keep a session without leaving one on the broker
forever.

## Why

Today an outsider wanting to call `plant.writeSetpoint(1200)` must publish, on
`msgrpc/v1/rpc/plantServer`:

```
{"source":"hmi","target":"plantServer","time":1785187832623,"seq":0}$<msgpack>
```

with the msgpack decoding to a doubly-nested envelope, and must know that `type: 'POST'` means
"call", that `path` is the instance name, and that replies correlate by `payload.id` on
`msgrpc/v1/rpc/hmi`. None of that is discoverable, and in MQTT tooling it renders as an opaque blob.

MQTT 5 has request/response in the protocol: **Response Topic** says where to reply, **Correlation
Data** matches reply to request. Moving to it makes a frame self-describing in any MQTT 5 client
and in standard tooling, and unlocks two things that matter more than interop for control systems:
message expiry and shared subscriptions.

## Topics

| topic | carries | subscribed by |
| --- | --- | --- |
| `<prefix>/req/<peer>` | calls and subscribe/unsubscribe requests | peers that serve |
| `<prefix>/rsp/<peer>` | results and errors | peers that call |
| `<prefix>/evt/<peer>` | events pushed to a subscriber | peers that subscribe to events |
| `<prefix>/presence/<peer>` | retained `online` / `offline` (unchanged) | all |

Requests are on their own topic because **shared subscriptions only make sense there**. Replicas of
a server subscribe `$share/<group>/<prefix>/req/plantServer` and the broker distributes requests
among them. If responses shared that topic they would be load-balanced too, and a reply meant for
one requester would land on a replica instead.

Splitting `rsp` from `evt` costs one subscription and buys least-privilege ACLs: a pure client never
subscribes to `req`, a pure server never subscribes to `evt`.

The default prefix moves `msgrpc/v1` → `msgrpc/v2`. v1 and v2 peers therefore share a broker without
seeing each other, and a bridge peer can run one transport of each during migration.

## Encoding

MsgPack by default, JSON accepted. MsgPack sits between JSON and protobuf on size and parse cost
without a schema toolchain, and has small allocation-light C implementations for constrained
targets — which matters when the fleet includes embedded devices sending a lot of data.

- `contentType` states which is in use: `application/msgpack` or `application/json`.
- `payloadFormatIndicator` is `0` for msgpack, `1` for JSON, so tooling renders payloads correctly.
- **A responder replies in the request's `contentType`.** A JSON-speaking third party gets JSON
  back without negotiating anything, and msgrpc peers stay on msgpack throughout.

## User properties

All msgrpc control fields are prefixed `mr-`, so a broker or gateway that injects its own user
properties (`clientid`, `username`, `peerhost` and similar) cannot be mistaken for one of ours. The
prefix is kept to three characters because every key is carried in full on every packet, and packet
overhead is a real cost on constrained links.

MQTT permits a user property to repeat. **A frame with any `mr-*` property present more than once is
rejected**, rather than taking the first or last — a duplicated control field is an ambiguity worth
refusing, not resolving.

| property | on | meaning |
| --- | --- | --- |
| `mr-v` | all | frame format version, currently `1` |
| `mr-src` | all | sending peer name |
| `mr-kind` | all | `call` \| `subscribe` \| `unsubscribe` \| `result` \| `error` \| `event` |
| `mr-path` | call, subscribe, event | exposed instance name |
| `mr-method` | call, subscribe | method name |
| `mr-event` | event | event name |
| `mr-code` | error | `RpcErrorCode` |
| `mr-nonce`, `mr-ts`, `mr-sig` | signed frames | replay and signature fields |

## Request

```
topic                    msgrpc/v2/req/plantServer
responseTopic            msgrpc/v2/rsp/hmi
correlationData          <16 random bytes>
contentType              application/msgpack
payloadFormatIndicator   0
messageExpiryInterval    10                       # seconds, from callTimeout
userProperties
  mr-v                   1
  mr-src                 hmi
  mr-kind                call
  mr-path                plant
  mr-method              writeSetpoint
  mr-nonce               <base64>                 # signed frames only
  mr-ts                  1785187832623            # signed frames only
  mr-sig                 <base64>                 # signed frames only
payload                  <msgpack of [1200]>      # the argument array, nothing else
```

`correlationData` replaces the `id` field. `mr-src` is retained even though `responseTopic` implies
it, because identity has to be bound explicitly by the signature rather than inferred from a topic.

For `mr-kind: subscribe` the payload is the argument array holding the event name, e.g. `["alarm"]`,
so every request has one shape.

## Response

```
topic                    msgrpc/v2/rsp/hmi        # whatever responseTopic said
correlationData          <echoed verbatim>
contentType              application/msgpack      # mirrors the request
userProperties
  mr-v                   1
  mr-src                 plantServer
  mr-kind                result
  mr-nonce, mr-ts, mr-sig                         # signed frames only
payload                  <msgpack of 1200>        # the return value, encoded bare
```

Errors keep the shape with `mr-kind: error`, an `mr-code` carrying the `RpcErrorCode`, and a payload
of `{name, message, stack?}`:

```
userProperties   mr-v=1  mr-src=plantServer  mr-kind=error  mr-code=Forbidden
payload          <msgpack of {"name":"RpcError","message":"not permitted to call plant.writeSetpoint"}>
```

Putting the code in a property means an operator can see *why* a call failed in MQTT Explorer
without decoding the payload.

## Event

```
topic            msgrpc/v2/evt/hmi
                 # no correlationData: unsolicited
userProperties
  mr-v           1
  mr-src         plantServer
  mr-kind        event
  mr-path        plant
  mr-event       alarm
  mr-nonce, mr-ts, mr-sig                         # signed frames only
payload          <msgpack of ["high pressure"]>   # the emit argument array
```

## Signing

The signature must cover everything that decides what a frame means and where it goes. Since the
topic now carries the addressing, it is signed rather than a `target` field:

```
signedInput = utf8(JSON.stringify([
    v, topic, src, kind, path, methodOrEvent, correlationDataB64, ts, nonce
])) || payload
```

Fields are signed **positionally by value**, so the `mr-` property naming does not enter the
canonical form and renaming a property later would not silently change what verifies. Absent fields
are `""`; `correlationDataB64` is `""` for events. A JSON array fixes order and escapes values, so
no combination of names can be made to look like a different frame — the property the current
`canonicalSignedBytes` already has. `v` is included so a later format revision cannot be made to
verify under these rules.

`contentType` is deliberately **not** signed: it describes how to read the payload, and the payload
bytes are covered directly. Changing it cannot alter the signed bytes, only make them fail to parse.

Replay protection is unchanged: `mr-nonce` plus the `mr-ts` freshness window, with
`messageExpiryInterval` as defence in depth at the broker.

## Session and delivery

| | MQTT 3.1.1 (today) | MQTT 5 |
| --- | --- | --- |
| server session | `clean: false`, never expires | `cleanStart: false` + `sessionExpiryInterval` |
| client session | `clean: true`, no queueing | `cleanStart: false` + short expiry, so queueing without permanent broker litter |
| stale requests | delivered late, executed | dropped by the broker at `messageExpiryInterval` |
| server HA | not possible | shared subscription on `req` |

`messageExpiryInterval` closes a real hole: today a request queued for a persistent server session
can arrive long after the caller timed out, and the server executes it. It is not a duplicate, so
duplicate suppression does not help.

## What a third party has to implement

A responder serving one namespace:

1. Subscribe `<prefix>/req/<name>`.
2. On a message, read `mr-path` and `mr-method` and decode the payload as an argument array using
   `contentType`.
3. Publish the result to the packet's `responseTopic`, echoing `correlationData`, with
   `mr-kind=result` and the same `contentType`.

No msgrpc framing, no `$` splitting, no nested envelope. A caller is the mirror image. A third party
that prefers JSON simply sets `contentType: application/json` and gets JSON replies.

## Known limits

- **Shared subscriptions suit stateless calls, not event subscriptions.** A client subscribing to
  events registers with whichever replica received the request, and only that replica will emit to
  it. Event fan-out across replicas needs shared state, and is out of scope here.
- **Duplicate suppression stays per-replica.** A QoS 1 redelivery that lands on a different replica
  after one dies would not be recognised as a repeat. Exactly-once across replicas needs a shared
  store.
- **Interop and signing pull against each other.** Full third-party participation on a signed topic
  means publishing this canonicalisation so outsiders can implement it. Cheaper to reserve signing
  for links crossing a trust boundary and rely on broker ACLs elsewhere.
- **Requires an MQTT 5 broker.** EMQX 5 and Mosquitto 2.x are fine; some embedded brokers are
  3.1.1 only.

## Implementation shape

The RPC handlers currently build a `Message` object that is msgpack-encoded and then framed with a
`$` header, so a transport only ever sees opaque bytes. MQTT 5 needs structured access to kind,
path, method, correlation and arguments.

That means introducing a transport-independent `RpcFrame` — `{kind, src, target, path, method,
event, correlation, args | result | error}` — that handlers emit and each transport maps to its own
wire form. socket.io keeps today's `Message` + msgpack + `$` header; MQTT maps to properties plus a
bare payload. It is a refactor of the module chain rather than a patch to the MQTT transport, and it
is the bulk of the work.

## Decisions

| decision | choice | reasoning |
| --- | --- | --- |
| topic split | three: `req` / `rsp` / `evt` | shared subscriptions require `req` alone; the `rsp`/`evt` split buys least-privilege ACLs |
| default encoding | msgpack, JSON accepted, reply mirrors request | between JSON and protobuf on size and parse cost with no schema toolchain, and implementable on tiny embedded devices carrying a lot of data |
| property names | `mr-` prefixed | collision-proof against broker-injected properties; short because every key rides on every packet |
| migration | default prefix → `msgrpc/v2` | v1 and v2 peers coexist on one broker; a bridge peer can run both |
