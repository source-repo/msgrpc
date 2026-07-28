import { RpcServer, TransportEvent, type Transport } from '@source-repo/msgrpc'

/**
 * A socket.io broker: an RpcServer that exposes nothing and exists only to relay.
 *
 * There is no separate broker implementation, and there should not be. A server already learns who
 * is connected, forwards a frame addressed to another peer, and tells every peer who else is there.
 * Running one with nothing exposed is what makes it a bus rather than a service - and that is worth
 * a command of its own only because typing it out is tedious, not because it is a different thing.
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
    const server = new RpcServer({
        name: options.name,
        transports: [{ port: options.port }, ...upstream.map((url) => ({ connect: url }))],
        // Nothing is exposed, so there is nothing to call here. A peer addressing the broker by
        // name gets ClassNotFound, which is the truth: it is a switchboard, not a service.
        readyTimeout: 15000
    })
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
    })

    return {
        server,
        /** Peers reachable through this broker right now, including any learned from an upstream. */
        peers: () => server.peers.names().filter((peer) => peer !== options.name).sort(),
        close: () => server.close()
    }
}
