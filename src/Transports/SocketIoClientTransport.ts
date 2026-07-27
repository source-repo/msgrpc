import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client'
import { GenericModule, IGenericModule, Message, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, msgPackCodec } from '../RPC/Codec.js'

export class SocketIoClientTransport extends GenericModule<Message, unknown, Message, unknown> {
    socket?: Socket
    connected = false
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec

    constructor(
        public url?: string,
        sources?: IGenericModule[],
        // SocketOptions carries `auth`, which is how credentials reach an authenticating server.
        public options: Partial<ManagerOptions & SocketOptions> = {}
    ) {
        super('', sources)
        this.open()
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
        // socket.io emits 'connect' on reconnects too, so this fires on every transition.
        this.socket.on('connect', () => {
            this.connected = true
            this.readyFlag = true
            this.emit(TransportEvent.connected)
        })
        this.socket.on('disconnect', (reason) => {
            this.connected = false
            this.readyFlag = false
            this.emit(TransportEvent.disconnected, reason)
        })
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
