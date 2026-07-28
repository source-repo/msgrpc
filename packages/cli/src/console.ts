import { createServer, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'events'
import {
    MqttTransport,
    RpcClient,
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
    broker: string
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
        private readonly client: RpcClient,
        /** Peers seen online, maintained by the MQTT transport's presence events. */
        private readonly online: Set<string>,
        /** How long this console waits on the network, reported so the browser can wait longer. */
        private readonly callTimeout: number
    ) {
        super()
    }

    @rpc
    async peers() {
        return { peers: [...this.online].sort(), watching: [...this.watching.keys()], callTimeout: this.callTimeout }
    }

    @rpc
    async describe(peer: string): Promise<ServerDescription | { error: string; code?: string }> {
        try {
            const proxy = await this.client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc', peer)
            return await proxy.remote!.describe()
        } catch (e) {
            return asFailure(e)
        }
    }

    @rpc
    async call(peer: string, namespace: string, method: string, args: unknown[] = []): Promise<{ result?: unknown; error?: string; code?: string; ms: number }> {
        const started = Date.now()
        try {
            const proxy = await this.client.proxy<Record<string, (...a: unknown[]) => Promise<unknown>>>(namespace, peer)
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
        const proxy = await this.client.proxy<Subscribable>(namespace, peer)
        await proxy.remote!.on(event, handler)
        this.watching.set(key, handler)
        return { watching: true, already: false }
    }

    @rpc
    async unwatch(peer: string, namespace: string, event: string) {
        const key = `${peer}/${namespace}/${event}`
        const handler = this.watching.get(key)
        if (!handler) return { watching: false, already: true }
        const proxy = await this.client.proxy<Subscribable>(namespace, peer)
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
    const online = new Set<string>()

    const transport = new MqttTransport(options.name, options.broker, {
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(options.sign ? { sign: options.sign } : {}),
        ...(options.verify ? { verify: options.verify } : {})
    })
    const client = new RpcClient(undefined, { name: options.name, transport, callTimeout: options.callTimeout })
    const service = new ConsoleService(client, online, options.callTimeout)

    transport.on(TransportEvent.peerOnline, (peer: string) => {
        if (online.has(peer)) return
        online.add(peer)
        service.emit('peer', { peer, state: 'online' })
    })
    transport.on(TransportEvent.peerGone, (peer: string) => {
        online.delete(peer)
        service.emit('peer', { peer, state: 'offline' })
    })
    await client.ready()

    const http = createServer((request, response) => {
        void serveAsset(new URL(request.url ?? '/', 'http://console').pathname, response)
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
            await client.close()
        }
    }
}
