import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client'
import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'
import { refuseDelivery } from '../RPC/Undeliverable.js'
import { isUsablePeerName, MAX_RELAY_HOPS, PRESENCE_EVENT, PresenceAnnouncement, PresenceUpdate } from './Presence.js'

export class SocketIoClientTransport extends GenericModule<Message, unknown, Message, unknown> {
    socket?: Socket
    connected = false
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec
    /** Peers this transport has been told are online, so a reconnect can report only what changed. */
    readonly knownPeers = new Set<string>()
    /** Peers reachable through whatever owns this transport, advertised to the far end. */
    private carrying: string[] = []

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
        public announcePresence = true,
        /**
         * Connect to an `https://` or `wss://` server without checking its certificate.
         *
         * This used to be the default, and it should never have been: it accepts any certificate at
         * all, so anything able to answer on the server's address can read and rewrite everything
         * sent over the link - which on this library's traffic means industrial commands. Left as a
         * deliberate, named choice for a development server with a self-signed certificate. A plant
         * with its own certificate authority should pass `ca` in the socket options instead, which
         * keeps verification on.
         */
        public allowInsecureTls = false
    ) {
        super(name, sources)
        // Deferred by a microtask so whatever constructs this transport can finish wiring it
        // before the link comes up. A resumed MQTT session is delivered its queued messages the
        // instant it connects, and a frame arriving before the RPC handler is piped in would find
        // no target and be dropped. A fresh session never exposes this, because nothing arrives
        // that early.
        queueMicrotask(() => void this.open().catch((e) => this.emit(TransportEvent.transportError, e)))
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
        //
        // Awaited, because disconnect() only *starts* the close: it sends a close packet and
        // returns, leaving the engine's ping timer armed until the transport is actually torn down.
        // Returning before that makes close() a promise that resolves while the connection it was
        // supposed to close is still running.
        const engine = socket.io.engine
        const closed =
            socket.connected && engine
                ? new Promise<void>((resolve) => {
                      // Bounded: a close that never completes must not hang the caller forever.
                      const settle = setTimeout(resolve, 2000)
                      settle.unref?.()
                      engine.once('close', () => {
                          clearTimeout(settle)
                          resolve()
                      })
                  })
                : Promise.resolve()
        socket.disconnect()
        await closed
        socket.removeAllListeners()
        this.knownPeers.clear()
    }

    override async open() {
        // Idempotent: the constructor opens, and RpcClient.init() opens again. Without this guard
        // every client ends up with a second, orphaned socket that stays connected forever.
        if (this.socket) return
        // Deliberately not awaited. The base hook is a no-op, and awaiting it yields before the
        // socket below is assigned - which lets a second open() past the guard above and leaves the
        // first socket orphaned and reconnecting forever, exactly what the guard is here to prevent.
        void super.open()
        const urlSocketIo = this.url
        // Certificate verification is Node's default and stays on. It was turned off here for
        // every client, before the caller's own options were applied, so a Node peer accepted an
        // impersonated TLS server unless whoever wrote it knew to turn verification back on.
        if (this.allowInsecureTls) {
            // Spread after, so a caller that asks for both gets the safer of the two.
            this.options = { rejectUnauthorized: false, ...this.options }
            this.warnAboutInsecureTls()
        }
        this.socket = urlSocketIo ? io(urlSocketIo, this.options) : io(this.options)
        this.socket.on('message', async (messageArray) => {
            try {
                const [header, payload, reason] = this.extractHeader(new Uint8Array(messageArray))
                if (!header) {
                    // Reported rather than dropped in silence, which showed up only as a timeout.
                    this.emit(TransportEvent.rejected, { source: 'unknown', reason: reason ?? 'no msgrpc header' })
                    return
                }
                const message = this.codec.decode(payload as Uint8Array) as Message
                await this.deliver(message, header.source, header.target, header.hops ?? 0)
            } catch (e) {
                // A peer that sends a frame this codec cannot read must not take the client down.
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `undecodable frame: ${String(e)}`, error: e })
            }
        })
        this.socket.on(PRESENCE_EVENT, (update: PresenceUpdate) => {
            // socket.io emits synchronously from its parser, so a listener that throws unwinds into
            // the engine rather than anywhere that could report it.
            try {
                this.onPresence(update)
            } catch (e) {
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `bad presence update: ${String(e)}`, error: e })
            }
        })
        // socket.io emits 'connect' on reconnects too, so this fires on every transition.
        this.socket.on('connect', () => {
            this.connected = true
            this.readyFlag = true
            // Announced on every connect, not only the first: the server forgets a peer when its
            // socket drops, so a reconnected peer that stayed silent would be unaddressable.
            if (this.announcePresence) this.announce()
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

    /**
     * Said once per transport, and only where it means anything: the flag has no effect on a plain
     * `http://` link, and warning about one would teach people to ignore the warning.
     */
    private warnAboutInsecureTls() {
        if (!this.url || !/^(https|wss):/i.test(this.url)) return
        console.warn(
            `source-rpc: '${this.name}' is connecting to ${this.url} with allowInsecureTls, so the server's certificate is not checked. ` +
                'Anything able to answer on that address can read and rewrite this link. Use it for a development server, not a plant.'
        )
    }

    /**
     * A peer heard about through this link is routable through it - but only if nothing already
     * reaches it. A server that serves a peer locally must not start sending its traffic up to the
     * hub and back, and it would, since the hub lists that peer like any other.
     */
    private registerIfUnrouted(peer: string) {
        if (this.peerRegistry.get(peer)) return
        this.setKnownSource(peer)
    }

    private announce() {
        const announcement: PresenceAnnouncement = { name: this.name }
        if (this.carrying.length) announcement.carrying = this.carrying
        this.socket?.emit(PRESENCE_EVENT, announcement)
    }

    /**
     * Say which peers can be reached through this connection. Sent again whenever the set changes,
     * which is how a peer appearing three hops away eventually becomes addressable from here.
     */
    advertise(peers: string[]) {
        const next = [...peers].sort()
        if (next.length === this.carrying.length && next.every((peer, index) => peer === this.carrying[index])) return
        this.carrying = next
        if (this.connected && this.announcePresence) this.announce()
    }

    /** The server's view of who else is connected, turned into the same events MQTT emits. */
    private onPresence(update: PresenceUpdate) {
        if (Array.isArray(update.peers)) {
            for (const peer of update.peers) {
                if (!isUsablePeerName(peer) || peer === this.name || this.knownPeers.has(peer)) continue
                this.knownPeers.add(peer)
                this.registerIfUnrouted(peer)
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
            this.registerIfUnrouted(update.peer)
            this.emit(TransportEvent.peerOnline, update.peer)
        }
    }

    /**
     * Hand a frame to this peer's own handlers, or on to whichever transport reaches its addressee.
     * The second case is what makes a server that is both a hub for its own peers and a member of a
     * bus work: a call for one of its peers arrives down this link and has to be passed inwards,
     * not answered here. Without it the frame reached the right process and was refused by it.
     */
    private async deliver(message: Message, source: string, target: string, hops: number) {
        if (target !== this.name) {
            const carrier = this.peerRegistry.get(target)
            if (carrier && carrier !== (this as IGenericModule) && carrier.isTransport()) {
                if (hops + 1 > MAX_RELAY_HOPS) {
                    await refuseDelivery(this, message, source, target, 'TransportError', `over ${MAX_RELAY_HOPS} relays`)
                    return
                }
                const relay = carrier as { forward?: (message: Message, source: string, target: string, hops: number) => void }
                if (relay.forward) relay.forward(message, source, target, hops + 1)
                else await carrier.receive(message, source, target)
                return
            }
        }
        if (this.targetExists(target)) {
            await this.send(message, source, target)
            return
        }
        await refuseDelivery(this, message, source, target, 'TransportError', `no route to '${target}'`)
    }

    /** Send over this link with a hop count, for a frame being passed along rather than originated. */
    forward(message: Message, source: string, target: string, hops: number) {
        try {
            this.requireSocket().emit('message', this.frameMessage(this.buildHeader(source, target, { hops }), this.codec.encode(message)))
        } catch (e) {
            // Relaying is done for someone else, so there is no caller here to reject.
            this.emit(TransportEvent.unroutable, { source, target, reason: `cannot forward: ${String(e)}`, error: e })
        }
    }

    /**
     * The link, or an error saying there is none.
     *
     * Sending went through `this.socket?.emit(...)`, which is a no-op once the transport is closed -
     * so an outgoing call was discarded without a word and its caller waited out the full timeout
     * for a frame that was never going to be sent.
     */
    private requireSocket() {
        if (!this.socket) throw new Error(`SocketIoClientTransport '${this.name}': not connected to ${this.url ?? 'the default url'}`)
        return this.socket
    }

    override async receive(message: Message, source: string, target: string) {
        // No blind sleep while disconnected: socket.io already buffers outgoing frames and flushes
        // them on reconnect, so sleeping only delayed every send during a blip without helping.
        // If the link never comes back the call fails on its own timeout.
        this.requireSocket().emit('message', this.frameMessage(this.buildHeader(source, target), this.codec.encode(message)))
    }

    override isTransport() {
        return true
    }
}
