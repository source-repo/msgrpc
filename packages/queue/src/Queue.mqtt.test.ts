import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { connectAsync } from 'mqtt'
import { MqttTransport, RpcClient, RpcServer } from '@source-repo/rpc'
import { QueueFullError, connectWorkQueue } from './Client.js'
import { exposeWorkQueue } from './Service.js'
import type { WorkQueueProtocol } from './Contract.js'

/**
 * The same queue semantics over MQTT 5, which is the transport-parity half of the conformance
 * suite: the wrapper and service are the ones the socket.io tests already passed, so anything
 * that fails here is the transport showing through the contract - which is exactly what must not
 * happen.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

/** Short session expiry: names are unique per run, so lingering sessions would only pile up. */
const TEST_SESSION_EXPIRY = 10

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

const QUICK = { lease: { defaultMs: 1500, maximumMs: 10_000 }, retry: { maxAttempts: 2, delayMs: 20, jitter: 0 }, waitMaximumMs: 2000 }

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    const available = await brokerAvailable()
    // Skipping is right on a laptop with no broker and wrong everywhere it matters: a suite that
    // reports itself green having quietly run none of its MQTT tests is worse than one that fails,
    // because it is the version somebody trusts. CI sets this, so the skip cannot happen unnoticed.
    if (!available && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
    t.context = { skipped: !available }
})

const skipWithoutBroker = (t: { context: Context; pass: (message?: string) => void }) => {
    if (t.context.skipped) {
        t.pass('no broker reachable, skipped')
        return true
    }
    return false
}

const rig = async (label: string) => {
    const server = new RpcServer({ name: peer(`queue-${label}`), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    const service = exposeWorkQueue<unknown>(server, 'jobs', QUICK)
    const client = new RpcClient(undefined, {
        name: peer(`worker-${label}`),
        transport: new MqttTransport(peer(`worker-${label}`), BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer(`queue-${label}`)
    })
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

test.serial('mqtt: enqueue, consume, complete - the same program as every other transport', async (t) => {
    if (skipWithoutBroker(t)) return
    const { queue, dispose } = await rig('roundtrip')

    const done: string[] = []
    const bytes = new Uint8Array([7, 8, 9, 250])
    await queue.enqueue({ job: 'first' })
    await queue.enqueue(bytes)
    const consumer = await queue.consume(
        async (task) => {
            done.push(task instanceof Uint8Array ? `bytes:${[...task].join(',')}` : (task as { job: string }).job)
        },
        { consumerId: 'worker-1', waitMs: 500 }
    )
    await waitFor(() => done.length === 2)
    t.true(done.includes('first'))
    t.true(done.includes('bytes:7,8,9,250'), 'opaque bytes survive MQTT untouched - msgpack carries them as bytes')

    await consumer.close()
    await dispose()
})

test.serial('mqtt: a failing handler dead-letters after its attempts, exactly as everywhere else', async (t) => {
    if (skipWithoutBroker(t)) return
    const { queue, service, dispose } = await rig('poison')

    await queue.enqueue({ job: 'poison' })
    const attempts: number[] = []
    const consumer = await queue.consume(
        async (_task, context) => {
            attempts.push(context.attempt)
            throw new Error('cannot be done here either')
        },
        { consumerId: 'worker-1', waitMs: 500 }
    )
    await waitFor(async () => (await queue.stats()).deadLettered === 1, 15_000)
    t.deepEqual(attempts, [1, 2])
    t.is((await service.listDeadLetters()).entries[0]?.failure, 'cannot be done here either')

    await consumer.close({ drain: false, timeoutMs: 2000 })
    await dispose()
})

test.serial('mqtt: the lease fences a stale completion across the broker', async (t) => {
    if (skipWithoutBroker(t)) return
    const { queue, client, dispose } = await rig('fence')

    await queue.enqueue({ job: 'fenced' }, { taskId: 'fenced-task' })
    const protocol = await client.proxy<WorkQueueProtocol<unknown>>('jobs')
    const first = await protocol.acquire({ acquireId: randomUUID(), consumerId: 'w1', leaseMs: 1200, waitMs: 0 })
    if (first.status !== 'lease') return t.fail('no lease')

    // The lease lapses, the task is redelivered, and the old world's completion is refused.
    await waitFor(async () => {
        const again = await protocol.acquire({ acquireId: randomUUID(), consumerId: 'w2', leaseMs: 5000, waitMs: 0 })
        return again.status === 'lease'
    }, 15_000)
    const stale = await protocol.complete({ taskId: 'fenced-task', leaseToken: first.lease.leaseToken, consumerId: 'w1' })
    t.is(stale.status, 'lease-lost', 'a stale token cannot complete a newer lease, whatever transport carried it')

    await dispose()
})

test.serial('mqtt: full refuses the newcomer over this transport too', async (t) => {
    if (skipWithoutBroker(t)) return
    const server = new RpcServer({ name: peer('queue-full'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY }] })
    await server.ready()
    const service = exposeWorkQueue<unknown>(server, 'jobs', { ...QUICK, capacity: { maxReadyTasks: 1 } })
    const client = new RpcClient(undefined, {
        name: peer('worker-full'),
        transport: new MqttTransport(peer('worker-full'), BROKER_URL, { sessionExpirySeconds: TEST_SESSION_EXPIRY }),
        defaultTarget: peer('queue-full')
    })
    await client.ready()
    const queue = await connectWorkQueue<unknown>(client, 'jobs')

    await queue.enqueue({ n: 1 })
    await t.throwsAsync(queue.enqueue({ n: 2 }), { instanceOf: QueueFullError })

    service.close()
    await client.close()
    await server.close()
})
