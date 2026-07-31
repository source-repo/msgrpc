import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer } from '@source-repo/rpc'
import { QueueFullError, connectWorkQueue, workQueueOver } from './Client.js'
import { WorkQueueService, exposeWorkQueue } from './Service.js'
import type { WorkQueueProtocol } from './Contract.js'

/**
 * The service and the public wrapper, over the two carriers that need no broker: the service
 * instance itself, and socket.io. One suite, two rigs - the point of the typed internal protocol
 * is that the wrapper cannot tell them apart. The MQTT rig lives in Queue.mqtt.test.ts with the
 * broker guard.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

/** Small numbers everywhere: these tests assert transitions, not endurance. */
const QUICK = { lease: { defaultMs: 1500, maximumMs: 10_000 }, retry: { maxAttempts: 2, delayMs: 20, jitter: 0 }, waitMaximumMs: 2000 }

test('in-process: enqueue, consume, complete - and the receipt precedes the work', async (t) => {
    const service = new WorkQueueService<{ job: string }>('jobs', QUICK)
    const queue = workQueueOver<{ job: string }>(service, 'jobs')

    const receipt = await queue.enqueue({ job: 'first' })
    t.false(receipt.duplicate)

    const done: string[] = []
    const consumer = await queue.consume(
        async (task) => {
            done.push(task.job)
        },
        { consumerId: 'worker-1', waitMs: 300 }
    )
    await waitFor(() => done.length === 1)
    t.deepEqual(done, ['first'])
    await waitFor(async () => (await queue.stats()).leased === 0, 2000).catch(() => undefined)
    t.is((await queue.stats()).ready, 0)

    await consumer.close()
    service.close()
})

test('in-process: a failing handler is retried, and the configured attempts dead-letter it', async (t) => {
    const service = new WorkQueueService<{ job: string }>('jobs', QUICK)
    const queue = workQueueOver<{ job: string }>(service, 'jobs')

    const attempts: number[] = []
    await queue.enqueue({ job: 'poison' })
    const consumer = await queue.consume(
        async (_task, context) => {
            attempts.push(context.attempt)
            throw new Error('this task cannot be done')
        },
        { consumerId: 'worker-1', waitMs: 300 }
    )

    await waitFor(async () => (await queue.stats()).deadLettered === 1, 8000)
    t.deepEqual(attempts, [1, 2], 'delivered exactly maxAttempts times, then never again')

    // The admin surface: the dead letter is listed, retried fresh, and the retry is a delivery.
    const page = await service.listDeadLetters()
    t.is(page.entries[0]?.failure, 'this task cannot be done')
    t.is((await service.retryDeadLetter(page.entries[0]!.taskId)).status, 'ok')
    await waitFor(() => attempts.length === 4, 8000)

    await consumer.close({ drain: false, timeoutMs: 1000 })
    service.close()
})

test('in-process: concurrency is the ceiling, and a slot never holds two tasks', async (t) => {
    const service = new WorkQueueService<{ n: number }>('jobs', QUICK)
    const queue = workQueueOver<{ n: number }>(service, 'jobs')

    let inFlight = 0
    let peak = 0
    for (let n = 0; n < 6; n++) await queue.enqueue({ n })
    const consumer = await queue.consume(
        async () => {
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 50))
            inFlight--
        },
        { consumerId: 'worker-1', concurrency: 2, waitMs: 300 }
    )

    await waitFor(async () => (await queue.stats()).ready === 0 && inFlight === 0, 8000)
    t.is(peak, 2, 'backpressure is the slot count, not the backlog size')

    await consumer.close()
    service.close()
})

test('in-process: the faster worker simply asks more often', async (t) => {
    const service = new WorkQueueService<{ n: number }>('jobs', QUICK)
    const queue = workQueueOver<{ n: number }>(service, 'jobs')

    const byWorker = { quick: 0, slow: 0 }
    for (let n = 0; n < 10; n++) await queue.enqueue({ n })
    const quick = await queue.consume(
        async () => {
            byWorker.quick++
            await new Promise((resolve) => setTimeout(resolve, 5))
        },
        { consumerId: 'quick', waitMs: 300 }
    )
    const slow = await queue.consume(
        async () => {
            byWorker.slow++
            await new Promise((resolve) => setTimeout(resolve, 120))
        },
        { consumerId: 'slow', waitMs: 300 }
    )

    await waitFor(async () => byWorker.quick + byWorker.slow === 10, 8000)
    t.true(byWorker.quick > byWorker.slow, `no fairness algorithm, just appetite: quick ${byWorker.quick}, slow ${byWorker.slow}`)

    await quick.close()
    await slow.close()
    service.close()
})

test('in-process: full is an error with a name, and the queue never silently drops', async (t) => {
    const service = new WorkQueueService<{ n: number }>('jobs', { ...QUICK, capacity: { maxReadyTasks: 1 } })
    const queue = workQueueOver<{ n: number }>(service, 'jobs')

    await queue.enqueue({ n: 1 })
    const refusal = await t.throwsAsync(queue.enqueue({ n: 2 }), { instanceOf: QueueFullError })
    t.is((refusal as QueueFullError).queue, 'jobs')
    t.is((await queue.stats()).ready, 1, 'the old task is still there - reject-new means the new one was the cost')
    service.close()
})

test('in-process: an empty long poll answers at its bound, and the loop starts a fresh identity', async (t) => {
    const service = new WorkQueueService<{ n: number }>('jobs', QUICK)
    const started = Date.now()
    const empty = await service.acquire({ acquireId: randomUUID(), consumerId: 'patient', leaseMs: 0, waitMs: 400 })
    t.is(empty.status, 'empty')
    const waited = Date.now() - started
    t.true(waited >= 350 && waited < 1500, `the bound is the answer time: ${waited} ms`)
    service.close()
})

test('in-process: enqueue while a long poll is parked wakes it before the bound', async (t) => {
    const service = new WorkQueueService<{ n: number }>('jobs', QUICK)
    const queue = workQueueOver<{ n: number }>(service, 'jobs')

    const started = Date.now()
    const winner = service.acquire({ acquireId: randomUUID(), consumerId: 'early-bird', leaseMs: 0, waitMs: 1900 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await queue.enqueue({ n: 1 })
    const result = await winner
    t.is(result.status, 'lease')
    t.true(Date.now() - started < 1500, 'the wake beat the bound')
    service.close()
})

test('in-process: queued context and the owner fence travel with the task', async (t) => {
    const service = new WorkQueueService<{ job: string }>('jobs', QUICK)
    const queue = workQueueOver<{ job: string }>(service, 'jobs')

    await queue.enqueue(
        { job: 'contextual' },
        {
            context: { mode: 'snapshot', captured: { workOrder: 'WO-17' } },
            ownerFence: { peer: 'plant-a', namespace: 'oven', epoch: 'e1', generation: 3 }
        }
    )
    let seen: unknown
    let fence: unknown
    const consumer = await queue.consume(
        async (_task, context) => {
            seen = context.lease.context
            fence = context.lease.ownerFence
        },
        { consumerId: 'worker-1', waitMs: 300 }
    )
    await waitFor(() => seen !== undefined)
    t.deepEqual(seen, { mode: 'snapshot', captured: { workOrder: 'WO-17' } })
    t.deepEqual(fence, { peer: 'plant-a', namespace: 'oven', epoch: 'e1', generation: 3 })

    await consumer.close()
    service.close()
})

// ---------------------------------------------------------------- socket.io

const rig = async (port: number, options: ConstructorParameters<typeof RpcServer>[0] extends infer O ? Partial<O & object> : never = {}) => {
    const server = new RpcServer({ name: peer(`queue${port}`), transports: [{ port }], ...options })
    await server.ready()
    const service = exposeWorkQueue<unknown>(server, 'jobs', QUICK)
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`worker${port}`), defaultTarget: peer(`queue${port}`) })
    await client.ready()
    const queue = await connectWorkQueue<unknown>(client, 'jobs')
    return {
        server,
        service,
        client,
        queue,
        dispose: async () => {
            service.close()
            await client.close()
            await server.close()
        }
    }
}

test('socket.io: the same program runs unchanged, opaque bytes and all', async (t) => {
    const { queue, dispose } = await rig(3931)

    // An opaque payload the framework never decodes: msgpack carries the bytes as bytes.
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252])
    await queue.enqueue(bytes)
    let received: Uint8Array | undefined
    const consumer = await queue.consume(
        async (task) => {
            received = task as Uint8Array
        },
        { consumerId: 'worker-1', waitMs: 300 }
    )
    await waitFor(() => received !== undefined)
    t.deepEqual([...received!], [0, 1, 2, 250, 251, 252], 'the payload round-trips untouched')

    await consumer.close()
    await dispose()
})

test('socket.io: metrics ride the component channel, and stats stays authoritative', async (t) => {
    const { queue, dispose } = await rig(3932)

    const metrics = await queue.metrics()
    await queue.enqueue({ n: 1 })
    await queue.enqueue({ n: 2 })
    await waitFor(() => metrics.getSnapshot().state.ready === 2, 5000)
    t.is(metrics.getSnapshot().props.name, 'jobs')
    t.false(metrics.getSnapshot().props.store.durable, 'the memory store declares its loss out loud')

    const stats = await queue.stats()
    t.is(stats.ready, 2)

    await metrics.close()
    await dispose()
})

test('socket.io: producer, consumer and admin rights separate by method through authorize', async (t) => {
    const producerName = peer('producer3933')
    const workerName = peer('consumer3933')
    const consumerMethods = new Set(['acquire', 'complete', 'fail', 'renew'])
    const adminMethods = new Set(['listDeadLetters', 'retryDeadLetter', 'discardDeadLetter'])
    const server = new RpcServer({
        name: peer('queue3933'),
        transports: [{ port: 3933 }],
        // The queue's authorization is the server's ordinary authorize - the helper composes with
        // it rather than replacing it, which is the whole of the rigidity clause here.
        authorize: (context) => {
            if (context.instanceName !== 'jobs') return true
            if (context.method === 'enqueue') return context.source === producerName
            if (consumerMethods.has(context.method)) return context.source === workerName
            if (adminMethods.has(context.method)) return false
            return true
        }
    })
    await server.ready()
    const service = exposeWorkQueue<unknown>(server, 'jobs', QUICK)

    const producer = new RpcClient('http://localhost:3933', { name: producerName, defaultTarget: peer('queue3933') })
    const worker = new RpcClient('http://localhost:3933', { name: workerName, defaultTarget: peer('queue3933') })
    await producer.ready()
    await worker.ready()
    const producing = await connectWorkQueue<{ n: number }>(producer, 'jobs')
    const working = await connectWorkQueue<{ n: number }>(worker, 'jobs')

    await producing.enqueue({ n: 1 })
    const refusedEnqueue = await t.throwsAsync(working.enqueue({ n: 2 }))
    t.regex(String(refusedEnqueue?.message), /Forbidden/, 'a worker does not produce')

    const workerProtocol = await worker.proxy<WorkQueueProtocol<{ n: number }>>('jobs')
    const producerProtocol = await producer.proxy<WorkQueueProtocol<{ n: number }>>('jobs')
    const refusedAcquire = await t.throwsAsync(producerProtocol.acquire({ acquireId: randomUUID(), consumerId: 'p', leaseMs: 0, waitMs: 0 }))
    t.regex(String(refusedAcquire?.message), /Forbidden/, 'a producer does not consume')
    const refusedAdmin = await t.throwsAsync(workerProtocol.listDeadLetters({}))
    t.regex(String(refusedAdmin?.message), /Forbidden/, 'admin is its own grant')

    const acquired = await workerProtocol.acquire({ acquireId: randomUUID(), consumerId: 'w', leaseMs: 0, waitMs: 0 })
    t.is(acquired.status, 'lease', 'the worker consumes what the producer enqueued')

    service.close()
    await producer.close()
    await worker.close()
    await server.close()
})

test('socket.io: the memory store loses everything with its process, and says so', async (t) => {
    const { queue, service, client, server } = await rig(3934)
    await queue.enqueue({ n: 1 }, { taskId: 'survivor?' })
    t.is((await queue.stats()).ready, 1)

    // The restart: same peer name, same port, a fresh service over a fresh memory store.
    service.close()
    await server.close()
    const revived = new RpcServer({ name: peer('queue3934'), transports: [{ port: 3934 }] })
    const revivedService = exposeWorkQueue<unknown>(revived, 'jobs', QUICK)
    await revived.ready()

    await waitFor(async () => (await queue.stats().catch(() => undefined))?.ready === 0, 10_000)
    const receipt = await queue.enqueue({ n: 1 }, { taskId: 'survivor?' })
    t.false(receipt.duplicate, 'even the identity window died with the process - restart loss is total, as documented')

    revivedService.close()
    await client.close()
    await revived.close()
})

test('socket.io: losing the server mid-poll is trouble, not a crash, and close stays bounded', async (t) => {
    const { queue, service, client, server } = await rig(3935)

    const troubles: unknown[] = []
    const consumer = await queue.consume(async () => undefined, { consumerId: 'worker-1', waitMs: 500, retryDelayMs: 100 })
    consumer.on('trouble', (error) => troubles.push(error))
    await new Promise((resolve) => setTimeout(resolve, 100))

    service.close()
    await server.close()
    await waitFor(() => troubles.length > 0, 10_000)
    t.true(troubles.length > 0, 'the operational failure surfaced on the trouble channel, away from any handler')

    await consumer.close({ timeoutMs: 2000 })
    t.true(consumer.closed)
    await client.close()
})
