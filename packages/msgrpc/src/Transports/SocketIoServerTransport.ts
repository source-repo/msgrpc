import * as SocketIo from 'socket.io'
import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { createServer as createHttpsServer, Server as HttpsServer } from 'https'
import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { RpcAuthenticator, RpcIdentity } from '../RPC/Auth.js'

type Servers = HttpServer | HttpsServer | SocketIo.Server

export class SocketIoServerTransport extends GenericModule<Message, unknown, Message, unknown> {
    closed = false
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
            socket.on('message', async (messageArray) => {
                let header, payload
                try {
                    ;[header, payload] = this.extractHeader(new Uint8Array(messageArray))
                } catch (e) {
                    // A malformed frame from one peer must not take the whole server down.
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: `unparsable header: ${String(e)}` })
                    return
                }
                if (!header) return
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
                // Learned before the routing check, so a peer stays addressable even when a
                // particular frame turns out to be undeliverable.
                this.peerSockets.set(header.source, socket)
                let message: Message
                try {
                    message = this.codec.decode(payload as Uint8Array) as Message
                } catch (e) {
                    this.emit(TransportEvent.rejected, { source: header.source, reason: `undecodable frame: ${String(e)}` })
                    return
                }
                if (this.targetExists(header.target)) await this.send(message, header.source, header.target)
            })
            socket.on('disconnect', (reason, details) => {
                for (const [peer, peerSocket] of this.peerSockets) {
                    if (peerSocket !== socket) continue
                    this.peerSockets.delete(peer)
                    this.peerIdentities.delete(peer)
                    // Lets the RPC layer drop any event subscriptions held for this peer instead
                    // of emitting to a socket that is gone.
                    this.emit(TransportEvent.peerGone, peer)
                }
                if (details) {
                    // the low-level reason of the disconnection, for example "xhr post error"
                    console.log(details.message)

                    // some additional description, for example the status code of the HTTP response
                    console.log(details.description)

                    // some additional context, for example the XMLHttpRequest object
                    console.log(details.context)
                }
            })
        })
        if (this.server && this.ourServer && !(this.server instanceof SocketIo.Server))
            this.server.listen(port, () => {
                console.log(`Socket.io server listening on port ${port}`)
            })
        this.readyFlag = true
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
