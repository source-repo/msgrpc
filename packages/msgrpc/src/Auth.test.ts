import test from 'ava'
import { io as ioClient } from 'socket.io-client'
import { EventEmitter } from 'events'
import { RpcServer, RpcServerOptions } from './RpcServer.js'
import { RpcClient } from './RpcClient.js'
import { RpcError } from './RPC/RpcClientHandler.js'
import { RpcAuthenticator, RpcAuthorizer, RpcIdentity } from './RPC/Auth.js'

class Plant extends EventEmitter {
    async readSetpoint() {
        return 42
    }
    async writeSetpoint(value: number) {
        return value
    }
    fire() {
        this.emit('alarm', 'high pressure')
    }
}

class Dangerous {
    constructor(...args: unknown[]) {
        void args
    }
}

const TOKENS: { [token: string]: RpcIdentity } = {
    'operator-token': { name: 'operator', roles: ['read'] },
    'engineer-token': { name: 'engineer', roles: ['read', 'write'] }
}

const authenticate: RpcAuthenticator = (credentials) => TOKENS[(credentials as { token?: string })?.token ?? '']

/** Reads for everyone authenticated, writes only for the write role. */
const authorize: RpcAuthorizer = ({ identity, method }) => (method.startsWith('write') ? !!identity?.roles?.includes('write') : true)

const secureServer = async (port: number, extra: Partial<RpcServerOptions> = {}) => {
    const server = new RpcServer({ transports: [{ port }], authenticate, authorize, ...extra })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')
    server.exposeClass(Dangerous)
    return { server, plant }
}

const connect = async (port: number, name: string, token: string | undefined, readyTimeout = 1500) => {
    const client = new RpcClient(`http://localhost:${port}`, { name, credentials: token ? { token } : undefined, readyTimeout })
    await client.ready()
    return client
}

test('a peer with valid credentials can call an allowed method', async (t) => {
    const { server } = await secureServer(3201)
    const client = await connect(3201, 'operator', 'operator-token')
    const plant = await client.proxy<Plant>('plant')

    t.is(await plant.remote?.readSetpoint(), 42)

    await client.close()
    await server.close()
})

test('a peer with no credentials never becomes ready', async (t) => {
    const { server } = await secureServer(3202)
    const client = new RpcClient('http://localhost:3202', { name: 'intruder', readyTimeout: 800 })

    await t.throwsAsync(client.ready(), { message: /not ready within/ })

    await client.close()
    await server.close()
})

test('a peer with bad credentials never becomes ready', async (t) => {
    const { server } = await secureServer(3203)
    const client = new RpcClient('http://localhost:3203', { name: 'intruder', credentials: { token: 'wrong' }, readyTimeout: 800 })

    await t.throwsAsync(client.ready(), { message: /not ready within/ })

    await client.close()
    await server.close()
})

test('an authenticated peer is refused a method its role does not allow', async (t) => {
    const { server } = await secureServer(3204)
    const client = await connect(3204, 'operator', 'operator-token')
    const plant = await client.proxy<Plant>('plant')

    const error = await t.throwsAsync(async () => plant.remote?.writeSetpoint(99), { instanceOf: RpcError })
    t.is(error?.code, 'Forbidden')
    // The same call from a peer that does have the role still works.
    const engineer = await connect(3204, 'engineer', 'engineer-token')
    t.is(await (await engineer.proxy<Plant>('plant')).remote?.writeSetpoint(99), 99)

    await engineer.close()
    await client.close()
    await server.close()
})

test('event subscriptions are authorized too', async (t) => {
    const denyAll: RpcAuthorizer = ({ subscription }) => !subscription
    const server = new RpcServer({ transports: [{ port: 3205 }], authenticate, authorize: denyAll })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')
    const client = await connect(3205, 'operator', 'operator-token')
    const plant = await client.proxy<Plant>('plant')

    const error = await t.throwsAsync(async () => plant.remote?.on('alarm', () => {}), { instanceOf: RpcError })
    t.is(error?.code, 'Forbidden')
    t.is(server.rpc.eventProxies.size, 0, 'a refused subscription still attached a listener')

    await client.close()
    await server.close()
})

test('a peer cannot address messages as another peer', async (t) => {
    const { server } = await secureServer(3206)
    // Authenticates correctly as "operator", then claims to be "engineer" on the wire.
    const impostor = new RpcClient(`http://localhost:3206`, {
        name: 'engineer',
        credentials: { token: 'operator-token' },
        readyTimeout: 1500,
        callTimeout: 800
    })
    await impostor.ready()
    const plant = await impostor.proxy<Plant>('plant')

    // The frame is dropped by the transport, so the call can only end in a timeout.
    const error = await t.throwsAsync(async () => plant.remote?.readSetpoint(), { instanceOf: RpcError })
    t.is(error?.code, 'Timeout')

    await impostor.close()
    await server.close()
})

test('the management surface is not exposed by default', async (t) => {
    const { server } = await secureServer(3207)
    const client = await connect(3207, 'engineer', 'engineer-token')
    const manage = await client.proxy<{ createRpcInstance: (c: string, n?: string) => Promise<string> }>('manageRpc')

    const error = await t.throwsAsync(async () => manage.remote?.createRpcInstance('Dangerous', 'evil'), { instanceOf: RpcError })
    t.is(error?.code, 'ClassNotFound')
    t.is(server.rpc.manageRpc.createdInstances.size, 0)

    await client.close()
    await server.close()
})

test('exposeManagement publishes only createRpcInstance, never the expose methods', async (t) => {
    const { server } = await secureServer(3208, { exposeManagement: true })
    const client = await connect(3208, 'engineer', 'engineer-token')
    const manage = await client.proxy<{
        createRpcInstance: (c: string, n?: string) => Promise<string>
        exposeObject: (o: object, n: string) => Promise<void>
    }>('manageRpc')

    t.is(await manage.remote?.createRpcInstance('Dangerous', 'evil'), 'evil')

    // exposeObject would let a peer publish arbitrary objects; it must not be reachable.
    const error = await t.throwsAsync(async () => manage.remote?.exposeObject({}, 'whatever'), { instanceOf: RpcError })
    t.is(error?.code, 'MethodNotFound')

    await client.close()
    await server.close()
})

test('an authorizer that throws denies rather than allows', async (t) => {
    const server = new RpcServer({
        transports: [{ port: 3209 }],
        authenticate,
        authorize: () => {
            throw new Error('authorizer bug')
        }
    })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')
    const client = await connect(3209, 'operator', 'operator-token')
    const plant = await client.proxy<Plant>('plant')

    const error = await t.throwsAsync(async () => plant.remote?.readSetpoint(), { instanceOf: RpcError })
    t.is(error?.code, 'Forbidden')

    await client.close()
    await server.close()
})

test('an open server still works when no auth is configured', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3210 }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')
    const client = new RpcClient('http://localhost:3210')
    await client.ready()

    t.is(await (await client.proxy<Plant>('plant')).remote?.readSetpoint(), 42)

    await client.close()
    await server.close()
})

test('a raw socket cannot connect to an authenticating server', async (t) => {
    const { server } = await secureServer(3211)
    const raw = ioClient('http://localhost:3211', { reconnection: false })
    const outcome = await new Promise<string>((resolve) => {
        raw.on('connect', () => resolve('connected'))
        raw.on('connect_error', (e) => resolve(e.message))
    })
    raw.close()

    t.is(outcome, 'unauthorized')
    await server.close()
})
