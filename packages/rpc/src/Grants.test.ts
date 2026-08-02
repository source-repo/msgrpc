import test from 'ava'
import { randomUUID } from 'crypto'
import {
    createDerivedAuthenticator,
    createTokenAuthenticator,
    decideAiAccess,
    firstAuthenticator,
    mintDerivedCredential,
    openAiGrants,
    rpc,
    rpcNamespace,
    RpcClient,
    RpcServer,
    validateAiGrants,
    type RpcAiGrants
} from './index.js'

/**
 * The AI boundary's target side: what a badged principal may do here.
 *
 * The rule these all circle is that the four grants are closed on every node until somebody opens
 * one by name, and that this is enforced by the library before any authorizer runs - so a server
 * whose author wrote no authorizer at all still refuses.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const SECRET = `grants-secret-${run}`

const tool = { name: 'assistant', roles: ['ai-tool'] }
const program = { name: 'ramp', roles: ['ai-program'], claims: { generation: 2 } }
const human = { name: 'anders', roles: ['engineer'] }

const grants = (open: RpcAiGrants['open']): RpcAiGrants => ({ grants: 1, revision: 1, open })

// ------------------------------------------------------------------ the decision, in isolation

test('the ladder: nobody is gated who is not AI, observation is open, everything else is closed', (t) => {
    // A human principal is not this layer's business at all, whatever they call.
    t.true(decideAiAccess({ identity: human, effect: 'program' }).allowed)
    t.true(decideAiAccess({ identity: undefined, effect: 'program' }).allowed)

    // A badged AI observes without any grant - the rung that makes it useful on day one.
    t.true(decideAiAccess({ identity: tool, effect: 'observe' }).allowed)
    t.true(decideAiAccess({ identity: program, effect: 'observe' }).allowed)

    // And nothing above that, on a node with no grants document.
    const write = decideAiAccess({ identity: tool, effect: 'operate' })
    t.false(write.allowed)
    t.is(write.grant, 'ai.tool.write')
    t.regex(write.reason, /is not open on this node/)
    t.false(decideAiAccess({ identity: tool, effect: 'program' }).allowed)
    t.false(decideAiAccess({ identity: program, effect: 'operate' }).allowed)
    t.false(decideAiAccess({ identity: program, effect: 'program' }).allowed)
})

test('provenance times effect picks the grant, and one grant never covers another', (t) => {
    // The pair the whole classification exists for: a tool permitted to operate is not thereby
    // permitted to program, however identical the two methods look to a retry policy.
    const operating = grants({ 'ai.tool.write': {} })
    t.true(decideAiAccess({ grants: operating, identity: tool, effect: 'operate' }).allowed)
    t.false(decideAiAccess({ grants: operating, identity: tool, effect: 'program' }).allowed)

    // And a grant for the tool is not a grant for what the tool wrote.
    t.false(decideAiAccess({ grants: operating, identity: program, effect: 'operate' }).allowed)
    t.true(decideAiAccess({ grants: grants({ 'ai.program.write': {} }), identity: program, effect: 'operate' }).allowed)

    // security-admin is never one of the four.
    t.false(decideAiAccess({ grants: grants({ 'ai.tool.program': {} }), identity: tool, effect: 'security-admin' }).allowed)
    t.true(decideAiAccess({ grants: grants({ 'ai.sponsor': {} }), identity: tool, effect: 'security-admin' }).allowed)
})

test('a grant may be scoped by name or role, and says so when it does not apply', (t) => {
    const byName = grants({ 'ai.tool.write': { to: ['somebody-else'] } })
    const refused = decideAiAccess({ grants: byName, identity: tool, effect: 'operate' })
    t.false(refused.allowed)
    t.regex(refused.reason, /not to assistant/)

    t.true(decideAiAccess({ grants: grants({ 'ai.tool.write': { to: ['assistant'] } }), identity: tool, effect: 'operate' }).allowed)
    t.true(decideAiAccess({ grants: grants({ 'ai.tool.write': { roles: ['ai-tool'] } }), identity: tool, effect: 'operate' }).allowed)
    t.false(decideAiAccess({ grants: grants({ 'ai.tool.write': { roles: ['commissioning'] } }), identity: tool, effect: 'operate' }).allowed)
})

test('a lease lapses, and says how long ago', (t) => {
    const lapsed = grants({ 'ai.tool.write': { expiresAt: Date.now() - 30_000 } })
    const decision = decideAiAccess({ grants: lapsed, identity: tool, effect: 'operate' })
    t.false(decision.allowed)
    t.regex(decision.reason, /lapsed \d+s ago/)

    t.true(decideAiAccess({ grants: grants({ 'ai.tool.write': { expiresAt: Date.now() + 60_000 } }), identity: tool, effect: 'operate' }).allowed)

    // And what the console renders: a lapsed grant is not among the open ones.
    t.deepEqual(openAiGrants(lapsed).length, 0)
    t.is(openAiGrants(grants({ 'ai.tool.write': { expiresAt: Date.now() + 60_000 }, 'ai.sponsor': {} })).length, 2)
})

test('generation depth bounds how far from a human a grant reaches', (t) => {
    const shallow = grants({ 'ai.program.write': { maxGeneration: 2 } })
    t.true(decideAiAccess({ grants: shallow, identity: program, effect: 'operate' }).allowed)

    const deeper = { name: 'spawned', roles: ['ai-program'], claims: { generation: 3 } }
    const refused = decideAiAccess({ grants: shallow, identity: deeper, effect: 'operate' })
    t.false(refused.allowed)
    t.regex(refused.reason, /permits generation 2 and this principal is generation 3/)
})

test('a malformed document is refused rather than read as granting nothing', (t) => {
    t.throws(() => validateAiGrants(undefined), { message: /expected a grants document/ })
    t.throws(() => validateAiGrants({ grants: 2, revision: 1 }), { message: /unsupported document version/ })
    t.throws(() => validateAiGrants({ grants: 1 }), { message: /revision must be a number/ })
    t.throws(() => validateAiGrants({ grants: 1, revision: 1, open: { 'ai.everything': {} } }), { message: /is not a grant this library defines/ })
    t.throws(() => validateAiGrants({ grants: 1, revision: 1, open: { 'ai.tool.write': { maxGeneration: 0 } } }), { message: /maxGeneration must be 1 or more/ })
    t.notThrows(() => validateAiGrants({ grants: 1, revision: 7, open: {} }))
})

// ------------------------------------------------------------------ enforced on a real server

@rpcNamespace('cell')
class Cell {
    @rpc({ semantics: 'query' })
    async status() {
        return 'idle'
    }
    @rpc({ semantics: 'idempotent-command', effect: 'operate' })
    async setSetpoint(value: number) {
        return value
    }
    @rpc({ semantics: 'idempotent-command', effect: 'program' })
    async deployProgram(bundle: string) {
        return bundle
    }
}

const busWith = async (port: number, aiGrants?: RpcAiGrants) => {
    const server = new RpcServer({
        name: peer(`bus${port}`),
        transports: [{ port, host: '127.0.0.1' }],
        authenticate: firstAuthenticator(
            createTokenAuthenticator({ [`human-${run}`]: { name: peer('anders'), roles: ['engineer'] } }),
            createDerivedAuthenticator({ issuers: { [peer('node')]: SECRET } })
        ),
        // Deliberately no authorize(): the refusal below must come from the library itself.
        ...(aiGrants ? { aiGrants } : {})
    })
    server.exposeClassInstance(new Cell())
    await server.ready()
    return server
}

const aiClient = async (port: number, name: string, roles: string[]) => {
    const issuedAt = Date.now()
    const token = await mintDerivedCredential(
        { credentialId: name, subject: name, roles, issuer: peer('node'), generation: 2, issuedAt, expiresAt: issuedAt + 60_000 },
        SECRET
    )
    const client = new RpcClient(`http://localhost:${port}`, { name, defaultTarget: peer(`bus${port}`), credentials: { token }, callTimeout: 4000 })
    await client.ready()
    return client
}

test('a node with no authorizer still refuses an AI write, and still allows an AI read', async (t) => {
    const server = await busWith(3870)
    const ai = await aiClient(3870, peer('assistant3870'), ['ai-tool'])
    const cell = await ai.proxy<Cell>('cell')

    t.is(await cell.status(), 'idle', 'observation needs no grant')
    await t.throwsAsync(cell.setSetpoint(7), { message: /Forbidden/ }, 'operating does, and there is none')
    await t.throwsAsync(cell.deployProgram('x'), { message: /Forbidden/ })

    // The same calls from a human principal are untouched by any of this.
    const person = new RpcClient('http://localhost:3870', { name: peer('anders'), defaultTarget: peer('bus3870'), credentials: { token: `human-${run}` } })
    await person.ready()
    t.is(await (await person.proxy<Cell>('cell')).setSetpoint(7), 7)

    await person.close()
    await ai.close()
    await server.close()
})

test('opening one rung opens exactly that rung, and the decision is auditable', async (t) => {
    const decisions: { allowed: boolean; grant?: string; reason: string; method: string }[] = []
    const server = new RpcServer({
        name: peer('bus3871'),
        transports: [{ port: 3871, host: '127.0.0.1' }],
        authenticate: createDerivedAuthenticator({ issuers: { [peer('node')]: SECRET } }),
        aiGrants: grants({ 'ai.tool.write': { to: [peer('assistant3871')], reason: 'commissioning, 2 August' } }),
        onAiDecision: (record) => decisions.push(record)
    })
    server.exposeClassInstance(new Cell())
    await server.ready()

    const ai = await aiClient(3871, peer('assistant3871'), ['ai-tool'])
    const cell = await ai.proxy<Cell>('cell')

    t.is(await cell.setSetpoint(42), 42, 'the granted rung is open')
    await t.throwsAsync(cell.deployProgram('x'), { message: /Forbidden/ }, 'and the one above it is not')

    // Every gated decision is recorded, allowed and refused alike, with the sentence that explains it.
    const allowed = decisions.find((record) => record.method === 'setSetpoint')
    t.true(allowed?.allowed)
    t.is(allowed?.grant, 'ai.tool.write')
    const refused = decisions.find((record) => record.method === 'deployProgram')
    t.false(refused?.allowed)
    t.is(refused?.grant, 'ai.tool.program')
    t.regex(String(refused?.reason), /not open on this node/)

    // Observation is not gated, so it is not in the audit as a grant decision.
    await cell.status()
    t.false(decisions.some((record) => record.method === 'status'))

    await ai.close()
    await server.close()
})

test('an AI-authored program does not inherit the tool grant that started it', async (t) => {
    // The distinction the whole two-axis vocabulary exists for, on a live bus.
    const server = await busWith(3872, grants({ 'ai.tool.write': {} }))
    const spawned = await aiClient(3872, peer('ramp3872'), ['ai-program'])

    await t.throwsAsync((await spawned.proxy<Cell>('cell')).setSetpoint(3), { message: /Forbidden/ })
    t.is(await (await spawned.proxy<Cell>('cell')).status(), 'idle', 'though it may still observe')

    await spawned.close()
    await server.close()
})

test('a server refuses to start holding a security policy it cannot read', (t) => {
    t.throws(() => new RpcServer({ name: peer('bad'), transports: [], aiGrants: { grants: 3, revision: 1 } as unknown as RpcAiGrants }), {
        message: /unsupported document version/
    })
})
