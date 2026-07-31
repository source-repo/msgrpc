# Commands

Most RPC libraries make it easy to call a function. Rather fewer distinguish *the call failed* from *I lost the answer to a command that may well have run*, and on a plant that is the distinction that matters: retrying a read costs a round trip, and retrying a start costs a second start.

### The honest statement

> **Delivery and execution are at least once, unless the method is guarded by a durable idempotency store.**

That is true of every RPC system without such a store; the difference is whether it is written down. QoS 1 is at-least-once by definition, the in-memory duplicate cache dies with the process that holds it, and a server can change something physical and then fail before it says so.

### What a method does to the world

```typescript
class Pump {
    @rpc({ semantics: 'query' })                    async pressure() { … }
    @rpc({ semantics: 'idempotent-command' })       async setSetpoint(bar: number) { … }
    @rpc({ semantics: 'non-repeatable-command' })   async dispense() { … }
}
```

| semantics | repeating it | example |
| --- | --- | --- |
| `query` | costs a round trip | a reading, a status, a list |
| `idempotent-command` | leaves the same state as doing it once | `setSetpoint(1200)`, `close()` |
| `non-repeatable-command` | does it again | `dispense()`, `advanceBatch()` |

It is part of the contract, not a comment: `extract` reads it out of the decorator, `describe()` reports it, and `check` calls it a **breaking change** when a method becomes more dangerous to repeat than the version a caller was built against. Every type still lines up in that case, which is exactly why nothing else would catch it.

Undeclared stays undeclared. The library will not guess that a method is safe to repeat.

### Not knowing

```typescript
try {
    await pump.dispense()
} catch (e) {
    if (e instanceof RpcError && e.code === 'UnknownOutcome') {
        // The request went out. It may have run. Go and look before sending it again.
    }
}
```

`TransportError` now means the request never left - a failed encode, a closed link, a broker that refused the publish - so the command certainly did not run. `UnknownOutcome` means it did leave and nothing came back. `Timeout` is the same uncertainty with a more specific cause, and should be read the same way for a command.

### Running a command once

Give a server somewhere durable to record what a non-repeatable command did, and a redelivery after a crash is answered from the record instead of run again:

```typescript
const server = new RpcServer({ idempotency: myRedisStore })      // RpcIdempotencyStore
```

The library ships the interface and a `MemoryIdempotencyStore` for tests - deliberately no database, and the memory one is not an answer to the problem, since it dies exactly when the durable one would earn its keep.

The store is consulted only for `non-repeatable-command` methods, so reads pay nothing. What it records is keyed by the **request id**, which makes a redelivered packet the same command. An operator pressing the button again is a *different* request, and only the caller knows the two are one intent:

```typescript
await pump.$with({ idempotencyKey: workOrder }).dispense()
```

`$with` returns another proxy for the same instance, so the key never leaks into calls that did not ask for it. The outcome is recorded **before** the answer is sent - the other order leaves a window where the caller has the result and the store does not.

`$with` also takes `timeoutMs`, a per-call override of the client's `callTimeout` that becomes the transmitted ttl, so what the far end is told is exactly what this caller will do. `0` disables both the local timer and the ttl - for a long poll whose bound lives on the server side - and it genuinely disables them: a zero timeout used to omit the ttl correctly while still arming a `setTimeout(…, 0)`, which is not "never" but "next tick".

A store that cannot be reached refuses the command with `UnknownOutcome` rather than running it. Failing open would turn an unreachable guard into exactly the double execution it was installed to prevent.

### Calls that overlap

Calls run side by side, which is right for stateless services and unrelated devices, and wrong for one long-lived object holding mutable state - where

```
setMode('manual'); start(); setSetpoint(80)
```

from one caller can interleave with `stop(); setMode('automatic')` from another and leave a machine in a combination neither asked for.

```typescript
@rpcNamespace('cell', { execution: 'serial' })                     // one call at a time
class Cell { … }

server.exposeClassInstance(fleet, 'fleet', {                       // one call at a time per device
    execution: (call) => String(call.params[0])
})
```

A key function is how a server fronting many devices keeps each device's commands in order without serialising itself behind the slowest of them.

**When nothing is declared, the default is graded by the semantics.** A method declaring `idempotent-command` or `non-repeatable-command` serialises per instance — command state is exactly what interleaving corrupts, and the contract already names which methods command — while a `query` and an undeclared method run as they arrive. Guessing that an unmarked method is safe to serialise would be the same mistake as guessing it is safe to repeat, so undeclared is left alone. A re-entrant design — a serialised method calling back into its own queue over RPC — declares `execution: 'parallel'` and does its own coordination; the deadline being read after the queue wait means such a pair unwinds as a Timeout and a refusal rather than hanging forever, but it is still a design to opt out of, not to leave to luck.

The queue is also where the deadline is read: a command that waited behind others until its caller gave up is refused rather than run late.

**The mailbox is bounded.** At most 100 calls wait in one queue — `mailbox` on the namespace or the expose options changes the number — and an arrival past the bound is refused `Busy` rather than queued, because a caller told `Busy` now can decide something, where one whose call dies in a backlog later cannot. And a setpoint-shaped command can declare `@rpc({ semantics: 'idempotent-command', conflate: true })`: while such a call waits in its queue, a newer call to the same method replaces it, and the replaced caller is answered `Superseded` immediately — only the newest value matters, and executing a backlog of stale setpoints serves nobody. Only an idempotent command may conflate; the combination is enforced when the instance is exposed, because dropping one of two queued non-repeatable commands would silently skip work a caller was promised.

### Not built

- **Cancellation.** A deadline bounds a call, but nothing tells a running method to stop. Doing it properly needs a cancel frame *and* handler cooperation, and a library cannot supply the second.
- **`online-only` delivery.** Now that the broker's expiry is the caller's own timeout, a request for an absent peer already dies when the caller stops waiting; failing immediately instead would save the wait and little else.
- **A per-call invocation context.** Handlers are plain methods, and threading a context through every signature costs more than it returns. The store gets the full invocation; a method that needs its own idempotency has the arguments it was called with.
- **Global admission limits.** Concurrency caps and message-size bounds are about availability rather than correctness, and belong with a production profile.

## Errors

A call rejects with an `RpcError` carrying a `code`, the remote `message`, and the remote stack in `remoteStack` when the peer sent one.

```typescript
import { RpcError } from '@source-repo/rpc'

try {
    await calculator.square(3)
} catch (e) {
    if (e instanceof RpcError) console.log(e.code, e.message, e.remoteStack)
}
```

| code | meaning |
| --- | --- |
| `Exception` | the exposed method threw |
| `MethodNotFound` | the instance exists but the method is not exposed |
| `ClassNotFound` | nothing is exposed under that name |
| `Timeout` | no response within `callTimeout`, or the server refused to run it that late |
| `TransportError` | the link dropped, or the message could not be encoded or sent |
| `Unauthorized` | the caller is not authenticated and the server requires it |
| `Forbidden` | the caller is authenticated but not permitted this call |
| `InvalidParams` | the arguments do not match the schema for that method |
| `IncompatibleVersion` | the caller's contract cannot be served by this one |
| `UnknownOutcome` | the request was sent and its fate is not known - it may have run |

**A method can choose its own code.** Throwing an error whose `code` is one of the nine above — `Unauthorized`, `Forbidden`, `InvalidParams`, `IncompatibleVersion`, `ClassNotFound`, `MethodNotFound`, `TransportError`, `Timeout`, `UnknownOutcome` — sends that code rather than `Exception`:

```typescript
@rpc async writeSetpoint(value: number) {
    if (!this.permitted) throw Object.assign(new Error('this cell is in local mode'), { code: 'Forbidden' })
    if (await this.downstream.timedOut()) throw Object.assign(new Error('the drive did not answer'), { code: 'UnknownOutcome' })
}
```

The list is an allow-list, so an ordinary Node error carrying `code: 'ENOENT'` stays `Exception` rather than becoming a protocol code that means something else. `UnknownOutcome` is the one worth reaching for: it is the honest reply from a gateway whose own downstream call was lost, where inventing a result and reporting a plain exception would both claim more than is known.

**A call that timed out will not run afterwards.** Every request carries the time its caller will still wait, so a server that reaches the method late answers `Timeout` instead of running it, and an MQTT broker is given the same deadline as its message expiry rather than a longer one of its own. Without that, a request queued for a restarting server arrives after the operator has already been told the call failed and acted on it - which for a read is wasted work and for `start pump` is a machine moving when nobody expects it to.

It is a duration on the wire rather than a moment, so no two peers ever have to agree what time it is - a browser page's clock belongs to whoever is sitting at it. `refuseExpiredCalls` on the server handler turns the refusal off.
