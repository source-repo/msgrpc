import test from 'ava'
import { PeerRegistry } from './RPC/Core.js'
import { RpcClient } from './RpcClient.js'
import { RpcServer } from './index.js'

class Echo {
    constructor(
        public label: string,
        public delay = 0
    ) {}
    async who() {
        // A delay makes both requests genuinely overlap. Without it the first reply is routed
        // before the second request registers its peer name, and the cross-routing this guards
        // against cannot occur - the test would pass whether or not the bug was present.
        if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay))
        return this.label
    }
}

test('the peer registry evicts least recently seen entries', (t) => {
    const registry = new PeerRegistry(3)
    registry.set('a', {} as never)
    registry.set('b', {} as never)
    registry.set('c', {} as never)
    // Touching 'a' makes it the most recent, so 'b' is the one that goes.
    registry.set('a', {} as never)
    registry.set('d', {} as never)

    t.is(registry.size, 3)
    t.truthy(registry.get('a'))
    t.falsy(registry.get('b'))
    t.truthy(registry.get('c'))
    t.truthy(registry.get('d'))
})

test('the peer registry stays bounded under a flood of unknown names', (t) => {
    // The keys come off the wire, so an unbounded map would be a remote memory-growth lever.
    const registry = new PeerRegistry(100)
    for (let i = 0; i < 5000; i++) registry.set(`peer-${i}`, {} as never)
    t.is(registry.size, 100)
})

test('two servers in one process do not cross-route peers sharing a name', async (t) => {
    // Peer names used to be recorded in a static shared by every module in the process, so the
    // second server to see a name captured the route and the first server's replies went out
    // through the second server's transport - to a different client entirely.
    const serverA = new RpcServer({ transports: [{ port: 3701 }] })
    const serverB = new RpcServer({ transports: [{ port: 3702 }] })
    await serverA.ready()
    await serverB.ready()
    serverA.exposeClassInstance(new Echo('A', 300), 'echo')
    serverB.exposeClassInstance(new Echo('B', 300), 'echo')

    // Deliberately the same peer name against both servers.
    const clientA = new RpcClient('http://localhost:3701', { name: 'shared-name', callTimeout: 2000 })
    const clientB = new RpcClient('http://localhost:3702', { name: 'shared-name', callTimeout: 2000 })
    await clientA.ready()
    await clientB.ready()

    const proxyA = await clientA.proxy<Echo>('echo')
    const proxyB = await clientB.proxy<Echo>('echo')
    const [fromA, fromB] = await Promise.all([proxyA.remote!.who(), proxyB.remote!.who()])

    t.is(fromA, 'A', 'client A received a reply from the wrong server')
    t.is(fromB, 'B', 'client B received a reply from the wrong server')

    await clientA.close()
    await clientB.close()
    await serverA.close()
    await serverB.close()
})

test('a server forgets a peer route when the peer goes away', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3703 }] })
    await server.ready()
    server.exposeClassInstance(new Echo('X'), 'echo')
    const client = new RpcClient('http://localhost:3703', { name: 'departing-peer' })
    await client.ready()
    await (await client.proxy<Echo>('echo')).remote!.who()

    t.truthy(server.peers.get('departing-peer'), 'the route was never recorded')

    await client.close()
    const deadline = Date.now() + 5000
    while (server.peers.get('departing-peer') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))

    t.falsy(server.peers.get('departing-peer'), 'the route outlived the peer')
    await server.close()
})
