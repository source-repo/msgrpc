import * as SocketIo from 'socket.io'
import { createServer as createHttpServer, Server as HttpServer } from 'http'
import { createServer as createHttpsServer, Server as HttpsServer } from 'https'
import { GenericModule, IGenericModule } from '../RPC/Core.js'

type Servers = HttpServer | HttpsServer | SocketIo.Server

export class SocketIoServerTransport extends GenericModule<string | Uint8Array, unknown, string | Uint8Array, unknown> {
    closed = false
    io?: SocketIo.Server
    ourServer = false

    constructor(
        name: string,
        public server?: Servers,
        port?: number,
        https?: boolean,
        sources?: IGenericModule[],
        socketIoOptions: Partial<SocketIo.ServerOptions> = {}
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
        this.io.on('connection', (socket) => {
            this.emit('connection', socket)
            socket.on('message', async (messageArray) => {
                const message = new Uint8Array(messageArray)
                const [header, payload] = this.extractHeader(message)
                if (header && this.targetExists(header.target)) await this.send(payload, header.source, header.target)
            })
            socket.on('disconnect', (reason, details) => {
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async receive(message: string | Uint8Array, source: string, target: string) {
        this.io?.emit('message', this.prependHeader(source, target, message))
    }

    async close() {
        if (this.closed) {
            return
        }
        this.io?.disconnectSockets()
        if (this.server && this.ourServer && !(this.server instanceof SocketIo.Server)) this.server.close()
        this.server = undefined
        this.closed = true
        this.emit('close')
        this.io?.close()
        this.io = undefined
    }

    isTransport() {
        return true
    }
}
