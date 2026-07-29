import { RpcServer, TransportEvent, type RelayedFrame, type RpcSchema, type Transport } from '@source-repo/rpc'
import { BusService } from './bus.js'
// Extracted from bus.ts by `npm run contract` and committed, so a console pointed at a broker gets
// argument fields for tap() rather than `tap(…)`.
import contract from './bus.types.json' with { type: 'json' }

/**
 * A socket.io broker: an RpcServer that relays, and says what it is relaying when asked.
 *
 * There is no separate broker implementation, and there should not be. A server already learns who
 * is connected, forwards a frame addressed to another peer, and tells every peer who else is there.
 * Running one that way is what makes it a bus rather than a service - and that is worth a command
 * of its own only because typing it out is tedious, not because it is a different thing.
 *
 * It used to expose nothing at all, so a peer addressing it by name got ClassNotFound - true, and
 * the plainest possible statement that this is a switchboard. It now exposes exactly one namespace,
 * `bus`, because the alternative was a --tap flag, and a plant bus that has to be restarted before
 * it can be watched will not be watched: the run worth looking at is the one already going wrong.
 * The consequence is stated on startup, since anyone who can reach an unauthenticated broker can
 * now mirror everything crossing it - which they could always have done by impersonating a peer,
 * but not this conveniently. `authenticate` and `relay` are what gate it.
 *
 * With `upstream` it dials another broker as well, which makes the two one network: each side's
 * peers are advertised to the other, and a call crosses without either end knowing there was a hop.
 */

export interface BrokerOptions {
    /** Listens on every interface: the library's socket.io transport takes no bind address. */
    port: number
    name: string
    /** Brokers to join. Peers here become reachable from there, and the other way round. */
    upstream?: string[]
    /** Called for every arrival and departure, so a command line can show the network filling up. */
    onPeer?: (peer: string, state: 'online' | 'offline', where: string) => void
}

export const startBroker = async (options: BrokerOptions) => {
    const upstream = options.upstream ?? []
    const bus = new BusService(options.name)
    const server = new RpcServer({
        name: options.name,
        transports: [{ port: options.port }, ...upstream.map((url) => ({ connect: url }))],
        // The tap is the only thing here, and it describes itself: a console pointed at a broker
        // used to be told ClassNotFound, which is indistinguishable from a device whose server was
        // started without exposeIntrospection.
        schema: contract as RpcSchema,
        exposeIntrospection: true,
        readyTimeout: 15000
    })
    server.exposeClassInstance(bus)
    try {
        // ready() reports a listener that cannot bind rather than waiting it out.
        await server.ready()
    } catch (e) {
        // A broker that could not start still holds a socket.io server and whatever upstream links
        // it opened. Throwing without closing them leaves them behind for the life of the process.
        await server.close().catch(() => undefined)
        throw e
    }

    const where = (transport: Transport, index: number) => (index === 0 ? `:${options.port}` : (upstream[index - 1] ?? transport.getName()))
    server.transports.forEach((transport, index) => {
        transport.on(TransportEvent.peerOnline, (peer: string) => options.onPeer?.(peer, 'online', where(transport, index)))
        transport.on(TransportEvent.peerGone, (peer: string) => options.onPeer?.(peer, 'offline', where(transport, index)))
        // Attached for the life of the broker rather than added and removed with each tap: the
        // transport only emits this when something is listening, and `observe` returns on the first
        // line when no tap matches. Attaching on demand would mean a tap started mid-flight seeing
        // the traffic from whenever the listener happened to land instead.
        transport.on(TransportEvent.relayed, (relayed: RelayedFrame) => bus.observe(relayed))
    })

    return {
        server,
        /** The tap, so an embedder can watch frames without going through RPC to reach it. */
        bus,
        /** Peers reachable through this broker right now, including any learned from an upstream. */
        peers: () => server.peers.names().filter((peer) => peer !== options.name).sort(),
        close: async () => {
            await bus.releaseAll()
            await server.close()
        }
    }
}
