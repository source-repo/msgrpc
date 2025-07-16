import { io, ManagerOptions, Socket } from 'socket.io-client'
import { GenericModule, IGenericModule } from '../RPC/Core.js'

export class SocketIoClientTransport extends GenericModule<string | Uint8Array, unknown, string | Uint8Array, unknown> {
    socket?: Socket
    connected = false

    constructor(
        public url?: string,
        sources?: IGenericModule[],
        public options: Partial<ManagerOptions> = {}
    ) {
        super('', sources)
        this.open()
    }

    async close() {
        this.socket?.close()
        this.socket?.disconnect()
        this.socket = undefined
        this.connected = false
    }

    async open() {
        super.open()
        const urlSocketIo = this.url
        this.options = {
            rejectUnauthorized: false,
            ...this.options
        }
        this.socket = urlSocketIo ? io(urlSocketIo, this.options) : io(this.options)
        this.socket.on('message', async (messageArray) => {
            try {
                const message = new Uint8Array(messageArray)
                const [header, payload] = this.extractHeader(message)
                if (header && this.targetExists(header.target)) await this.send(payload, header.source, header.target)
            } catch (e) {
                console.log('Exception: ', e)
            }
        })
        this.socket.on('connect', () => {
            this.connected = true
            this.readyFlag = true
        })
        this.socket.on('disconnect', () => {
            this.connected = false
        })
    }

    async receive(message: string | Uint8Array, source: string, target: string) {
        if (!this.connected) await new Promise((res) => setTimeout(res, 1000))
        this.socket?.emit('message', this.prependHeader(source, target, message))
    }

    isTransport() {
        return true
    }
}
