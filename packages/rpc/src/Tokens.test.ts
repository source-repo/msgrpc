import test from 'ava'
import { RpcClient, RpcServer, createTokenAuthenticator } from './index.js'

/**
 * The packaged form of what Auth.test.ts writes by hand. What is worth testing here is not that a
 * good token is admitted - that is a map lookup - but the three things around it: that a token
 * names one peer and cannot be used as another, that the configurations which would quietly admit
 * everybody are refused at construction, and that the identity handed out cannot be edited by
 * whoever receives it.
 */

class Plant {
    async readSetpoint() {
        return 42
    }
}

const TOKENS = {
    'plant-token': 'plantServer',
    'hmi-token': { name: 'hmi', roles: ['operator'] }
}

const authenticatingServer = async (port: number) => {
    const server = new RpcServer({ name: 'bus', transports: [{ port }], authenticate: createTokenAuthenticator(TOKENS) })
    server.exposeClassInstance(new Plant(), 'plant')
    await server.ready()
    return server
}

test('a token admits its holder as the peer it names', async (t) => {
    const server = await authenticatingServer(3241)
    const client = new RpcClient('http://localhost:3241', { name: 'plantServer', credentials: { token: 'plant-token' }, readyTimeout: 2000 })
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant', 'bus')).remote.readSetpoint(), 42)

    await client.close()
    await server.close()
})

test('a stolen token gets a socket and nothing else', async (t) => {
    const server = await authenticatingServer(3242)
    // The handshake succeeds, because the token is real, so ready() resolves: the connection is up.
    // Everything after that is refused. The transport pins the source to the name the token
    // resolved to, so the impostor's presence announcement is dropped and it is never listed, and
    // every frame it sends is dropped too. This is the whole reason a token maps to a peer name
    // rather than merely unlocking the bus - and it is why the failure looks like a timeout.
    const client = new RpcClient('http://localhost:3242', { name: 'plantServer-impostor', credentials: { token: 'plant-token' }, readyTimeout: 2000, callTimeout: 700 })
    await client.ready()

    await t.throwsAsync(async () => (await client.proxy<Plant>('plant', 'bus')).remote.readSetpoint())
    t.false(server.peers.names().includes('plantServer-impostor'))

    await client.close()
    await server.close()
})

test('an unknown token is refused, and so is none at all', async (t) => {
    const server = await authenticatingServer(3243)

    const wrong = new RpcClient('http://localhost:3243', { name: 'plantServer', credentials: { token: 'guessed' }, readyTimeout: 800 })
    await t.throwsAsync(wrong.ready(), { message: /not ready within/ })
    await wrong.close()

    const none = new RpcClient('http://localhost:3243', { name: 'plantServer', readyTimeout: 800 })
    await t.throwsAsync(none.ready(), { message: /not ready within/ })
    await none.close()

    await server.close()
})

test('roles on a grant reach the authorizer', (t) => {
    const authenticate = createTokenAuthenticator(TOKENS)
    t.deepEqual(authenticate({ token: 'hmi-token' }, {}), { name: 'hmi', roles: ['operator'] })
    t.deepEqual(authenticate({ token: 'plant-token' }, {}), { name: 'plantServer' })
})

test('credentials that are not a token are refused rather than thrown at', (t) => {
    const authenticate = createTokenAuthenticator(TOKENS)
    t.is(authenticate(undefined, {}), undefined)
    t.is(authenticate({}, {}), undefined)
    t.is(authenticate('plant-token', {}), undefined)
    // A number that stringifies to a real token must not get in through a loose comparison.
    t.is(authenticate({ token: ['plant-token'] }, {}), undefined)
})

test('the configurations that would admit everybody are refused at construction', (t) => {
    t.throws(() => createTokenAuthenticator({ '': 'plantServer' }), { message: /blank token/ })
    t.throws(() => createTokenAuthenticator({ '   ': 'plantServer' }), { message: /blank token/ })
    t.throws(() => createTokenAuthenticator({ 'plant-token': '' }), { message: /must name the peer/ })
    t.throws(() => createTokenAuthenticator({}), { message: /no tokens/ })
})

test('the identity handed out is a copy, so an authorizer cannot widen the next connection', (t) => {
    const authenticate = createTokenAuthenticator(TOKENS)
    const first = authenticate({ token: 'hmi-token' }, {}) as { name: string; roles: string[] }
    first.roles.push('engineer')
    first.name = 'plantServer'

    t.deepEqual(authenticate({ token: 'hmi-token' }, {}), { name: 'hmi', roles: ['operator'] })
})

test('a later change to the caller"s map cannot widen who is admitted', (t) => {
    const tokens: { [token: string]: string } = { 'plant-token': 'plantServer' }
    const authenticate = createTokenAuthenticator(tokens)
    tokens['added-later'] = 'plantServer'

    t.is(authenticate({ token: 'added-later' }, {}), undefined)
})
