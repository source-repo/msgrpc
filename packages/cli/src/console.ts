import { createServer, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'events'
import {
    MqttTransport,
    SocketIoClientTransport,
    RpcServer,
    TransportEvent,
    rpc,
    rpcNamespace,
    type MessageSigner,
    type MessageVerifier,
    type RpcSchema,
    type ServerDescription
} from '@source-repo/msgrpc'
// Extracted from this file by `npm run contract`, and committed so it is reviewable and so
// `msgrpc check` can catch a change to the service that would refuse a page built against the old
// one. The console describing itself with the same machinery it shows other peers is the point:
// what it cannot describe here, nobody else can describe either.
import contract from './console.types.json' with { type: 'json' }

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

/**
 * Where the page learns which peer to address. Everything else the console offers is RPC, but a
 * client has to know the name before it can call anything, and the console's name is now its name
 * on the network rather than a constant - two consoles on one bus cannot both be 'msgrpc-console'.
 */
export const consoleIdentityPath = '/console.json'

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

    /**
     * The console's own place on the network, set once it exists. Every call the browser asks for
     * goes out through this: one server holding the browser link, the broker and the hub, so a
     * peer's name is enough - the registry knows which link reaches it.
     */
    private network?: RpcServer

    useNetwork(network: RpcServer) {
        this.network = network
    }

    constructor(
        /** Every peer the console can see, on any of its links. */
        private readonly online: Set<string>,
        /** How long this console waits on the network, reported so the browser can wait longer. */
        private readonly callTimeout: number
    ) {
        super()
    }

    /** Refuses early for a peer nothing has announced, rather than waiting out a call timeout. */
    private reach(peer: string) {
        if (!this.network || !this.online.has(peer)) throw Object.assign(new Error(`${peer} is not a peer this console can see`), { code: 'ClassNotFound' })
        return this.network
    }

    @rpc
    async peers() {
        return { peers: [...this.online].sort(), watching: [...this.watching.keys()], callTimeout: this.callTimeout }
    }

    @rpc
    async describe(peer: string): Promise<ServerDescription | { error: string; code?: string }> {
        try {
            const proxy = await this.reach(peer).proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc', peer)
            return await proxy.remote!.describe()
        } catch (e) {
            return asFailure(e)
        }
    }

    @rpc
    async call(peer: string, namespace: string, method: string, args: unknown[] = []): Promise<{ result?: unknown; error?: string; code?: string; ms: number }> {
        const started = Date.now()
        try {
            const proxy = await this.reach(peer).proxy<Record<string, (...a: unknown[]) => Promise<unknown>>>(namespace, peer)
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
        const proxy = await this.reach(peer).proxy<Subscribable>(namespace, peer)
        await proxy.remote!.on(event, handler)
        this.watching.set(key, handler)
        return { watching: true, already: false }
    }

    @rpc
    async unwatch(peer: string, namespace: string, event: string) {
        const key = `${peer}/${namespace}/${event}`
        const handler = this.watching.get(key)
        if (!handler) return { watching: false, already: true }
        const proxy = await this.reach(peer).proxy<Subscribable>(namespace, peer)
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

const serveAsset = async (pathname: string, response: ServerResponse, identity?: { name: string }) => {
    if (pathname === consoleIdentityPath && identity) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(identity))
        return
    }
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

    /** Every peer the console can see, on any of its links. */
    const online = new Set<string>()
    const service = new ConsoleService(online, options.callTimeout)

    const http = createServer((request, response) => {
        // serveAsset handles its own failures, so reaching this catch means the response itself
        // could not be written. Answering is still better than rejecting into nowhere.
        void serveAsset(new URL(request.url ?? '/', 'http://console').pathname, response, { name: options.name }).catch(() => {
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('The console could not serve this request.\n')
        })
    })
    // One server, one graph. The browsers, the broker and the hub are transports of the same
    // RpcServer, so its peer registry spans all of them: a page is a peer of the network rather
    // than something behind a separate client, and the console relays between the two the way any
    // server does. That is what lets a service hosted in a page be reached from the plant, and it
    // is why the console can call anything with one proxy() rather than a client per network.
    const network = new RpcServer({
        name: options.name,
        callTimeout: options.callTimeout,
        readyTimeout: 15000,
        // So another console can describe this one and get argument fields rather than `call(…)`.
        schema: contract as RpcSchema,
        exposeIntrospection: true,
        transports: [
            // socket.io attaches to the same http server and answers /socket.io before the static
            // handler sees it, so the console is one port: page and RPC over the same origin.
            { server: http },
            ...(options.broker
                ? [
                      new MqttTransport(options.name, options.broker, {
                          ...(options.prefix ? { prefix: options.prefix } : {}),
                          ...(options.sign ? { sign: options.sign } : {}),
                          ...(options.verify ? { verify: options.verify } : {})
                      })
                  ]
                : []),
            ...(options.hub
                ? [
                      new SocketIoClientTransport(options.name, options.hub, [], {
                          ...(options.hubCredentials ? { auth: options.hubCredentials as { [key: string]: unknown } } : {})
                      })
                  ]
                : [])
        ]
    })
    service.useNetwork(network)
    network.exposeClassInstance(service)
    // After ready(): transports are built asynchronously now, so before it there is nothing to
    // listen to. Whoever announced themselves during startup is already in the registry, so the
    // list is seeded from there rather than waiting for them to arrive twice.
    await network.ready()
    for (const peer of network.peers.names()) if (peer !== options.name) online.add(peer)
    for (const transport of network.transports) {
        transport.on(TransportEvent.peerOnline, (peer: string) => {
            if (peer === options.name || online.has(peer)) return
            online.add(peer)
            service.emit('peer', { peer, state: 'online' })
        })
        transport.on(TransportEvent.peerGone, (peer: string) => {
            if (!online.delete(peer)) return
            service.emit('peer', { peer, state: 'offline' })
        })
    }

    await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve))

    return {
        url: `http://${options.host}:${options.port}`,
        service,
        close: async () => {
            await service.releaseAll()
            await network.close()
            await new Promise<void>((resolve) => http.close(() => resolve()))
        }
    }
}
