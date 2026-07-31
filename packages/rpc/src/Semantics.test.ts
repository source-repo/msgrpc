import test from 'ava'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { MemoryIdempotencyStore, RpcClient, RpcServer, rpc, rpcNamespace } from './index.js'
import type { RpcIdempotencyStore, RpcInvocation, StoredRpcOutcome } from './RPC/Idempotency.js'
import type { ServerDescription } from './RPC/Introspection.js'

/**
 * What a call means when the answer does not arrive, and what a server does about calls that
 * overlap. None of this needs a broker: it is all above the transport, which is the point - a
 * command has the same semantics whether it arrived over socket.io or over MQTT.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- what a method says it does

@rpcNamespace('gate')
class Gate extends EventEmitter {
    started = 0
    mode = 'auto'

    @rpc({ semantics: 'query' })
    async readMode() {
        return this.mode
    }
    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: string) {
        this.mode = mode
        return mode
    }
    @rpc({ semantics: 'non-repeatable-command' })
    async startPump() {
        this.started++
        return `start ${this.started}`
    }
    @rpc
    async unmarked() {
        return 'nothing declared'
    }

    /** Held open by the test, so a call can be provably still running when the link goes. */
    release?: () => void
    @rpc({ semantics: 'non-repeatable-command' })
    async startPumpSlowly() {
        await new Promise<void>((resolve) => (this.release = resolve))
        this.started++
        return `start ${this.started}`
    }
}

test('a method says what it does to the world, and describe() passes it on', async (t) => {
    const server = new RpcServer({ name: peer('semanticsServer'), transports: [{ port: 3821 }], exposeIntrospection: true })
    await server.ready()
    server.exposeClassInstance(new Gate())

    const client = new RpcClient('http://localhost:3821', { name: peer('semanticsCaller'), defaultTarget: peer('semanticsServer') })
    await client.ready()
    const introspection = await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')
    const described = await introspection.remote.describe()

    const gate = described.namespaces.find((namespace) => namespace.name === 'gate')!
    const semantics = Object.fromEntries(gate.methods.map((method) => [method.name, method.semantics]))
    t.is(semantics.readMode, 'query')
    t.is(semantics.setMode, 'idempotent-command')
    t.is(semantics.startPump, 'non-repeatable-command')
    // A method that declares nothing is reported as declaring nothing, rather than being guessed at.
    t.is(semantics.unmarked, undefined)

    await client.close()
    await server.close()
})

// ---------------------------------------------------------------- did not run, or may have run

test('a call cut off after it was sent is an unknown outcome, not a failure', async (t) => {
    // The distinction this whole file is about. "It failed" invites a retry; for a command that may
    // already have run, a retry is a second pump start - so the library must not say "failed" when
    // what it knows is that it stopped listening.
    const server = new RpcServer({ name: peer('slowServer'), transports: [{ port: 3822 }] })
    await server.ready()
    const gate = new Gate()
    server.exposeClassInstance(gate)

    const client = new RpcClient('http://localhost:3822', { name: peer('cutOff'), defaultTarget: peer('slowServer'), callTimeout: 30000 })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote

    // In flight and unanswered when the link goes: the request is out there, the method is running,
    // and nothing on this side can say whether it will finish.
    const pending = remote.startPumpSlowly()
    while (!gate.release) await sleep(10)
    await client.close()

    const failure = await t.throwsAsync(pending)
    t.true(/UnknownOutcome/.test(String(failure?.message)), `expected an unknown outcome, got: ${failure?.message}`)
    t.true(/may or may not have run/.test(String(failure?.message)))

    // And it did run, which is exactly why the caller must not be told it failed.
    gate.release()
    await sleep(50)
    t.is(gate.started, 1, 'the command the caller was left unsure about should have run')

    await server.close()
})

test('a call that never left is a transport error, because it certainly did not run', async (t) => {
    const server = new RpcServer({ name: peer('goneServer'), transports: [{ port: 3823 }] })
    await server.ready()
    server.exposeClassInstance(new Gate())

    const client = new RpcClient('http://localhost:3823', { name: peer('neverSent'), defaultTarget: peer('goneServer') })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote
    t.is(await remote.readMode(), 'auto')
    await client.close()

    // The transport is gone, so this one is refused before it can be encoded. The command did not
    // run, and saying so is the useful answer.
    const failure = await t.throwsAsync(remote.startPump())
    t.true(/TransportError/.test(String(failure?.message)), `expected a transport error, got: ${failure?.message}`)
    t.false(/UnknownOutcome/.test(String(failure?.message)))

    await server.close()
})

// ---------------------------------------------------------------- calls that overlap

@rpcNamespace('cell', { execution: 'serial' })
class SerialCell {
    log: string[] = []

    @rpc
    async slow(label: string) {
        this.log.push(`${label} in`)
        await sleep(120)
        this.log.push(`${label} out`)
        return label
    }
}

test('a serial instance runs one call at a time', async (t) => {
    const server = new RpcServer({ name: peer('serialServer'), transports: [{ port: 3824 }] })
    await server.ready()
    const cell = new SerialCell()
    server.exposeClassInstance(cell)

    const client = new RpcClient('http://localhost:3824', { name: peer('serialCaller'), defaultTarget: peer('serialServer'), callTimeout: 5000 })
    await client.ready()
    const remote = (await client.proxy<SerialCell>('cell')).remote

    await Promise.all([remote.slow('a'), remote.slow('b')])

    // Interleaved would be a in, b in, a out, b out - one caller's sequence landing inside
    // another's, which on a mutable instance is how a machine ends up in a state nobody asked for.
    t.deepEqual(cell.log, ['a in', 'a out', 'b in', 'b out'], `calls interleaved: ${JSON.stringify(cell.log)}`)

    await client.close()
    await server.close()
})

class Fleet {
    log: string[] = []

    @rpc
    async move(device: string) {
        this.log.push(`${device} in`)
        await sleep(120)
        this.log.push(`${device} out`)
        return device
    }
}

test('serial by key keeps one device in order without holding up the others', async (t) => {
    const server = new RpcServer({ name: peer('fleetServer'), transports: [{ port: 3825 }] })
    await server.ready()
    const fleet = new Fleet()
    // The key is the first argument, which is the device: a server fronting many devices orders
    // each one's commands without serialising itself behind the slowest of them.
    server.exposeClassInstance(fleet, 'fleet', { execution: (call) => String(call.params[0]) })

    const client = new RpcClient('http://localhost:3825', { name: peer('fleetCaller'), defaultTarget: peer('fleetServer'), callTimeout: 5000 })
    await client.ready()
    const remote = (await client.proxy<Fleet>('fleet')).remote

    const started = Date.now()
    await Promise.all([remote.move('cell1'), remote.move('cell1'), remote.move('cell2')])
    const elapsed = Date.now() - started

    // cell1 twice in sequence is 240 ms; cell2 alongside them is not additional time.
    t.true(elapsed < 400, `keys did not run alongside each other: ${elapsed} ms`)
    const cell1 = fleet.log.filter((entry) => entry.startsWith('cell1'))
    t.deepEqual(cell1, ['cell1 in', 'cell1 out', 'cell1 in', 'cell1 out'], `one device's calls overlapped: ${JSON.stringify(fleet.log)}`)

    await client.close()
    await server.close()
})

@rpcNamespace('queue', { execution: 'serial' })
class SlowQueue {
    ran: string[] = []

    @rpc
    async work(label: string) {
        await sleep(250)
        this.ran.push(label)
        return label
    }
}

test('a command that waited out its caller behind others is refused rather than run late', async (t) => {
    // Where the queue and the deadline meet. The budget is read after waiting in the queue, because
    // waiting in the queue is exactly the delay it exists to catch - checking on arrival would let
    // a command sit behind four others and then run for a caller that left long ago.
    const server = new RpcServer({ name: peer('queueServer'), transports: [{ port: 3826 }] })
    await server.ready()
    const queue = new SlowQueue()
    server.exposeClassInstance(queue)

    const client = new RpcClient('http://localhost:3826', { name: peer('queueCaller'), defaultTarget: peer('queueServer'), callTimeout: 400 })
    await client.ready()
    const remote = (await client.proxy<SlowQueue>('queue')).remote

    const results = await Promise.allSettled([remote.work('first'), remote.work('second'), remote.work('third')])

    t.is(results[0].status, 'fulfilled', 'the first call should have run')
    t.deepEqual(queue.ran, ['first'], `a call ran after its caller had gone: ${JSON.stringify(queue.ran)}`)
    t.is(results[2].status, 'rejected')

    await client.close()
    await server.close()
})

// ---------------------------------------------------------------- running a command once

test('two attempts at one command run it once and get the same answer', async (t) => {
    const server = new RpcServer({
        name: peer('idemServer'),
        transports: [{ port: 3827 }],
        // In a plant this is on disk or in Redis; in memory it is enough to exercise the wiring.
        idempotency: new MemoryIdempotencyStore()
    })
    await server.ready()
    const gate = new Gate()
    server.exposeClassInstance(gate)

    const client = new RpcClient('http://localhost:3827', { name: peer('idemCaller'), defaultTarget: peer('idemServer') })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote

    // The operator pressed the button, did not get an answer they trusted, and pressed it again.
    // Same work order, so the same command - which is the only thing the caller knows that the
    // library cannot work out for itself.
    const first = await remote.$with({ idempotencyKey: 'work-order-42' }).startPump()
    const second = await remote.$with({ idempotencyKey: 'work-order-42' }).startPump()

    t.is(gate.started, 1, 'the pump was started twice')
    t.is(first, 'start 1')
    t.is(second, 'start 1', 'the second attempt did not get the first attempt s answer')

    // A different work order is a different command, and does run.
    await remote.$with({ idempotencyKey: 'work-order-43' }).startPump()
    t.is(gate.started, 2)

    await client.close()
    await server.close()
})

test('only a non-repeatable command is guarded, so a query costs no store round trip', async (t) => {
    const asked: string[] = []
    const store: RpcIdempotencyStore = {
        async begin(invocation: RpcInvocation) {
            asked.push(invocation.scope)
            return 'acquired'
        },
        async complete() {}
    }
    const server = new RpcServer({ name: peer('scopeServer'), transports: [{ port: 3828 }], idempotency: store })
    await server.ready()
    server.exposeClassInstance(new Gate())

    const client = new RpcClient('http://localhost:3828', { name: peer('scopeCaller'), defaultTarget: peer('scopeServer') })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote

    await remote.readMode()
    await remote.setMode('manual')
    await remote.unmarked()
    t.deepEqual(asked, [], 'a call that is not a non-repeatable command consulted the store')

    await remote.startPump()
    t.deepEqual(asked, ['gate.startPump'])

    await client.close()
    await server.close()
})

test('a command whose store cannot be reached is refused, not run', async (t) => {
    // Failing open would turn an unreachable guard into exactly the double execution it was
    // installed to prevent. A refused command is a problem an operator can see and act on.
    const store: RpcIdempotencyStore = {
        async begin(): Promise<'acquired'> {
            throw new Error('the outcome store is down')
        },
        async complete() {}
    }
    const server = new RpcServer({ name: peer('brokenStore'), transports: [{ port: 3829 }], idempotency: store })
    await server.ready()
    const gate = new Gate()
    server.exposeClassInstance(gate)

    const client = new RpcClient('http://localhost:3829', { name: peer('brokenCaller'), defaultTarget: peer('brokenStore') })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote

    const failure = await t.throwsAsync(remote.startPump())
    t.true(/UnknownOutcome/.test(String(failure?.message)), `expected an unknown outcome, got: ${failure?.message}`)
    t.true(/store could not be reached/.test(String(failure?.message)))
    t.is(gate.started, 0, 'the command ran even though its guard was unreachable')

    await client.close()
    await server.close()
})

test('what a command answered is written down before the answer is sent', async (t) => {
    // The order matters. Recording after answering leaves a window where the caller has the result
    // and the store does not, and a redelivery arriving in that window runs the command again.
    const events: string[] = []
    const store: RpcIdempotencyStore = {
        async begin() {
            return 'acquired'
        },
        async complete(_invocation: RpcInvocation, outcome: StoredRpcOutcome) {
            events.push(`recorded ${'result' in outcome ? String(outcome.result) : outcome.code}`)
        }
    }
    const server = new RpcServer({ name: peer('orderServer'), transports: [{ port: 3830 }], idempotency: store })
    await server.ready()
    server.exposeClassInstance(new Gate())

    const client = new RpcClient('http://localhost:3830', { name: peer('orderCaller'), defaultTarget: peer('orderServer') })
    await client.ready()
    const remote = (await client.proxy<Gate>('gate')).remote

    const answer = await remote.startPump()
    events.push(`answered ${answer}`)

    t.deepEqual(events, ['recorded start 1', 'answered start 1'], 'the answer went out before the outcome was recorded')

    await client.close()
    await server.close()
})
