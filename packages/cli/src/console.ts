import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { MqttTransport, RpcClient, TransportEvent, type ServerDescription } from '@source-repo/msgrpc'
import { page } from './page.js'

/**
 * A browser console for a live msgrpc network: which peers are up, what each one exposes, and a
 * form to call it and watch its events.
 *
 * Peer discovery is nearly free. Every peer publishes retained presence, so subscribing to
 * <prefix>/presence/+ hands over everyone already online immediately - no scanning, no probing.
 *
 * No web framework and no bundler: one HTTP handler, an inlined page, and server-sent events for
 * the live half. A tool for looking at a control network should be something you can read in one
 * sitting.
 */

export interface ConsoleOptions {
    broker: string
    prefix?: string
    port: number
    host: string
    name: string
    callTimeout: number
}

interface Live {
    peers: Set<string>
    /** Open SSE responses, written to whenever something happens. */
    listeners: Set<ServerResponse>
}

const send = (live: Live, event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const listener of live.listeners) listener.write(frame)
}

const readBody = (request: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
        let body = ''
        request.on('data', (chunk) => {
            body += chunk
            // A console has no reason to accept a large request, and this is the one input a
            // browser can drive.
            if (body.length > 1_000_000) reject(new Error('request too large'))
        })
        request.on('end', () => resolve(body))
        request.on('error', reject)
    })

const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
}

export const startConsole = async (options: ConsoleOptions) => {
    const live: Live = { peers: new Set(), listeners: new Set() }

    const transport = new MqttTransport(options.name, options.broker, options.prefix ? { prefix: options.prefix } : {})
    const client = new RpcClient(undefined, { name: options.name, transport, callTimeout: options.callTimeout })

    transport.on(TransportEvent.peerOnline, (peer: string) => {
        if (live.peers.has(peer)) return
        live.peers.add(peer)
        send(live, 'peer', { peer, state: 'online' })
    })
    transport.on(TransportEvent.peerGone, (peer: string) => {
        live.peers.delete(peer)
        send(live, 'peer', { peer, state: 'offline' })
    })
    await client.ready()

    /**
     * Subscriptions this console holds, keyed by peer/namespace/event. The handler is kept because
     * removing a listener needs the same function reference that was registered.
     */
    const watching = new Map<string, (...args: unknown[]) => void>()

    const describe = async (peer: string) => {
        const proxy = await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc', peer)
        return proxy.remote!.describe()
    }

    const call = async (peer: string, namespace: string, method: string, args: unknown[]) => {
        const proxy = await client.proxy<Record<string, (...a: unknown[]) => Promise<unknown>>>(namespace, peer)
        return proxy.remote![method](...args)
    }

    type Subscribable = {
        on: (event: string, handler: (...args: unknown[]) => void) => void
        off: (event: string, handler: (...args: unknown[]) => void) => void
    }

    const watch = async (peer: string, namespace: string, event: string) => {
        const key = `${peer}/${namespace}/${event}`
        if (watching.has(key)) return { watching: true, already: true }
        const handler = (...args: unknown[]) => send(live, 'event', { peer, namespace, event, args, at: Date.now() })
        const proxy = await client.proxy<Subscribable>(namespace, peer)
        await proxy.remote!.on(event, handler)
        watching.set(key, handler)
        return { watching: true, already: false }
    }

    const unwatch = async (peer: string, namespace: string, event: string) => {
        const key = `${peer}/${namespace}/${event}`
        const handler = watching.get(key)
        if (!handler) return { watching: false, already: true }
        const proxy = await client.proxy<Subscribable>(namespace, peer)
        // Removes the local listener and tells the server to drop its side.
        await proxy.remote!.off(event, handler)
        watching.delete(key)
        return { watching: false, already: false }
    }

    const server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? '/', 'http://console')
            try {
                if (url.pathname === '/') {
                    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                    response.end(page)
                    return
                }
                if (url.pathname === '/api/peers') return json(response, 200, { peers: [...live.peers].sort(), watching: [...watching.keys()] })
                if (url.pathname === '/api/describe') return json(response, 200, await describe(url.searchParams.get('peer') ?? ''))
                if (url.pathname === '/api/events') {
                    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
                    response.write(`event: ready\ndata: ${JSON.stringify({ peers: [...live.peers].sort() })}\n\n`)
                    live.listeners.add(response)
                    request.on('close', () => live.listeners.delete(response))
                    return
                }
                if (request.method === 'POST' && url.pathname === '/api/call') {
                    const body = JSON.parse(await readBody(request)) as { peer: string; namespace: string; method: string; args?: unknown[] }
                    const started = Date.now()
                    const result = await call(body.peer, body.namespace, body.method, body.args ?? [])
                    return json(response, 200, { result, ms: Date.now() - started })
                }
                if (request.method === 'POST' && (url.pathname === '/api/watch' || url.pathname === '/api/unwatch')) {
                    const body = JSON.parse(await readBody(request)) as { peer: string; namespace: string; event: string }
                    const act = url.pathname === '/api/watch' ? watch : unwatch
                    return json(response, 200, await act(body.peer, body.namespace, body.event))
                }
                json(response, 404, { error: 'not found' })
            } catch (e) {
                // Reported rather than swallowed: an RpcError's code is the useful part.
                const error = e as { code?: string; message?: string }
                json(response, 200, { error: error.message ?? String(e), code: error.code })
            }
        })()
    })

    await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve))

    return {
        url: `http://${options.host}:${options.port}`,
        close: async () => {
            // Drop the subscriptions rather than leaving them on servers that outlive this process.
            for (const key of [...watching.keys()]) {
                const [peer, namespace, event] = key.split('/')
                await unwatch(peer, namespace, event).catch(() => undefined)
            }
            for (const listener of live.listeners) listener.end()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await client.close()
        }
    }
}
