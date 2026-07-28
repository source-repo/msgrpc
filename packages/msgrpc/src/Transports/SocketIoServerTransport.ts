import * as SocketIo from 'socket.io'
import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { createServer as createHttpsServer, Server as HttpsServer } from 'https'
import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { RpcAuthenticator, RpcIdentity } from '../RPC/Auth.js'
import { isUsablePeerName, MAX_CARRIED_PEERS, MAX_RELAY_HOPS, PRESENCE_EVENT, PresenceAnnouncement, PresenceUpdate, RelayContext, RelayRule } from './Presence.js'

type Servers = HttpServer | HttpsServer | SocketIo.Server

export class SocketIoServerTransport extends GenericModule<Message, unknown, Message, unknown> {
    closed = false
    /** Set when this transport can never come up - a port already in use, most often. */
    startupError?: unknown
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec
    io?: SocketIo.Server
    ourServer = false
    /**
     * Peer name -> the socket it was last seen on, learned from the source field of inbound frames.
     * Without it this transport can only broadcast, which puts every reply and every event on every
     * connected socket. Peer names are expected to be unique; the most recent socket wins, so a
     * reconnecting peer re-binds to its new socket on its first frame.
     */
    peerSockets = new Map<string, SocketIo.Socket>()
    /** Peer name -> the identity its connection authenticated as. Empty when no authenticator is set. */
    peerIdentities = new Map<string, RpcIdentity>()
    /**
     * Forward a frame addressed to another connected peer instead of handling it here. On by
     * default: a peer that can only be reached by dialling out - a browser page hosting an
     * RpcServer, most obviously - is reachable no other way. `false` keeps a server strictly
     * point-to-point, and a predicate decides per connection, which is the useful case: an
     * operator's page may deserve a route to a cell controller where a visitor's does not.
     */
    relay: RelayRule = true
    /**
     * What each connection says it can reach, beyond itself. Kept per socket so a link going away
     * takes exactly its own peers with it, and so a peer offered by two links can fall back to the
     * other one instead of vanishing.
     */
    private readonly carriedBy = new Map<SocketIo.Socket, Set<string>>()

    constructor(
        name: string,
        public server?: Servers,
        port?: number,
        https?: boolean,
        sources?: IGenericModule[],
        socketIoOptions: Partial<SocketIo.ServerOptions> = {},
        public authenticate?: RpcAuthenticator
    ) {
        super(name, sources)
        this.ourServer = server === undefined
        if (!server) this.server = https ? createHttpsServer() : createHttpServer()
        if (this.server instanceof SocketIo.Server) this.io = this.server
        else {
            this.io = new SocketIo.Server(this.server, {
                cors: {
                    origin: '*',
                    methods: ['GET', 'POST'],
                    credentials: true
                },
                serveClient: false,
                ...socketIoOptions
            })
        }
        // Runs before 'connection', so an unauthenticated peer never reaches the RPC layer.
        if (this.authenticate) {
            this.io.use(async (socket, next) => {
                try {
                    const identity = await this.authenticate!(socket.handshake.auth, { address: socket.handshake.address })
                    if (!identity) return next(new Error('unauthorized'))
                    socket.data.identity = identity
                    next()
                } catch {
                    next(new Error('unauthorized'))
                }
            })
        }
        this.io.on('connection', (socket) => {
            this.emit('connection', socket)
            socket.on(PRESENCE_EVENT, (announcement: PresenceAnnouncement) => {
                // Guarded because socket.io emits this synchronously from its parser: a listener
                // that throws unwinds into the engine rather than into anything that can report it.
                try {
                    this.onAnnouncement(socket, announcement)
                } catch (e) {
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: `bad presence announcement: ${String(e)}`, error: e })
                }
            })
            // The whole body is guarded, not just the parse: this is an async listener, so anything
            // that escapes it is an unhandled rejection, and Node's default is to end the process.
            // One peer sending one bad frame must not take down a server answering everybody else.
            socket.on('message', (messageArray) =>
                void this.onSocketMessage(socket, messageArray).catch((e) =>
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: `failed to handle frame: ${String(e)}`, error: e })
                )
            )
            socket.on('disconnect', (reason, details) => {
                this.carriedBy.delete(socket)
                for (const peer of [...this.peerSockets.keys()]) {
                    if (this.peerSockets.get(peer) !== socket) continue
                    // forgetPeer keeps it if another link still carries it; otherwise this is what
                    // lets the RPC layer drop the event subscriptions held for a peer that is gone.
                    this.forgetPeer(peer, socket)
                }
                // Emitted rather than printed. These used to go to console.log, which put three
                // lines of socket.io internals on the output of every disconnect and gave anything
                // above this transport no way to see them at all.
                this.emit(TransportEvent.disconnected, reason, details)
            })
        })
        if (this.server && this.ourServer && !(this.server instanceof SocketIo.Server)) {
            const listener = this.server
            // Without a handler Node throws on the unhandled 'error', so a port already in use took
            // the process down with a stack trace instead of a diagnosis.
            listener.on('error', (e) => {
                // Recorded as well as emitted. A listener that cannot bind never becomes ready, and
                // without this the only symptom was ready() timing out with nothing about the port.
                this.startupError = e
                this.emit(TransportEvent.transportError, e)
            })
            // Ready means listening. It used to be set here regardless, so ready() resolved before
            // the port was bound and a server could announce itself and then die of EADDRINUSE.
            listener.listen(port, () => {
                this.readyFlag = true
                console.log(`Socket.io server listening on port ${port}`)
            })
        } else this.readyFlag = true
    }

    private async onSocketMessage(socket: SocketIo.Socket, messageArray: ArrayBufferLike) {
        const [header, payload, reason] = this.extractHeader(new Uint8Array(messageArray))
        if (!header) {
            // Reported rather than dropped in silence, which the sender only ever saw as a timeout.
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: reason ?? 'no msgrpc header' })
            return
        }
        const identity = socket.data.identity as RpcIdentity | undefined
        if (this.authenticate) {
            // The source field is written by the sender. Pinning it to the identity this
            // connection authenticated as is what stops one peer addressing messages as
            // another and inheriting its rights.
            if (!identity || header.source !== identity.name) {
                this.emit(TransportEvent.rejected, { source: header.source, reason: 'source does not match authenticated identity' })
                return
            }
            this.peerIdentities.set(header.source, identity)
        }
        // Learned before the routing check, so a peer stays addressable even when a particular
        // frame turns out to be undeliverable.
        this.learnPeer(header.source, socket)
        let message: Message
        try {
            message = this.codec.decode(payload as Uint8Array) as Message
        } catch (e) {
            this.emit(TransportEvent.rejected, { source: header.source, reason: `undecodable frame: ${String(e)}` })
            return
        }
        // Whether this frame is for us at all. A server used to run whatever reached it, testing
        // the target only for being a name it had heard of - so a call addressed to another peer
        // was executed here, the addressee never saw it, and the caller was answered by the wrong
        // peer.
        const elsewhere = header.target !== this.name ? this.peerCarrying(header.target) : undefined
        if (elsewhere) {
            if (!this.mayRelay(header.source, header.target, identity)) {
                // Deliberately not falling through to local handling: running a call meant for a
                // peer this caller is not allowed to reach would answer it with the wrong
                // implementation and call that a success.
                this.emit(TransportEvent.unroutable, { source: header.source, target: header.target, reason: 'relay refused' })
                return
            }
            // Forwarding within this transport is done here rather than through receive(), so the
            // hop count survives it. A frame that has been round too many relays is dropped: tables
            // settle after a link fails, but a frame circling in the meantime never stops on its own.
            if (elsewhere === (this as IGenericModule)) {
                const hops = (header.hops ?? 0) + 1
                if (hops > MAX_RELAY_HOPS) {
                    this.emit(TransportEvent.unroutable, { source: header.source, target: header.target, reason: `over ${MAX_RELAY_HOPS} relays` })
                    return
                }
                this.forward(message, header.source, header.target, hops)
                return
            }
            await elsewhere.receive(message, header.source, header.target)
            return
        }
        if (this.targetExists(header.target)) {
            await this.send(message, header.source, header.target)
            return
        }
        // Neither this server nor anywhere it can forward to. Reported rather than dropped in
        // silence, which the caller only ever saw as an unexplained timeout.
        this.emit(TransportEvent.unroutable, { source: header.source, target: header.target })
    }

    /**
     * Which module carries a peer, or undefined to handle the frame here. The registry is shared
     * with this server's other transports, so a peer on the broker resolves to the MQTT transport
     * and a socket.io peer can call it without either end knowing the other's transport.
     */
    private peerCarrying(target: string) {
        if (this.peerSockets.has(target)) return this as IGenericModule
        // The registry is shared with this server's other transports, so a peer on the broker
        // resolves to the MQTT transport and a socket.io peer can reach it without either end
        // knowing which transport the other is on.
        const known = this.peerRegistry.get(target)
        return known && known !== (this as IGenericModule) && known.isTransport() ? known : undefined
    }

    /** Asked only once a frame really is deliverable elsewhere, never about a peer that is absent. */
    private mayRelay(source: string, target: string, identity?: RpcIdentity) {
        if (this.relay === false) return false
        if (typeof this.relay === 'function' && !this.permitted(source, target, identity)) return false
        this.warnAboutUnauthenticatedRelay()
        return true
    }

    /**
     * Routes a rule has already allowed, in both directions. Every call has a reply and most have
     * events after it, so asking a rule about each frame separately would mean `source === 'hmi'`
     * silently stranding the answer coming back - the reply's source is the far peer, not the hmi.
     * A permitted call opens the pair, the way connection tracking does, until one of them leaves.
     */
    private readonly openRoutes = new Set<string>()
    private static pair = (a: string, b: string) => `${a}\u0000${b}`

    private permitted(source: string, target: string, identity?: RpcIdentity) {
        if (this.openRoutes.has(SocketIoServerTransport.pair(source, target))) return true
        let allowed: boolean
        try {
            allowed = (this.relay as (context: RelayContext) => boolean)({ source, target, identity })
        } catch {
            // A rule that throws refuses, for the same reason an authorizer that throws denies.
            allowed = false
        }
        if (!allowed) return false
        this.openRoutes.add(SocketIoServerTransport.pair(source, target))
        this.openRoutes.add(SocketIoServerTransport.pair(target, source))
        return true
    }

    private forgetRoutes(peer: string) {
        const mark = `${peer}\u0000`
        for (const route of this.openRoutes) if (route.startsWith(mark) || route.endsWith(`\u0000${peer}`)) this.openRoutes.delete(route)
    }

    /** Named once each, so a peer that reconnects in a loop does not bury the first report. */
    private warnedAboutDisplacing = new Set<string>()
    private warnAboutDisplacement(name: string) {
        this.emit(TransportEvent.peerDisplaced, name)
        if (this.warnedAboutDisplacing.has(name)) return
        this.warnedAboutDisplacing.add(name)
        console.warn(
            `msgrpc: '${name}' announced itself on '${this.name}' while another live connection already held that name. ` +
                'The newcomer takes the address, so if both are really running, replies will reach the wrong one. Give them distinct names.'
        )
    }

    private warnedAboutRelay = false
    /**
     * Said once, and only when this server actually forwards something. Without an authenticator
     * the source of a frame is an unverified claim, so a relay passes on whatever it is told and
     * the peer at the far end has no way to tell who really sent it. Warning at construction would
     * fire for every ordinary server that never relays anything.
     */
    private warnAboutUnauthenticatedRelay() {
        if (this.warnedAboutRelay || this.authenticate) return
        this.warnedAboutRelay = true
        console.warn(
            `msgrpc: '${this.name}' is relaying frames between peers with no authenticate configured, so their source is an unverified claim. ` +
                'Set authenticate, or relay: false to forward nothing.'
        )
    }

    /**
     * Record a peer against the socket that reaches it and tell everyone else it is here.
     *
     * A peer announcing itself owns its name and takes the route over. One merely carried by a
     * neighbour does not: the first link to offer it keeps it, and a second offering the same name
     * is remembered only as a fallback. Letting carried announcements steal the route would make
     * two neighbours advertising the same peer flip it back and forth, each flip re-announced
     * onwards - chatter that never settles.
     */
    private learnPeer(name: string, socket: SocketIo.Socket, carried = false) {
        const known = this.peerSockets.get(name)
        if (known === socket) return
        if (known && carried) return
        // A live connection already answers to this name, and the newcomer is about to take the
        // address off it. The takeover is deliberate - a peer reconnecting after a blip announces
        // itself while the server may still hold the dead socket, and refusing it would lock a peer
        // out of its own name - but it must not be silent. Two peers genuinely sharing a name send
        // each other's replies into the wrong socket, which reads as calls timing out for no reason.
        if (known && known.connected) this.warnAboutDisplacement(name)
        this.peerSockets.set(name, socket)
        // Registered as well as recorded: the shared registry is what the switch routes on, and
        // what a server reads to work out which peers it can advertise onwards.
        this.setKnownSource(name)
        this.emit(TransportEvent.peerOnline, name)
        this.broadcastPresence({ peer: name, state: 'online' })
    }

    /** A peer is gone from here unless another link still offers it. */
    private forgetPeer(name: string, socket: SocketIo.Socket) {
        if (this.peerSockets.get(name) !== socket) return
        this.peerSockets.delete(name)
        this.peerIdentities.delete(name)
        for (const [other, carried] of this.carriedBy) {
            if (other === socket || !carried.has(name)) continue
            // Still reachable the other way, so nothing above this needs to hear about it.
            this.peerSockets.set(name, other)
            this.setKnownSource(name)
            return
        }
        this.emit(TransportEvent.peerGone, name)
        this.forgetRoutes(name)
        this.broadcastPresence({ peer: name, state: 'offline' })
    }

    /**
     * A peer saying who it is, which is the whole of discovery here. It answers with the peers
     * already connected, standing in for the retained presence an MQTT subscriber is handed.
     */
    private onAnnouncement(socket: SocketIo.Socket, announcement: PresenceAnnouncement) {
        const name = announcement?.name
        if (!isUsablePeerName(name)) {
            this.emit(TransportEvent.rejected, { source: String(name), reason: 'unusable peer name in presence announcement' })
            return
        }
        const identity = socket.data.identity as RpcIdentity | undefined
        if (this.authenticate) {
            // Same rule as a frame's source: a name is a claim until a connection vouches for it,
            // and an unchecked one here would let a peer be listed and addressed as someone else.
            if (!identity || name !== identity.name) {
                this.emit(TransportEvent.rejected, { source: name, reason: 'announced name does not match authenticated identity' })
                return
            }
            this.peerIdentities.set(name, identity)
        }
        this.learnPeer(name, socket)
        this.updateCarried(socket, name, announcement.carrying)
        // This peer's own name goes first: a newcomer has to know what to call the thing it just
        // connected to, and a client that routes on its registry - which RpcServer.proxy does -
        // cannot address the hub at all until something puts it there.
        //
        // Split horizon applies to the rest. Handing a link back the peers it just told this one
        // about makes it believe they are reachable the way it came, so it stops advertising them,
        // and they disappear from everyone a hop further out.
        socket.emit(PRESENCE_EVENT, {
            peers: [this.name, ...this.reachablePeers().filter((peer) => peer !== name && this.peerSockets.get(peer) !== socket)]
        } as PresenceUpdate)
    }

    /**
     * Everyone this server can put a frame in front of: its own connections, plus whatever its
     * other transports have registered. On a server holding a socket.io listener and a broker
     * connection, that is what lets a browser peer see and call a peer on the broker.
     */
    reachablePeers() {
        const names = new Set(this.peerSockets.keys())
        for (const name of this.peerRegistry.names()) names.add(name)
        names.delete(this.name)
        return [...names]
    }

    /** Tell the connected peers about one that arrived or left on a different transport. */
    announcePeer(peer: string, state: 'online' | 'offline') {
        if (this.peerSockets.has(peer)) return
        this.broadcastPresence({ peer, state })
    }

    /** Apply a link's latest claim about what lies behind it, adding and dropping as it changes. */
    private updateCarried(socket: SocketIo.Socket, announcer: string, carrying: string[] | undefined) {
        const claimed = new Set(
            (Array.isArray(carrying) ? carrying : [])
                .slice(0, MAX_CARRIED_PEERS)
                .filter((peer) => isUsablePeerName(peer) && peer !== this.name && peer !== announcer)
        )
        const previous = this.carriedBy.get(socket) ?? new Set<string>()
        this.carriedBy.set(socket, claimed)
        for (const peer of previous) if (!claimed.has(peer)) this.forgetPeer(peer, socket)
        for (const peer of claimed) if (!previous.has(peer)) this.learnPeer(peer, socket, true)
    }

    private broadcastPresence(update: PresenceUpdate) {
        // Everyone but the peer it is about; it already knows.
        const subject = update.peer ? this.peerSockets.get(update.peer) : undefined
        for (const socket of new Set(this.peerSockets.values())) if (socket !== subject) socket.emit(PRESENCE_EVENT, update)
    }

    /** Send to a peer's socket, carrying a hop count the ordinary send path has no reason to know. */
    forward(message: Message, source: string, target: string, hops: number) {
        const socket = this.peerSockets.get(target)
        if (!socket) {
            this.emit(TransportEvent.unroutable, { source, target })
            return
        }
        try {
            socket.emit('message', this.frameMessage(this.buildHeader(source, target, { hops }), this.codec.encode(message)))
        } catch (e) {
            // Relaying is done on someone else's behalf, so there is no caller here to reject.
            // Reported instead, or an unframeable relay would be indistinguishable from a lost one.
            this.emit(TransportEvent.unroutable, { source, target, reason: `cannot forward: ${String(e)}`, error: e })
        }
    }

    override async receive(message: Message, source: string, target: string) {
        const socket = target === undefined ? undefined : this.peerSockets.get(target)
        if (!socket) {
            // Deliberately no io.emit() fallback: broadcasting would put this peer's reply on
            // every other client's socket. An unknown target means the peer never identified
            // itself or has gone away, so the frame is dropped.
            this.emit(TransportEvent.unroutable, { source, target })
            return
        }
        socket.emit('message', this.frameMessage(this.buildHeader(source, target), this.codec.encode(message)))
    }

    override async close() {
        if (this.closed) {
            return
        }
        this.closed = true
        this.peerSockets.clear()
        this.peerIdentities.clear()
        const io = this.io
        const server = this.server
        this.io = undefined
        this.server = undefined
        this.emit('close')

        const ownHttpServer = server && this.ourServer && !(server instanceof SocketIo.Server) ? server : undefined
        io?.disconnectSockets(true)
        // Keep-alive connections would otherwise hold the listener open long past close().
        ownHttpServer?.closeAllConnections()
        if (io) await new Promise<void>((resolve) => io.close(() => resolve()))
        if (ownHttpServer?.listening) await new Promise<void>((resolve) => ownHttpServer.close(() => resolve()))
    }

    override getIdentity(source: string) {
        return this.peerIdentities.get(source)
    }

    override isTransport() {
        return true
    }
}
