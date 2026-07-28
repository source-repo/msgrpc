import { createServer, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'events'
import {
    MqttTransport,
    RpcClient,
    SocketIoClientTransport,
    type Transport,
    RpcServer,
    TransportEvent,
    rpc,
    rpcNamespace,
    type MessageSigner,
    type MessageVerifier,
    type ServerDescription
} from '@source-repo/msgrpc'

/**
 * A browser console for a live msgrpc network: which peers are up, what each one exposes, and a
 * form to call it and watch its events.
 *
 * Peer discovery is nearly free. Every peer publishes retained presence, so subscribing to
 * <prefix>/presence/+ hands over everyone already online immediately - no scanning, no probing.
 *
 * The browser reaches this over msgrpc itself. The CLI runs an RpcServer on the same HTTP server
 * that serves the page, so calls and the event stream both ride the library rather than a REST and
 * SSE pair written for the occasion - and the console becomes the library's own first client.
 */

/** The name the browser addresses this console by. Its own peer name on MQTT is a separate thing. */
export const consolePeer = 'msgrpc-console'

export interface ConsoleOptions {
    /** Watch an MQTT network. Either this or `hub`, or both. */
    broker?: string
    /**
     * Watch a socket.io network by connecting to a hub. Peers there announce themselves on connect,
     * which is how a network with no broker - and a server hosted in a browser page, which cannot
     * listen at all - becomes visible.
     */
    hub?: string
    /** Handshake credentials for a hub that authenticates. No flag: a secret does not belong in `ps`. */
    hubCredentials?: unknown
    prefix?: string
    port: number
    host: string
    name: string
    callTimeout: number
    /**
     * Sign outgoing frames. Without this the console cannot talk to a server configured with
     * `verify`: it still discovers peers, because presence is unsigned retained state, and then
     * every call times out with nothing to say why.
     */
    sign?: MessageSigner
    /** Require and check signatures on incoming frames. Optional even when signing. */
    verify?: MessageVerifier
}

type Subscribable = {
    on: (event: string, handler: (...args: unknown[]) => void) => void
    off: (event: string, handler: (...args: unknown[]) => void) => void
}

/** What a browser may ask this console to do. Everything else on the class stays local. */
@rpcNamespace('console')
export class ConsoleService extends EventEmitter {
    /**
     * Subscriptions this console holds on the network, keyed by peer/namespace/event. The handler
     * is kept because removing a listener needs the same function reference that was registered.
     */
    readonly watching = new Map<string, (...args: unknown[]) => void>()

    constructor(
        /**
         * One client per network the console watches, and the peer that was discovered on it. A
         * peer's name says nothing about how to reach it, so the link it was seen on is what
         * decides which client makes the call.
         */
        private readonly online: Map<string, RpcClient>,
        /** How long this console waits on the network, reported so the browser can wait longer. */
        private readonly callTimeout: number
    ) {
        super()
    }

    /** The client that discovered a peer, or a plain error if nothing has. */
    private clientFor(peer: string) {
        const client = this.online.get(peer)
        if (!client) throw Object.assign(new Error(`${peer} is not a peer this console can see`), { code: 'ClassNotFound' })
        return client
    }

    @rpc
    async peers() {
        return { peers: [...this.online.keys()].sort(), watching: [...this.watching.keys()], callTimeout: this.callTimeout }
    }

    @rpc
    async describe(peer: string): Promise<ServerDescription | { error: string; code?: string }> {
        try {
            const proxy = await this.clientFor(peer).proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc', peer)
            return await proxy.remote!.describe()
        } catch (e) {
            return asFailure(e)
        }
    }

    @rpc
    async call(peer: string, namespace: string, method: string, args: unknown[] = []): Promise<{ result?: unknown; error?: string; code?: string; ms: number }> {
        const started = Date.now()
        try {
            const proxy = await this.clientFor(peer).proxy<Record<string, (...a: unknown[]) => Promise<unknown>>>(namespace, peer)
            return { result: await proxy.remote![method](...args), ms: Date.now() - started }
        } catch (e) {
            // Reported rather than thrown: an RpcError's code is the useful part, and it would be
            // flattened into a generic exception on its way back to the browser.
            return { ...asFailure(e), ms: Date.now() - started }
        }
    }

    @rpc
    async watch(peer: string, namespace: string, event: string) {
        const key = `${peer}/${namespace}/${event}`
        if (this.watching.has(key)) return { watching: true, already: true }
        const handler = (...args: unknown[]) => this.emit('event', { peer, namespace, event, args, at: Date.now() })
        const proxy = await this.clientFor(peer).proxy<Subscribable>(namespace, peer)
        await proxy.remote!.on(event, handler)
        this.watching.set(key, handler)
        return { watching: true, already: false }
    }

    @rpc
    async unwatch(peer: string, namespace: string, event: string) {
        const key = `${peer}/${namespace}/${event}`
        const handler = this.watching.get(key)
        if (!handler) return { watching: false, already: true }
        const proxy = await this.clientFor(peer).proxy<Subscribable>(namespace, peer)
        // Removes the local listener and tells the server to drop its side.
        await proxy.remote!.off(event, handler)
        this.watching.delete(key)
        return { watching: false, already: false }
    }

    /** Drops every subscription this console holds, so servers that outlive it keep no listeners. */
    async releaseAll() {
        for (const key of [...this.watching.keys()]) {
            const [peer, namespace, event] = key.split('/')
            await this.unwatch(peer, namespace, event).catch(() => undefined)
        }
    }
}

const asFailure = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    return { error: error.message ?? String(e), code: error.code }
}

/** The built app, sitting next to this file once the CLI is compiled. */
const webRoot = fileURLToPath(new URL('./web/', import.meta.url))

const contentTypes: { [extension: string]: string } = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
}

const serveAsset = async (pathname: string, response: ServerResponse) => {
    const requested = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
    const file = resolvePath(join(webRoot, requested))
    // The path comes from a URL, so it has to be proven to stay inside the asset directory rather
    // than assumed to: `..` segments survive both the join and the decode.
    const inside = file === resolvePath(webRoot) || file.startsWith(resolvePath(webRoot) + sep)
    try {
        if (!inside) throw Object.assign(new Error('outside'), { code: 'ENOENT' })
        const body = await readFile(file)
        response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' })
        response.end(body)
    } catch {
        // One page, client-side state: an unknown path is a route, not a missing file.
        try {
            const index = await readFile(join(webRoot, 'index.html'))
            response.writeHead(200, { 'content-type': contentTypes['.html'] })
            response.end(index)
        } catch {
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('The console app is not built. Run `npm run build` in @source-repo/msgrpc-cli.\n')
        }
    }
}

export const startConsole = async (options: ConsoleOptions) => {
    if (!options.broker && !options.hub) throw new Error('startConsole: give it a broker, a hub, or both')

    /** Peer -> the client that discovered it. A peer seen on both links is answered on whichever spoke first. */
    const online = new Map<string, RpcClient>()
    const service = new ConsoleService(online, options.callTimeout)
    const clients: RpcClient[] = []

    /** Wire one network's presence into the single list the browser sees. */
    const watchNetwork = (transport: Transport, client: RpcClient) => {
        clients.push(client)
        transport.on(TransportEvent.peerOnline, (peer: string) => {
            if (online.has(peer)) return
            online.set(peer, client)
            service.emit('peer', { peer, state: 'online' })
        })
        transport.on(TransportEvent.peerGone, (peer: string) => {
            // Only if it left the link it was found on; the same name on the other link is a
            // different peer as far as routing is concerned.
            if (online.get(peer) !== client) return
            online.delete(peer)
            service.emit('peer', { peer, state: 'offline' })
        })
    }

    if (options.broker) {
        const transport = new MqttTransport(options.name, options.broker, {
            ...(options.prefix ? { prefix: options.prefix } : {}),
            ...(options.sign ? { sign: options.sign } : {}),
            ...(options.verify ? { verify: options.verify } : {})
        })
        watchNetwork(transport, new RpcClient(undefined, { name: options.name, transport, callTimeout: options.callTimeout }))
    }
    if (options.hub) {
        // An ordinary socket.io peer of the hub. Announcing itself is what makes the hub willing to
        // relay to it, and what puts every other peer's presence on this connection.
        const transport = new SocketIoClientTransport(options.name, options.hub, [], {
            ...(options.hubCredentials ? { auth: options.hubCredentials as { [key: string]: unknown } } : {})
        })
        watchNetwork(transport, new RpcClient(undefined, { name: options.name, transport, callTimeout: options.callTimeout }))
    }
    await Promise.all(clients.map((client) => client.ready()))

    const http = createServer((request, response) => {
        // serveAsset handles its own failures, so reaching this catch means the response itself
        // could not be written. Answering is still better than rejecting into nowhere.
        void serveAsset(new URL(request.url ?? '/', 'http://console').pathname, response).catch(() => {
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('The console could not serve this request.\n')
        })
    })
    // socket.io attaches to the same server and answers /socket.io before this handler sees it, so
    // the console is one port: the page and the RPC link arrive over the same origin.
    const browserFacing = new RpcServer({ name: consolePeer, transports: [{ server: http }], readyTimeout: 5000 })
    browserFacing.exposeClassInstance(service)
    await browserFacing.ready()

    await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve))

    return {
        url: `http://${options.host}:${options.port}`,
        service,
        close: async () => {
            await service.releaseAll()
            await browserFacing.close()
            await new Promise<void>((resolve) => http.close(() => resolve()))
            await Promise.all(clients.map((client) => client.close()))
        }
    }
}
