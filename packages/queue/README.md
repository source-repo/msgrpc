# @source-repo/queue

A lease-based work queue for [Source RPC](https://github.com/source-repo/rpc) networks. Every-value semantics: work that must not be lost, delivered to one consumer at a time, with leases, retries, dead letters, and capacity that refuses rather than drops. The same program runs unchanged over socket.io and MQTT 5, because the queue is an ordinary Source RPC service — the transport never shows through the contract.

This is the ecosystem's first tool node: its own package with its own version, deliberately *not* bound to the rpc/rpc-cli versions-together rule, built against the library's public APIs only.

## The one paragraph to read before trusting it

**A work-queue handler may run more than once.** A lease can expire after the handler changed the world but before completion reached the queue. Task IDs and lease tokens protect queue state; they do not make arbitrary external side effects exactly once. Handlers that cause non-repeatable effects need domain idempotency or a transactional design of their own.

## When not to use it

Source RPC's MQTT `sharedGroup` replicas already load-balance synchronous request/reply across identical workers, with the answer returning to the caller. Reach for the queue when the work outlives the producer's connection, when it must survive a busy moment as backlog, or when it needs retries and a dead-letter verdict. Reach for the observable component when only the latest value matters — a queue that conflates is not a queue. History and replay belong to neither; that is a future historian's job.

## Serving a queue

```typescript
import { RpcServer } from '@source-repo/rpc'
import { exposeWorkQueue, MemoryWorkQueueStore } from '@source-repo/queue'

const server = new RpcServer({ name: 'queueServer', transports: [{ port: 7843 }] })
const queue = exposeWorkQueue<AnalyzeTask>(server, 'analysisJobs', {
    store: new MemoryWorkQueueStore(),
    capacity: { maxReadyTasks: 10_000, maxReadyBytes: 64 * 1024 * 1024, maxPayloadBytes: 1024 * 1024 },
    lease: { defaultMs: 30_000, maximumMs: 5 * 60_000 },
    retry: { maxAttempts: 5, delayMs: 1000, maxDelayMs: 30_000, jitter: 0.2 }
})
```

The service runs `parallel` — a long-polling acquire must never serialise the queue against its own consumers — and its live metrics ride an observable component, coalesced to four snapshots a second at most. `stats()` stays the authoritative point-in-time answer.

## Producing and consuming

```typescript
import { connectWorkQueue, QueueFullError } from '@source-repo/queue'

const queue = await connectWorkQueue<AnalyzeTask>(client, 'analysisJobs', 'queueServer')

// enqueue() resolves when the queue accepted the task, not when a worker completed it.
const receipt = await queue.enqueue(task, { deduplicationKey: 'order-1234', ttlMs: 60_000 })

const consumer = await queue.consume(
    async (task, context) => {
        // context.signal aborts when the lease is known lost; a cooperative handler stops.
        await analyze(task)
    },
    { consumerId: 'analyzer-1', concurrency: 2 }
)
```

One acquire loop per concurrency slot, and a slot never holds two tasks — that is the whole of consumer backpressure. There is no prefetch. A faster worker simply asks more often.

When the queue is full, `enqueue` throws `QueueFullError`. **Reject-new is the only capacity policy**: the queue never silently drops old work or new. Drop-oldest, conflation and downsampling are telemetry policies, and telemetry belongs in component state, filtered at the source.

## What the memory store loses

`MemoryWorkQueueStore` is the reference implementation, and it is honest about being one: `durable: false`, `shared: false`. **Every ready task, every leased task, every delayed retry, every dead letter, and every deduplication identity is lost when the process ends.** A producer enqueueing the same task ID after a restart gets a fresh acceptance, not a duplicate receipt — the identity window died with the process. Use it for work that can be re-created by its producers, for development, and for conformance; anything that must survive a restart needs a durable store adapter in its own package, implementing the atomicity requirements documented on `WorkQueueStore`.

## Identities that survive uncertainty

An answer can be lost after the state changed, so both mutating requests carry stable identities. An `enqueue` retried under its `taskId` is answered with the original receipt, marked `duplicate`. An `acquire` retried under its `acquireId` returns the same lease rather than leasing a second task. Completion, failure and renewal carry the lease token, and a stale token is answered `lease-lost` — the token fences queue state, wherever the frame travelled.

## Tasks carry their context

A task may carry queued context — `{ mode: 'snapshot' }` with values captured by the producer at enqueue time, travelling verbatim to the handler — and an owner fence naming the component authority generation it was submitted under. Both are delivered on the lease (`context.lease`). A `{ mode: 'latest' }` task is resolved by the consumer against the source host's `$context` when execution starts, and delivered to the handler as `context.resolvedContext` - an unresolvable `latest` fails the task through the ordinary retry path rather than running the handler context-blind. The owner fence travels with the task and gains durable enforcement from the topology records.

## Authorization

The queue adds no authorization machinery of its own — it composes with the server's ordinary `authorize`, which is the point. Producer, consumer and admin rights separate cleanly by method name: `enqueue` is the producer surface; `acquire`, `complete`, `fail` and `renew` the consumer surface; `listDeadLetters`, `retryDeadLetter` and `discardDeadLetter` the admin surface. `consumerId` is a claim, trusted only as far as the transport identity behind it. Dead-letter listing is paged and bounded; failure summaries are truncated before storage.
