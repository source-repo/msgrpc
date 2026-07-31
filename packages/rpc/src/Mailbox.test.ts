import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, rpc, rpcNamespace } from './index.js'

/**
 * The graded mailbox: commands serialise because the contract says they are commands, queries run
 * beside them, a full queue refuses loudly, and a conflatable setpoint is replaced by a newer one.
 *
 * Every test holds a call open with a release function instead of racing sleeps: the assertions
 * are about ordering, and ordering proven by timing is ordering that flakes on a loaded runner.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

// TEMPORARY diagnostic for a CI-only failure to exit: every second after the tests finish, say
// what still holds the event loop. Unref'd, so the reporter cannot be the thing it is reporting.
test.after.always(() => {
    const dump = () => console.error('still holding the loop:', process.getActiveResourcesInfo?.() ?? 'unavailable')
    dump()
    setInterval(dump, 1000).unref()
})

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

@rpcNamespace('grader')
class Grader {
    log: string[] = []
    private releases = new Map<string, () => void>()

    release(label: string) {
        this.releases.get(label)?.()
    }

    @rpc({ semantics: 'idempotent-command' })
    async apply(label: string, hold = false) {
        this.log.push(`${label} in`)
        if (hold) await new Promise<void>((resolve) => this.releases.set(label, resolve))
        this.log.push(`${label} out`)
        return label
    }

    @rpc({ semantics: 'query' })
    async peek() {
        return this.log.length
    }
}

test('a declared command serialises with no execution declaration, and a query runs beside it', async (t) => {
    // Nobody typed `execution` anywhere: the contract's semantics are what serialise the commands.
    const server = new RpcServer({ name: peer('graded'), transports: [{ port: 3841 }] })
    await server.ready()
    const grader = new Grader()
    server.exposeClassInstance(grader)

    const client = new RpcClient('http://localhost:3841', { name: peer('gradedCaller'), defaultTarget: peer('graded'), callTimeout: 8000 })
    await client.ready()
    const remote = await client.proxy<Grader>('grader')

    const first = remote.apply('a', true)
    await waitFor(() => grader.log.includes('a in'))
    const second = remote.apply('b')

    // The query answers while the command holds the queue, or it would be waiting behind 'a'.
    t.is(await remote.peek(), 1, 'a query waited behind a running command')
    t.deepEqual(grader.log, ['a in'], `a second command started alongside the first: ${JSON.stringify(grader.log)}`)

    grader.release('a')
    await Promise.all([first, second])
    t.deepEqual(grader.log, ['a in', 'a out', 'b in', 'b out'], `commands interleaved: ${JSON.stringify(grader.log)}`)

    await client.close()
    await server.close()
})

test("execution: 'parallel' opts declared commands back out of the grading", async (t) => {
    // The escape hatch for a re-entrant design: the call site says overlap is fine, and wins.
    const server = new RpcServer({ name: peer('optout'), transports: [{ port: 3842 }] })
    await server.ready()
    const grader = new Grader()
    server.exposeClassInstance(grader, 'grader', { execution: 'parallel' })

    const client = new RpcClient('http://localhost:3842', { name: peer('optoutCaller'), defaultTarget: peer('optout'), callTimeout: 8000 })
    await client.ready()
    const remote = await client.proxy<Grader>('grader')

    const held = remote.apply('a', true)
    await waitFor(() => grader.log.includes('a in'))
    // Runs to completion while 'a' is still held open, which only a parallel instance permits.
    t.is(await remote.apply('b'), 'b')
    t.deepEqual(grader.log, ['a in', 'b in', 'b out'], `the override did not let calls overlap: ${JSON.stringify(grader.log)}`)

    grader.release('a')
    await held

    await client.close()
    await server.close()
})

test('a full mailbox answers Busy instead of queueing without limit', async (t) => {
    const server = new RpcServer({ name: peer('bounded'), transports: [{ port: 3843 }] })
    await server.ready()
    const grader = new Grader()
    // One waiting call is the whole allowance, so the third arrival has nowhere to go.
    server.exposeClassInstance(grader, 'grader', { mailbox: 1 })

    const client = new RpcClient('http://localhost:3843', { name: peer('boundedCaller'), defaultTarget: peer('bounded'), callTimeout: 8000 })
    await client.ready()
    const remote = await client.proxy<Grader>('grader')

    const running = remote.apply('a', true)
    await waitFor(() => grader.log.includes('a in'))
    const queued = remote.apply('b')
    // Refused on arrival, while the queue is still full - not after waiting in it.
    const failure = await t.throwsAsync(remote.apply('c'))
    t.regex(String(failure?.message), /Busy/, `expected Busy, got: ${failure?.message}`)

    grader.release('a')
    t.is(await queued, 'b', 'the call that was within the bound should still run')
    await running
    t.false(grader.log.some((entry) => entry.startsWith('c')), 'the refused call ran anyway')

    await client.close()
    await server.close()
})

@rpcNamespace('setpoints')
class Setpoints {
    applied: number[] = []
    releaseHeld?: () => void

    release() {
        this.releaseHeld?.()
    }

    @rpc({ semantics: 'idempotent-command', conflate: true })
    async set(value: number, hold = false) {
        if (hold) await new Promise<void>((resolve) => (this.releaseHeld = resolve))
        this.applied.push(value)
        return value
    }
}

test('a superseded setpoint is answered immediately, and the newest value is the one that runs', async (t) => {
    const server = new RpcServer({ name: peer('conflate'), transports: [{ port: 3844 }] })
    await server.ready()
    const setpoints = new Setpoints()
    server.exposeClassInstance(setpoints)

    const client = new RpcClient('http://localhost:3844', { name: peer('conflateCaller'), defaultTarget: peer('conflate'), callTimeout: 8000 })
    await client.ready()
    const remote = await client.proxy<Setpoints>('setpoints')

    const running = remote.set(1, true)
    await waitFor(() => setpoints.releaseHeld !== undefined)
    const stale = remote.set(2)
    const newest = remote.set(3)

    // Answered while the first call still holds the queue: the caller of 2 is freed the moment 3
    // replaces it, not when its turn would have come.
    const failure = await t.throwsAsync(stale)
    t.regex(String(failure?.message), /Superseded/, `expected Superseded, got: ${failure?.message}`)

    setpoints.release()
    t.is(await running, 1)
    t.is(await newest, 3)
    t.deepEqual(setpoints.applied, [1, 3], `the superseded value ran anyway: ${JSON.stringify(setpoints.applied)}`)

    await client.close()
    await server.close()
})

test('conflate without idempotent-command semantics is refused at expose time', async (t) => {
    // Dropping one of two queued non-repeatable commands would silently skip promised work, so the
    // combination fails where the developer is looking, not where an operator is.
    @rpcNamespace('bad')
    class Bad {
        @rpc({ semantics: 'non-repeatable-command', conflate: true })
        async advance() {
            return 1
        }
    }
    const server = new RpcServer({ name: peer('refuses'), transports: [] })
    const failure = t.throws(() => server.exposeClassInstance(new Bad()))
    t.regex(String(failure?.message), /free to skip/)

    @rpcNamespace('worse')
    class Undeclared {
        @rpc({ conflate: true })
        async poke() {
            return 1
        }
    }
    const undeclared = t.throws(() => server.exposeClassInstance(new Undeclared()))
    t.regex(String(undeclared?.message), /free to skip/)

    // Never ready()'d, but still holding whatever the constructor started - unclosed, it kept the
    // event loop alive and the whole file was reported as failing to exit.
    await server.close().catch(() => undefined)
})
