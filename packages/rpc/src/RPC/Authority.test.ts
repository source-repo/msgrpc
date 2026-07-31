import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, rpc, rpcNamespace } from '../index.js'
import { RpcComponent, type RpcAuthorityChange } from './Component.js'
import { rpcComponent } from './ComponentClient.js'

/**
 * Command authority: the plant's arbitration concept, not a mutex. Authority is acquired, visible
 * in every snapshot, and expires; only methods that declare requiresAuthority are ever gated, which
 * is how the safety path stays provably outside the lease.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

type UnitState = { mode: string; running: boolean }

@rpcNamespace('unit')
class Unit extends RpcComponent<Record<string, never>, UnitState> {
    constructor() {
        super({}, { mode: 'auto', running: false })
    }

    @rpc({ semantics: 'idempotent-command', requiresAuthority: true })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }

    @rpc({ semantics: 'non-repeatable-command', requiresAuthority: true })
    async start() {
        this.setState({ running: true })
        return 'started'
    }

    /** The safety path: deliberately undeclared, so no lease can ever stand between it and a stop. */
    @rpc({ semantics: 'idempotent-command' })
    async stop() {
        this.setState({ running: false })
        return 'stopped'
    }
}

const rig = async (port: number) => {
    const server = new RpcServer({ name: peer(`unit${port}`), transports: [{ port }] })
    await server.ready()
    const unit = new Unit()
    server.exposeClassInstance(unit)
    const operator = new RpcClient(`http://localhost:${port}`, { name: peer(`operator${port}`), defaultTarget: peer(`unit${port}`) })
    const intruder = new RpcClient(`http://localhost:${port}`, { name: peer(`intruder${port}`), defaultTarget: peer(`unit${port}`) })
    await operator.ready()
    await intruder.ready()
    return {
        server,
        unit,
        operator,
        intruder,
        dispose: async () => {
            await operator.close()
            await intruder.close()
            await server.close()
        }
    }
}

test('two contenders produce one holder and one refusal that names them', async (t) => {
    const { operator, intruder, dispose } = await rig(3871)
    const held = await operator.component<Unit>('unit')
    const other = await intruder.component<Unit>('unit')

    const grant = await held.$acquire(60000)
    t.is(grant.holder, peer('operator3871'))
    t.true((grant.expiresAt ?? 0) > Date.now())

    const refusal = await t.throwsAsync(other.$acquire(60000))
    t.regex(String(refusal?.message), /NotInControl/)
    t.regex(String(refusal?.message), new RegExp(peer('operator3871')), 'the refusal should name who is in control')

    // The holder asking again is a renewal, not a conflict - and the generation does not move,
    // so the holder's own in-flight commands are not fenced out by extending the lease.
    const renewed = await held.$acquire(60000)
    t.is(renewed.generation, grant.generation)

    await held[rpcComponent].close()
    await other[rpcComponent].close()
    await dispose()
})

test('a command from a non-holder is refused with the holder named, and the holder commands freely', async (t) => {
    const { operator, intruder, dispose } = await rig(3872)
    const held = await operator.component<Unit>('unit')
    const other = await intruder.component<Unit>('unit')
    await held.$acquire(60000)

    const refusal = await t.throwsAsync(other.setMode('manual'))
    t.regex(String(refusal?.message), /NotInControl/)
    t.regex(String(refusal?.message), new RegExp(peer('operator3872')))

    t.is(await held.setMode('manual'), 'manual')
    await waitFor(() => held.state.mode === 'manual')

    // And with nobody in control, the refusal says what to do about it instead of naming a ghost.
    await held.$release()
    const nobody = await t.throwsAsync(other.setMode('auto'))
    t.regex(String(nobody?.message), /nobody is in control/)

    await held[rpcComponent].close()
    await other[rpcComponent].close()
    await dispose()
})

test('the safety path is never gated: an undeclared method runs while someone else holds the unit', async (t) => {
    const { operator, intruder, dispose } = await rig(3873)
    const held = await operator.component<Unit>('unit')
    const other = await intruder.component<Unit>('unit')
    await held.$acquire(60000)
    t.is(await held.start(), 'started')

    // The intruder cannot start the unit - but stop() declares no authority, so nothing stands
    // between anyone and stopping it. That asymmetry is the design, not an accident of it.
    await t.throwsAsync(other.start())
    t.is(await other.stop(), 'stopped')
    await waitFor(() => other.state.running === false)

    await held[rpcComponent].close()
    await other[rpcComponent].close()
    await dispose()
})

test('expiry is an event, visible in the snapshot, and frees the unit for the next holder', async (t) => {
    const { operator, intruder, unit, dispose } = await rig(3874)
    const held = await operator.component<Unit>('unit')
    const other = await intruder.component<Unit>('unit')

    const changes: RpcAuthorityChange[] = []
    unit.on('authorityChanged', (change: RpcAuthorityChange) => changes.push(change))

    await held.$acquire(150)
    await waitFor(() => changes.some((change) => change.reason === 'expired'))
    const expiry = changes.find((change) => change.reason === 'expired')!
    t.is(expiry.previousHolder, peer('operator3874'))
    t.is(expiry.authority.holder, undefined)

    // Observers learn it the same way they learn everything: the snapshot republished.
    await waitFor(() => other[rpcComponent].getSnapshot().authority?.holder === undefined)

    const grant = await other.$acquire(60000)
    t.is(grant.holder, peer('intruder3874'))

    await held[rpcComponent].close()
    await other[rpcComponent].close()
    await dispose()
})

test('a takeover moves the generation, and the displaced holder is refused thereafter', async (t) => {
    const { operator, intruder, dispose } = await rig(3875)
    const held = await operator.component<Unit>('unit')
    const other = await intruder.component<Unit>('unit')

    const first = await held.$acquire(60000)
    // The break-in every plant panel has. Who may use it is authorize()'s decision; what it does
    // here is make the change atomic, visible, and a new generation.
    const taken = await other.$acquire(60000, { take: true })
    t.is(taken.holder, peer('intruder3875'))
    t.true(taken.generation > first.generation)

    const refusal = await t.throwsAsync(held.setMode('manual'))
    t.regex(String(refusal?.message), new RegExp(peer('intruder3875')), 'the displaced holder learns who displaced it')

    // Every observer sees the takeover in the snapshot - controlledBy is readable state, not a secret.
    await waitFor(() => held[rpcComponent].getSnapshot().authority?.holder === peer('intruder3875'))

    await held[rpcComponent].close()
    await other[rpcComponent].close()
    await dispose()
})

test('requiresAuthority on a class that is not a component is refused at expose time', async (t) => {
    class Plain {
        @rpc({ requiresAuthority: true })
        async command() {
            return 'ran'
        }
    }
    const server = new RpcServer({ name: peer('plain3876'), transports: [] })
    const failure = t.throws(() => server.exposeClassInstance(new Plain(), 'plain'))
    t.regex(String(failure?.message), /not an RpcComponent/)
    await server.close()
})
