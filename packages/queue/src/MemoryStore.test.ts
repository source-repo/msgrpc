import test from 'ava'
import { MemoryWorkQueueStore } from './MemoryStore.js'
import type { StoredWorkTask } from './Store.js'
import type { WorkQueueCapacity, WorkQueueRetryPolicy } from './Contract.js'

/**
 * The state machine, exercised where it lives. Times are passed in, never read from the clock
 * mid-assertion, so every transition here is deterministic - the jitter is zeroed for the same
 * reason.
 */

const LIMITS: WorkQueueCapacity = { maxReadyTasks: 5, maxReadyBytes: 1000, maxPayloadBytes: 400, maxHeaders: 4, maxHeaderBytes: 256 }
const RETRY: WorkQueueRetryPolicy = { maxAttempts: 3, delayMs: 100, maxDelayMs: 1000, jitter: 0 }

const task = (taskId: string, over: Partial<StoredWorkTask<unknown>> = {}): StoredWorkTask<unknown> => ({
    taskId,
    payload: { work: taskId },
    payloadBytes: 20,
    headers: {},
    priority: 0,
    acceptedAt: 1000,
    ...over
})

test('FIFO within a priority, and a higher priority always first', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('routine-1'), LIMITS, 1000)
    await store.enqueue('q', task('routine-2'), LIMITS, 1001)
    await store.enqueue('q', task('urgent', { priority: 5 }), LIMITS, 1002)

    const first = await store.acquire('q', { acquireId: 'a1', consumerId: 'c', leaseMs: 5000, now: 2000 })
    const second = await store.acquire('q', { acquireId: 'a2', consumerId: 'c', leaseMs: 5000, now: 2000 })
    const third = await store.acquire('q', { acquireId: 'a3', consumerId: 'c', leaseMs: 5000, now: 2000 })
    t.is(first.status === 'lease' ? first.taskId : '', 'urgent', 'priority beats arrival')
    t.is(second.status === 'lease' ? second.taskId : '', 'routine-1', 'FIFO within the priority')
    t.is(third.status === 'lease' ? third.taskId : '', 'routine-2')
})

test('a duplicate taskId or deduplication key answers with the original receipt', async (t) => {
    const store = new MemoryWorkQueueStore()
    const original = await store.enqueue('q', task('once', { deduplicationKey: 'order-7' }), LIMITS, 1000)
    t.deepEqual(original, { status: 'accepted', acceptedAt: 1000, duplicate: false })

    const byId = await store.enqueue('q', task('once'), LIMITS, 2000)
    t.deepEqual(byId, { status: 'accepted', acceptedAt: 1000, duplicate: true }, 'the original acceptance time is the answer')
    const byKey = await store.enqueue('q', task('other', { deduplicationKey: 'order-7' }), LIMITS, 2000)
    t.deepEqual(byKey, { status: 'accepted', acceptedAt: 1000, duplicate: true })

    // The identity window is a window: past it, the same id is a new intent.
    const shortLived = new MemoryWorkQueueStore({ retentionMs: 50 })
    await shortLived.enqueue('q', task('brief'), LIMITS, 1000)
    const later = await shortLived.enqueue('q', task('brief'), LIMITS, 2000)
    t.false(later.status === 'accepted' && later.duplicate, 'a lapsed identity is not a duplicate')
})

test('capacity is reject-new only: task count, backlog bytes, and payload size', async (t) => {
    const store = new MemoryWorkQueueStore()
    for (let i = 0; i < 5; i++) t.is((await store.enqueue('q', task(`fill-${i}`), LIMITS, 1000)).status, 'accepted')
    t.is((await store.enqueue('q', task('sixth'), LIMITS, 1000)).status, 'full', 'maxReadyTasks binds')

    const bytes = new MemoryWorkQueueStore()
    await bytes.enqueue('q', task('big-1', { payloadBytes: 400 }), LIMITS, 1000)
    await bytes.enqueue('q', task('big-2', { payloadBytes: 400 }), LIMITS, 1000)
    t.is((await bytes.enqueue('q', task('big-3', { payloadBytes: 400 }), LIMITS, 1000)).status, 'full', 'maxReadyBytes binds')

    t.is((await store.enqueue('q', task('vast', { payloadBytes: 500 }), LIMITS, 1000)).status, 'full', 'maxPayloadBytes binds')
})

test('an acquire retried under its id returns the same lease, and one task never has two live tokens', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('only'), LIMITS, 1000)

    const won = await store.acquire('q', { acquireId: 'lost-answer', consumerId: 'c1', leaseMs: 5000, now: 2000 })
    const replayed = await store.acquire('q', { acquireId: 'lost-answer', consumerId: 'c1', leaseMs: 5000, now: 2500 })
    t.deepEqual(replayed, won, 'the replay is the same lease, not a second one')

    const contender = await store.acquire('q', { acquireId: 'someone-else', consumerId: 'c2', leaseMs: 5000, now: 2500 })
    t.is(contender.status, 'empty', 'the task is leased; nobody else gets it')
})

test('stale tokens are fenced on complete, fail and renew; duplicate completion answers honestly', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('fenced'), LIMITS, 1000)
    const lease = await store.acquire('q', { acquireId: 'a', consumerId: 'c', leaseMs: 1000, now: 2000 })
    if (lease.status !== 'lease') return t.fail('no lease')

    // The lease lapses and the task is redelivered with a fresh token.
    await store.reap('q', 3001, RETRY)
    await store.reap('q', 3200, RETRY)
    const again = await store.acquire('q', { acquireId: 'b', consumerId: 'c2', leaseMs: 1000, now: 3300 })
    if (again.status !== 'lease') return t.fail('no redelivery')
    t.not(again.leaseToken, lease.leaseToken, 'every lease has a fresh token')
    t.is(again.attempt, 2, 'redelivery is a second attempt')

    t.is((await store.complete('q', 'fenced', lease.leaseToken)).status, 'lease-lost', 'the old world cannot complete the new')
    t.is((await store.fail('q', { taskId: 'fenced', leaseToken: lease.leaseToken, failure: 'x', now: 3400 }, RETRY)).status, 'lease-lost')
    t.is((await store.renew('q', { taskId: 'fenced', leaseToken: lease.leaseToken, extensionMs: 1000, now: 3400 })).status, 'lease-lost')

    t.is((await store.complete('q', 'fenced', again.leaseToken)).status, 'ok')
    t.is((await store.complete('q', 'fenced', again.leaseToken)).status, 'already-completed', 'a duplicate completion is idempotent, not an error')
    t.is((await store.complete('q', 'never-was', 'token')).status, 'not-found')
})

test('failures back off, and the configured attempt count dead-letters instead of delivering forever', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('poison'), LIMITS, 1000)

    let now = 2000
    for (let attempt = 1; attempt <= 3; attempt++) {
        await store.reap('q', now, RETRY)
        const lease = await store.acquire('q', { acquireId: `a${attempt}`, consumerId: 'c', leaseMs: 1000, now })
        if (lease.status !== 'lease') return t.fail(`no delivery on attempt ${attempt}`)
        t.is(lease.attempt, attempt)
        await store.fail('q', { taskId: 'poison', leaseToken: lease.leaseToken, failure: `boom ${attempt}`, now }, RETRY)
        now += 10_000
    }

    await store.reap('q', now, RETRY)
    t.is((await store.acquire('q', { acquireId: 'a4', consumerId: 'c', leaseMs: 1000, now })).status, 'empty', 'a poison task stops being delivered')
    const snapshot = await store.snapshot('q', now)
    t.is(snapshot.deadLettered, 1)

    const page = await store.listDeadLetters('q', {})
    t.is(page.entries[0]?.taskId, 'poison')
    t.is(page.entries[0]?.attempts, 3)
    t.is(page.entries[0]?.failure, 'boom 3', 'the last verdict is the one on record')
})

test('a dead letter can be retried fresh or discarded, and only while it is dead', async (t) => {
    const store = new MemoryWorkQueueStore()
    const impatient: WorkQueueRetryPolicy = { maxAttempts: 1, delayMs: 0, jitter: 0 }
    await store.enqueue('q', task('doomed'), LIMITS, 1000)
    const lease = await store.acquire('q', { acquireId: 'a', consumerId: 'c', leaseMs: 1000, now: 2000 })
    if (lease.status !== 'lease') return t.fail('no lease')
    await store.fail('q', { taskId: 'doomed', leaseToken: lease.leaseToken, failure: 'once was enough', now: 2100 }, impatient)

    t.is((await store.retryDeadLetter('q', 'doomed', 3000)).status, 'ok')
    const revived = await store.acquire('q', { acquireId: 'b', consumerId: 'c', leaseMs: 1000, now: 3100 })
    t.is(revived.status === 'lease' ? revived.attempt : 0, 1, 'the operator overruled history, so the counter restarts')

    t.is((await store.retryDeadLetter('q', 'doomed', 3200)).status, 'not-found', 'a leased task is not a dead letter')
    t.is((await store.discardDeadLetter('q', 'doomed')).status, 'not-found')
})

test('TTL binds the start of work: before acquire, and again after a backoff', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('brief', { expiresAt: 3000 }), LIMITS, 1000)
    t.is((await store.acquire('q', { acquireId: 'late', consumerId: 'c', leaseMs: 1000, now: 3500 })).status, 'empty', 'a lapsed task is never started')
    t.is((await store.snapshot('q', 3500)).expired, 1)

    // A delayed task whose TTL lapses during its backoff expires rather than returning to ready.
    await store.enqueue('q', task('waning', { expiresAt: 5000 }), LIMITS, 4000)
    const lease = await store.acquire('q', { acquireId: 'a', consumerId: 'c', leaseMs: 500, now: 4100 })
    if (lease.status !== 'lease') return t.fail('no lease')
    await store.fail('q', { taskId: 'waning', leaseToken: lease.leaseToken, failure: 'try later', now: 4200 }, { maxAttempts: 3, delayMs: 2000, jitter: 0 })
    await store.reap('q', 7000, RETRY)
    t.is((await store.acquire('q', { acquireId: 'b', consumerId: 'c', leaseMs: 500, now: 7000 })).status, 'empty', 'its later never came')
    t.is((await store.snapshot('q', 7000)).expired, 2)
})

test('byte accounting follows the task through its states, and the snapshot counts honestly', async (t) => {
    const store = new MemoryWorkQueueStore()
    await store.enqueue('q', task('counted', { payloadBytes: 100 }), LIMITS, 1000)
    t.is((await store.snapshot('q', 1000)).readyBytes, 100)

    const lease = await store.acquire('q', { acquireId: 'a', consumerId: 'c', leaseMs: 1000, now: 2000 })
    if (lease.status !== 'lease') return t.fail('no lease')
    t.is((await store.snapshot('q', 2000)).readyBytes, 0, 'a leased task is not backlog')

    await store.fail('q', { taskId: 'counted', leaseToken: lease.leaseToken, failure: 'x', now: 2100 }, RETRY)
    t.is((await store.snapshot('q', 2100)).delayed, 1)
    await store.reap('q', 2500, RETRY)
    const requeued = await store.snapshot('q', 2500)
    t.is(requeued.ready, 1)
    t.is(requeued.readyBytes, 100, 'requeueing restores the backlog accounting')
    t.is(requeued.oldestReadyAgeMs, 1500, 'age is measured from acceptance, which is when the caller started waiting')
})

test('dead-letter listing pages by cursor', async (t) => {
    const store = new MemoryWorkQueueStore()
    const impatient: WorkQueueRetryPolicy = { maxAttempts: 1, delayMs: 0, jitter: 0 }
    for (let i = 0; i < 5; i++) {
        await store.enqueue('q', task(`dl-${i}`), LIMITS, 1000 + i)
        const lease = await store.acquire('q', { acquireId: `a${i}`, consumerId: 'c', leaseMs: 1000, now: 2000 + i })
        if (lease.status !== 'lease') return t.fail('no lease')
        await store.fail('q', { taskId: `dl-${i}`, leaseToken: lease.leaseToken, failure: 'no', now: 2100 + i }, impatient)
    }
    const first = await store.listDeadLetters('q', { limit: 2 })
    t.deepEqual(
        first.entries.map((entry) => entry.taskId),
        ['dl-0', 'dl-1']
    )
    const second = await store.listDeadLetters('q', { limit: 2, after: first.next })
    t.deepEqual(
        second.entries.map((entry) => entry.taskId),
        ['dl-2', 'dl-3']
    )
    const last = await store.listDeadLetters('q', { limit: 2, after: second.next })
    t.deepEqual(
        last.entries.map((entry) => entry.taskId),
        ['dl-4']
    )
    t.is(last.next, undefined)
})
