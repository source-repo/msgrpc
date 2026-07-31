import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, SCHEMA_VERSION, type RpcSchema } from '../index.js'
import type { ServerDescription } from './Introspection.js'

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

test('describe() serves capabilities from the schema, so a minified peer still advertises correctly', async (t) => {
    const schema: RpcSchema = {
        schema: SCHEMA_VERSION,
        namespaces: {
            renderer: {
                methods: { render: { params: [{ kind: 'string' }], paramNames: ['layout'], returns: { kind: 'string' } } },
                capabilities: ['@fixture/contracts/AdvancedRenderer', '@fixture/contracts/Renderer']
            }
        }
    }
    // The class name a bundler leaves behind: one letter, and describe() must not care. The
    // capabilities ride the schema embedded at build time, which is the whole of the rule that
    // discoverable means having an extracted contract.
    class m {
        async render(layout: string) {
            return layout
        }
    }
    const server = new RpcServer({ name: peer('minified3881'), transports: [{ port: 3881 }], schema, exposeIntrospection: true })
    await server.ready()
    server.exposeClassInstance(new m(), 'renderer')

    const client = new RpcClient('http://localhost:3881', { name: peer('finder3881'), defaultTarget: peer('minified3881') })
    await client.ready()
    const described = await (await client.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc')).describe()

    const renderer = described.namespaces.find((namespace) => namespace.name === 'renderer')
    t.is(renderer?.className, 'm', 'runtime reflection sees only the mangled name')
    t.deepEqual(renderer?.capabilities, ['@fixture/contracts/AdvancedRenderer', '@fixture/contracts/Renderer'], 'the schema does not')

    await client.close()
    await server.close()
})
