import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client'
import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { isUsablePeerName, PRESENCE_EVENT, PresenceUpdate } from './Presence.js'

export class SocketIoClientTransport extends GenericModule<Message, unknown, Message, unknown> {
    socket?: Socket
    connected = false
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec
    /** Peers this transport has been told are online, so a reconnect can report only what changed. */
    readonly knownPeers = new Set<string>()

    constructor(
        /**
         * The peer name this transport announces itself under, which is what makes it findable and
         * addressable. Taking it here mirrors MqttTransport, where the name has always been needed
         * to subscribe to the peer's own topic.
         */
        name: string,
        public url?: string,
        sources?: IGenericModule[],
        // SocketOptions carries `auth`, which is how credentials reach an authenticating server.
        public options: Partial<ManagerOptions & SocketOptions> = {},
        /** Announce on connect. Off leaves this peer unlisted and unaddressable, as before. */
        public announcePresence = true
    ) {
        super(name, sources)
        // Deferred by a microtask so whatever constructs this transport can finish wiring it
        // before the link comes up. A resumed MQTT session is delivered its queued messages the
        // instant it connects, and a frame arriving before the RPC handler is piped in would find
        // no target and be dropped. A fresh session never exposes this, because nothing arrives
        // that early.
        queueMicrotask(() => void this.open())
    }

    override async close() {
        const socket = this.socket
        this.socket = undefined
        this.connected = false
        this.readyFlag = false
        if (!socket) return
        // Disarm reconnection before disconnecting. An explicit close is not a link failure, and
        // a manager left free to reconnect keeps a timer armed that outlives the transport.
        // reconnection(false) is the setter; assigning to opts.reconnection does not reach the
        // manager's own flag and left the timer armed anyway.
        socket.io.reconnection(false)
        // Only disconnect() - close() is an alias for it, and calling both corrupted the manager's
        // socket bookkeeping.
        socket.disconnect()
        socket.removeAllListeners()
        this.knownPeers.clear()
    }

    override async open() {
        // Idempotent: the constructor opens, and RpcClient.init() opens again. Without this guard
        // every client ends up with a second, orphaned socket that stays connected forever.
        if (this.socket) return
        super.open()
        const urlSocketIo = this.url
        this.options = {
            rejectUnauthorized: false,
            ...this.options
        }
        this.socket = urlSocketIo ? io(urlSocketIo, this.options) : io(this.options)
        this.socket.on('message', async (messageArray) => {
            try {
                const [header, payload] = this.extractHeader(new Uint8Array(messageArray))
                if (!header) return
                const message = this.codec.decode(payload as Uint8Array) as Message
                if (this.targetExists(header.target)) await this.send(message, header.source, header.target)
            } catch (e) {
                // A peer that sends a frame this codec cannot read must not take the client down.
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `undecodable frame: ${String(e)}` })
            }
        })
        this.socket.on(PRESENCE_EVENT, (update: PresenceUpdate) => this.onPresence(update))
        // socket.io emits 'connect' on reconnects too, so this fires on every transition.
        this.socket.on('connect', () => {
            this.connected = true
            this.readyFlag = true
            // Announced on every connect, not only the first: the server forgets a peer when its
            // socket drops, so a reconnected peer that stayed silent would be unaddressable.
            if (this.announcePresence) this.socket?.emit(PRESENCE_EVENT, { name: this.name })
            this.emit(TransportEvent.connected)
        })
        this.socket.on('disconnect', (reason) => {
            this.connected = false
            this.readyFlag = false
            // Nothing is reachable through a link that is down, and the server will send a fresh
            // snapshot when it comes back. Reported so a console can grey the whole list out.
            for (const peer of [...this.knownPeers]) {
                this.knownPeers.delete(peer)
                this.emit(TransportEvent.peerGone, peer)
            }
            this.emit(TransportEvent.disconnected, reason)
        })
    }

    /** The server's view of who else is connected, turned into the same events MQTT emits. */
    private onPresence(update: PresenceUpdate) {
        if (Array.isArray(update.peers)) {
            for (const peer of update.peers) {
                if (!isUsablePeerName(peer) || peer === this.name || this.knownPeers.has(peer)) continue
                this.knownPeers.add(peer)
                this.emit(TransportEvent.peerOnline, peer)
            }
            return
        }
        if (!isUsablePeerName(update.peer) || update.peer === this.name) return
        if (update.state === 'offline') {
            if (!this.knownPeers.delete(update.peer)) return
            this.emit(TransportEvent.peerGone, update.peer)
        } else {
            if (this.knownPeers.has(update.peer)) return
            this.knownPeers.add(update.peer)
            this.emit(TransportEvent.peerOnline, update.peer)
        }
    }

    override async receive(message: Message, source: string, target: string) {
        // No blind sleep while disconnected: socket.io already buffers outgoing frames and flushes
        // them on reconnect, so sleeping only delayed every send during a blip without helping.
        // If the link never comes back the call fails on its own timeout.
        this.socket?.emit('message', this.frameMessage(this.buildHeader(source, target), this.codec.encode(message)))
    }

    override isTransport() {
        return true
    }
}
