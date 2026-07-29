import { createServer, type IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createSecureServer, type ServerOptions as TlsServerOptions } from 'node:https'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'events'
import { MqttTransport, RpcServer, TransportEvent, rpc, rpcNamespace, type RelayedFrame, type RpcSchema, type ServerDescription } from '@source-repo/rpc'
import { networkTransports, type NetworkOptions } from './network.js'
import { BusService, DEFAULT_TAP_TTL, type TapFilter, type TappedFrame } from './bus.js'
// The tap's own contract, merged with the console's below: one server, and a schema has to describe
// every namespace it serves or the ones it leaves out are refused their argument types.
import busContract from './bus.types.json' with { type: 'json' }
// Extracted from this file by `npm run contract`, and committed so it is reviewable and so
// `source-rpc check` can catch a change to the service that would refuse a page built against the old
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

/**
 * The network flags every command shares, plus where the console listens.
 *
 * A hub is how a network with no broker - and a server hosted in a browser page, which cannot
 * listen at all - becomes visible: peers there announce themselves on connect. Without `sign` the
 * console cannot talk to a server configured with `verify`; it still discovers peers, because
 * presence is unsigned retained state, and then every call times out with nothing to say why.
 */
export interface ConsoleOptions extends NetworkOptions {
    port: number
    host: string
    /**
     * Certificate and key, which is what makes this console HTTPS - and its socket.io link WSS,
     * since both ride the same listener. Absent means plain HTTP, which is right behind a proxy
     * that has already terminated TLS.
     */
    tls?: TlsServerOptions
    /**
     * The path this console is published under, when a reverse proxy forwards the prefix instead of
     * stripping it. `/tools/console` makes the page, its assets and socket.io all answer there.
     *
     * Not needed for the ordinary `proxy_pass http://console:7844/` rule, whose trailing slash
     * strips the prefix before the console sees it - the page already resolves everything relative
     * to where it was served, so that case needs no configuration at either end. This is for the
     * proxy that passes `/tools/console/socket.io` through unchanged.
     */
    basePath?: string
}

/**
 * A mount point as `/tools/console/`, or `/` for none: one leading slash, one trailing slash.
 *
 * The trailing slash is the load-bearing part. Everything the page asks for is relative to its
 * mount, so the app has to be reached at a path ending in one or its requests resolve a level up.
 */
export const normaliseBasePath = (basePath?: string) => {
    const trimmed = (basePath ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
    return trimmed ? `/${trimmed}/` : '/'
}

type Subscribable = {
    on: (event: string, handler: (...args: unknown[]) => void) => void
    off: (event: string, handler: (...args: unknown[]) => void) => void
}

/** An event the console forwarded from a peer it was asked to watch. */
export interface StreamedEvent {
    peer: string
    namespace: string
    event: string
    args: unknown[]
    at: number
}

/** A peer arriving or leaving, on any of the console's links. */
export interface PeerChange {
    peer: string
    state: string
    at: number
    /** The link it arrived on or left from, when the console knows it. */
    link?: string
}

/**
 * What a peer turned out to be, learned from a description the console had already made.
 *
 * Deliberately not discovered by describing every peer on sight: that is a round trip each on a
 * network where the peer list is the cheap part. The console describes a peer when someone selects
 * it, and when it goes looking for a bus to tap - so the labels fill in as the network is used, and
 * cost nothing that was not already being spent.
 */
export type PeerRole = 'broker' | 'console' | 'page' | 'device' | 'undescribed'

/** A tap the console holds, and where it holds it. */
export interface ConsoleTap {
    token: string
    /** The peers doing the watching: a broker's `bus`, this console's own MQTT tap, or both. */
    sources: string[]
}

/**
 * A frame a transport refused or could not deliver, a name two peers claimed, or a link that
 * failed - the four things that otherwise reach a caller only as an unexplained timeout.
 *
 * The transports have always emitted these. Nothing listened, so the console showed a call that
 * never came back and no reason anywhere, which is the hardest kind of problem to diagnose and the
 * one this tooling exists to make visible.
 */
export interface NetworkProblem {
    at: number
    /** `rejected`, `unroutable`, `peerDisplaced` or `transportError`. */
    kind: string
    /** The link it happened on: the page's own, the broker, or the hub. */
    link: string
    /** Who the frame claimed to come from, or the name that was taken over. */
    peer?: string
    /** Who an undeliverable frame was addressed to. */
    target?: string
    reason?: string
}

/** How much history the console keeps. These arrive unasked, so the buffers are bounded. */
const PROBLEM_HISTORY = 200

/**
 * What a description says the peer is. A broker exposes the tap and nothing else; a console has its
 * own namespace; a page hosts the chat service the console app ships. Anything else answering for
 * itself is a device, and one that cannot be described is worth distinguishing from one that has
 * not been described yet.
 */
const roleFrom = (description: ServerDescription): PeerRole => {
    const namespaces = description.namespaces.map((namespace) => namespace.name)
    if (namespaces.includes('bus') && !namespaces.includes('console')) return 'broker'
    if (namespaces.includes('console')) return 'console'
    if (namespaces.includes('chat')) return 'page'
    return 'device'
}

/** What a browser may ask this console to do. Everything else on the class stays local. */
@rpcNamespace('console')
export class ConsoleService extends EventEmitter {
    /**
     * Declared rather than inferred from emit() calls, which cannot be read statically. Without
     * this the console's own contract described its methods and none of its events, so a console
     * pointed at another one saw an empty events list on a service that has three.
     */
    declare rpcEvents: {
        event: [event: StreamedEvent]
        peer: [change: PeerChange]
        frame: [frame: TappedFrame]
        problem: [problem: NetworkProblem]
    }

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

    /**
     * This console's own tap, when it has an MQTT link. There is no broker of ours on an MQTT
     * network to ask, so the console does the watching itself - see `startConsole`.
     */
    private localBus?: BusService

    useLocalTap(bus: BusService) {
        this.localBus = bus
        bus.on('frame', (frame: TappedFrame) => this.emit('frame', frame))
    }

    /** Which link each peer was last seen on, written by startConsole as they arrive. */
    readonly links = new Map<string, string>()

    /**
     * The flags this console was started with, so the page can render a command line that actually
     * runs. A call worth making in the browser is usually one worth putting in a script, and
     * retyping `--hub http://…` from memory is where that stops happening.
     */
    startedWith: { broker?: string; hub?: string; prefix?: string } = {}

    /** What has gone wrong on the links, newest first and bounded. */
    private readonly seen: NetworkProblem[] = []

    /**
     * Peers arriving and leaving, newest first and bounded.
     *
     * Kept because a peer that comes and goes is one of the commonest faults on a plant and the
     * hardest to catch in the act: the console showed it as a dot that changed colour and forgot,
     * so a device flapping every thirty seconds looked exactly like one that was simply up.
     */
    private readonly comings: PeerChange[] = []

    /** What each peer turned out to be, from descriptions already made. */
    private readonly roles = new Map<string, PeerRole>()

    notePresence(change: PeerChange) {
        this.comings.unshift(change)
        if (this.comings.length > PROBLEM_HISTORY) this.comings.length = PROBLEM_HISTORY
        this.emit('peer', change)
    }

    /** Records a problem and passes it on, so a page open now sees it and one opened later still can. */
    noteProblem(problem: NetworkProblem) {
        this.seen.unshift(problem)
        if (this.seen.length > PROBLEM_HISTORY) this.seen.length = PROBLEM_HISTORY
        this.emit('problem', problem)
    }

    /** Console-side token -> the taps it opened, here and on other peers, and when they lapse. */
    private readonly held = new Map<string, { expires: number; opened: { peer: string; token: string }[] }>()
    /** Peers whose `frame` event this console has already subscribed to, so it subscribes once. */
    private readonly forwarding = new Map<string, (...args: unknown[]) => void>()
    private tapCounter = 0

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
        return {
            peers: [...this.online].sort(),
            watching: [...this.watching.keys()],
            callTimeout: this.callTimeout,
            network: this.startedWith,
            // Filled in as peers are described for other reasons, so this costs no extra traffic.
            roles: Object.fromEntries(this.roles),
            // Which link each peer was found on. The console holds the browser's, the broker's and
            // the hub's at once, and on a plant where the devices are on one and the HMIs on
            // another that is the first thing worth knowing about a peer.
            links: Object.fromEntries(this.links)
        }
    }

    /**
     * What has gone wrong on the links, newest first.
     *
     * Fetched as well as streamed, because these arrive whether or not anyone is watching and the
     * interesting ones are usually the ones from before you went looking.
     */
    @rpc
    async problems(): Promise<{ problems: NetworkProblem[] }> {
        return { problems: [...this.seen] }
    }

    /**
     * Peers arriving and leaving, newest first - including before this page was opened, which is
     * the half that matters when the question is whether something has been flapping.
     */
    @rpc
    async presence(): Promise<{ changes: PeerChange[] }> {
        return { changes: [...this.comings] }
    }

    @rpc
    async describe(peer: string): Promise<ServerDescription | { error: string; code?: string }> {
        try {
            const proxy = await this.reach(peer).proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc', peer)
            const description = await proxy.remote!.describe()
            // Every description teaches what the peer is, whoever asked for it and why.
            this.roles.set(peer, roleFrom(description))
            return description
        } catch (e) {
            const failure = asFailure(e)
            if (failure.code === 'ClassNotFound') this.roles.set(peer, 'undescribed')
            return failure
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

    /**
     * Peers that can watch traffic: any exposing a `bus`, which in practice is the broker.
     *
     * Found by describing rather than configured, because the broker is a peer like any other and
     * the console has no idea which of them it is. Cached: the answer changes only when a broker
     * joins or leaves, and describing every peer on each tap would be a round trip per peer.
     */
    private async busPeers() {
        const asking = [...this.online].filter((peer) => !this.knownBuses.has(peer))
        // Asked all at once, not one after another. A peer that is registered but no longer
        // answering - a page whose tab was closed, most often - takes the whole call timeout to
        // fail, and in sequence that is one timeout per stale peer before the tap starts at all.
        await Promise.all(
            asking.map(async (peer) => {
                const described = await this.describe(peer)
                this.knownBuses.set(peer, !('error' in described) && described.namespaces.some((namespace) => namespace.name === 'bus'))
            })
        )
        return [...this.online].filter((peer) => this.knownBuses.get(peer))
    }
    private readonly knownBuses = new Map<string, boolean>()

    /** A peer that has gone is worth asking about again if it comes back under new software. */
    forgetBus(peer: string) {
        this.knownBuses.delete(peer)
        this.roles.delete(peer)
    }

    /**
     * Start watching traffic, wherever this console can watch it.
     *
     * A socket.io network is watched at the broker, which is the only thing that sees frames it is
     * not party to; an MQTT network is watched by this console's own subscription, since there is
     * no broker of ours there to ask. A console holding both links turns on both, and the frames
     * arrive on one event either way - which is what keeps the page from having to know any of this.
     */
    @rpc
    async tap(filter?: TapFilter): Promise<ConsoleTap> {
        const token = `console-tap-${++this.tapCounter}`
        const opened: { peer: string; token: string }[] = []
        // Asked before anything starts watching, since describing every peer is itself traffic and
        // a tap that opened first would report the console looking for it as the first thing it saw.
        const buses = await this.busPeers()

        if (this.localBus) opened.push({ peer: 'this console', token: (await this.localBus.tap(filter)).token })

        for (const peer of buses) {
            try {
                const proxy = await this.reach(peer).proxy<BusPeer>('bus', peer)
                const answer = await proxy.remote!.tap(filter)
                opened.push({ peer, token: answer.token })
                if (!this.forwarding.has(peer)) {
                    // Subscribed once per peer however many taps are open: the frames already say
                    // which taps they matched, and a second subscription would duplicate them all.
                    const handler = (frame: unknown) => this.emit('frame', frame as TappedFrame)
                    await proxy.remote!.on('frame', handler)
                    this.forwarding.set(peer, handler)
                }
            } catch {
                // A peer that has gone, or one whose bus refused. The others still work, and a tap
                // that turned nothing on is reported by its empty source list rather than by
                // failing - which would lose the sources that did start.
                this.knownBuses.delete(peer)
            }
        }

        // Given the same life as the taps it stands for, so a page that closed without untapping -
        // a reload is enough - takes its entry with it rather than leaving one here for the life of
        // the console. The taps themselves expire on their own; this is the console's side of that.
        this.held.set(token, { expires: Date.now() + (filter?.ttl ?? DEFAULT_TAP_TTL) * 1000, opened })
        return { token, sources: opened.map((entry) => entry.peer) }
    }

    @rpc
    async untap(token: string): Promise<{ tapping: boolean; already: boolean }> {
        const entry_ = this.held.get(token)
        if (!entry_) return { tapping: false, already: true }
        this.held.delete(token)
        for (const entry of entry_.opened) {
            if (entry.peer === 'this console') {
                await this.localBus?.untap(entry.token)
                continue
            }
            try {
                const proxy = await this.reach(entry.peer).proxy<BusPeer>('bus', entry.peer)
                await proxy.remote!.untap(entry.token)
            } catch {
                // The tap expires on its own if the peer is unreachable, so there is nothing left
                // to do about it here and nothing worth failing the call over.
            }
        }
        await this.stopForwardingIfIdle()
        return { tapping: false, already: false }
    }

    /** Everything this console is watching, and where. */
    @rpc
    async taps(): Promise<{ taps: ConsoleTap[]; sources: string[] }> {
        await this.expireTaps()
        return {
            taps: [...this.held.entries()].map(([token, entry]) => ({ token, sources: entry.opened.map((source) => source.peer) })),
            sources: [...(this.localBus ? ['this console'] : []), ...(await this.busPeers())]
        }
    }

    /**
     * Drops taps whose life has run out, and the subscriptions they were holding.
     *
     * The taps themselves have already lapsed at the far end by now; this is what stops the console
     * forwarding frames for them, and what keeps `held` from growing by one on every page reload.
     */
    private async expireTaps() {
        const now = Date.now()
        for (const [token, entry] of this.held) if (entry.expires <= now) this.held.delete(token)
        await this.stopForwardingIfIdle()
    }

    /**
     * Drops the subscriptions on the peers doing the watching once nothing here wants them.
     *
     * Kept until then rather than per tap, since several taps share one subscription - and dropped
     * when the last goes, so a broker is not left emitting frames into a console that stopped
     * reading them.
     */
    private async stopForwardingIfIdle() {
        if (this.held.size) return
        for (const [peer, handler] of this.forwarding) {
            try {
                const proxy = await this.reach(peer).proxy<BusPeer>('bus', peer)
                await proxy.remote!.off('frame', handler)
            } catch {
                // Gone, which drops its side anyway.
            }
        }
        this.forwarding.clear()
    }

    /** Drops every subscription this console holds, so servers that outlive it keep no listeners. */
    async releaseAll() {
        for (const token of [...this.held.keys()]) await this.untap(token).catch(() => undefined)
        for (const key of [...this.watching.keys()]) {
            const [peer, namespace, event] = key.split('/')
            await this.unwatch(peer, namespace, event).catch(() => undefined)
        }
    }
}

/** The part of a broker's `bus` this console calls. */
type BusPeer = {
    tap: (filter?: TapFilter) => Promise<{ token: string }>
    untap: (token: string) => Promise<unknown>
    on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
    off: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
}

const asFailure = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    return { error: error.message ?? String(e), code: error.code }
}

/**
 * One schema for the two namespaces this server exposes.
 *
 * They are extracted separately because each is a contract in its own right - the broker serves
 * `bus` without `console` - and merged here because a schema describes a server rather than a
 * class. Named types are merged too: the two files share none, and a collision would be a bug in
 * whichever one added the duplicate rather than something to resolve at runtime.
 */
const consoleAndBus: RpcSchema = {
    schema: 1,
    namespaces: { ...(contract as RpcSchema).namespaces, ...(busContract as RpcSchema).namespaces },
    types: { ...(contract as RpcSchema).types, ...(busContract as RpcSchema).types }
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
            response.end('The console app is not built. Run `npm run build` in @source-repo/rpc-cli.\n')
        }
    }
}

export const startConsole = async (options: ConsoleOptions) => {
    if (!options.broker && !options.hub) throw new Error('startConsole: give it a broker, a hub, or both')

    /** Every peer the console can see, on any of its links. */
    const online = new Set<string>()
    const service = new ConsoleService(online, options.callTimeout)

    /**
     * The console's own tap on an MQTT network, opened when someone asks and closed when the last
     * of them stops.
     *
     * A second connection rather than a wildcard added to the console's own: a client subscribed to
     * both its own topic and the wildcard covering it has overlapping subscriptions, and a broker
     * may deliver a matching message once per subscription - which for a request means the method
     * runs twice. It also means nothing is subscribed until it is wanted, so an idle console costs
     * a plant broker nothing.
     */
    let tapLink: MqttTransport | undefined
    const localBus = options.broker ? new BusService(options.name) : undefined
    if (localBus) {
        localBus.onDemand = {
            start: async () => {
                if (tapLink) return
                tapLink = new MqttTransport(`${options.name}-tap`, options.broker!, {
                    ...(options.prefix ? { prefix: options.prefix } : {}),
                    tap: true,
                    // It watches; it is not a peer anyone should call or wait for.
                    presence: false
                })
                tapLink.on(TransportEvent.relayed, (relayed: RelayedFrame) => localBus.observe(relayed))
                await tapLink.open()
                await tapLink.ready()
            },
            stop: async () => {
                const closing = tapLink
                tapLink = undefined
                await closing?.close()
            }
        }
        service.useLocalTap(localBus)
    }

    const base = normaliseBasePath(options.basePath)
    // One handler either way: an https.Server is an http.Server with a certificate in front, and
    // socket.io attaches to it identically.
    const serve = (request: IncomingMessage, response: ServerResponse) => {
        const pathname = new URL(request.url ?? '/', 'http://console').pathname
        if (base !== '/') {
            // The mount point without its trailing slash. Redirected rather than served, because
            // the page that would come back resolves its assets, console.json and socket.io path
            // relative to where it was served - and from `/tools/console` that is `/tools/`, so
            // every one of them would miss. This is the only place that can be put right.
            if (pathname === base.slice(0, -1)) {
                response.writeHead(301, { location: base })
                response.end()
                return
            }
            if (!pathname.startsWith(base)) {
                // Not a route of this app. Answered plainly rather than with the index, which would
                // claim the whole origin from whatever else the proxy publishes beside it.
                response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
                response.end(`The console is published under ${base}\n`)
                return
            }
        }
        // serveAsset handles its own failures, so reaching this catch means the response itself
        // could not be written. Answering is still better than rejecting into nowhere.
        void serveAsset(base === '/' ? pathname : `/${pathname.slice(base.length)}`, response, { name: options.name }).catch(() => {
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('The console could not serve this request.\n')
        })
    }
    const http = options.tls ? createSecureServer(options.tls, serve) : createServer(serve)
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
        // Both namespaces, since one server serves both and a schema that named only `console`
        // would leave `bus` to be described as `tap(…)` with no argument types at all.
        schema: consoleAndBus,
        exposeIntrospection: true,
        transports: [
            // socket.io attaches to the same http server and answers /socket.io before the static
            // handler sees it, so the console is one port: page and RPC over the same origin. Under
            // a base path it moves with the rest of the app, which is what the page will ask for -
            // it derives the same path from where the document was served.
            { server: http, ...(base === '/' ? {} : { path: `${base}socket.io` }) },
            ...networkTransports(options)
        ]
    })
    service.useNetwork(network)
    service.startedWith = {
        ...(options.broker ? { broker: options.broker } : {}),
        ...(options.hub ? { hub: options.hub } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {})
    }
    network.exposeClassInstance(service)
    // The console's own tap, exposed like any other so `source-rpc call <console> bus.tap` works and
    // another console can watch this one's MQTT link.
    if (localBus) network.exposeClassInstance(localBus)
    // After ready(): transports are built asynchronously now, so before it there is nothing to
    // listen to. Whoever announced themselves during startup is already in the registry, so the
    // list is seeded from there rather than waiting for them to arrive twice.
    await network.ready()
    // In the order the transports were built above, so index 0 is the link the browser arrives on.
    // A peer's link is worth naming by where it is rather than what the transport calls itself,
    // which for the MQTT one is this console's own name.
    const linkNames = ['this console', ...(options.broker ? [options.broker] : []), ...(options.hub ? [options.hub] : [])]
    const linkOf = (peer: string) => {
        // The registry knows which module carries a peer, which is how a peer already present at
        // startup gets a link at all: it announced itself before there was a listener to hear it.
        const carrier = network.peers.get(peer)
        const index = network.transports.findIndex((transport) => transport === carrier)
        return index === -1 ? undefined : linkNames[index]
    }
    for (const peer of network.peers.names()) {
        if (peer === options.name) continue
        online.add(peer)
        const link = linkOf(peer)
        if (link) service.links.set(peer, link)
    }
    network.transports.forEach((transport, index) => {
        const link = linkNames[index] ?? transport.getName()
        transport.on(TransportEvent.peerOnline, (peer: string) => {
            if (peer === options.name) return
            service.links.set(peer, link)
            if (online.has(peer)) return
            online.add(peer)
            service.notePresence({ peer, state: 'online', at: Date.now(), link })
        })
        transport.on(TransportEvent.peerGone, (peer: string) => {
            // Asked again if it returns: a broker restarted with a tap is a different answer.
            service.forgetBus(peer)
            service.links.delete(peer)
            if (!online.delete(peer)) return
            service.notePresence({ peer, state: 'offline', at: Date.now(), link })
        })
        // The four the transports have always emitted and nothing ever listened to. Between them
        // they cover every way a call disappears without an answer: refused before the RPC layer,
        // undeliverable, answered to whichever connection claimed the name last, or a link that
        // failed underneath.
        transport.on(TransportEvent.rejected, (report: { source?: string; reason?: string }) =>
            service.noteProblem({ at: Date.now(), kind: 'rejected', link, ...(report?.source ? { peer: report.source } : {}), ...(report?.reason ? { reason: report.reason } : {}) })
        )
        transport.on(TransportEvent.unroutable, (report: { source?: string; target?: string; reason?: string }) =>
            service.noteProblem({
                at: Date.now(),
                kind: 'unroutable',
                link,
                ...(report?.source ? { peer: report.source } : {}),
                ...(report?.target ? { target: report.target } : {}),
                reason: report?.reason ?? 'no route to the target'
            })
        )
        // A bare name rather than a report: two peers are answering to it, and calls to either
        // reach whichever connection arrived last.
        transport.on(TransportEvent.peerDisplaced, (peer: unknown) =>
            service.noteProblem({ at: Date.now(), kind: 'peerDisplaced', link, peer: String(peer), reason: 'another connection claimed this name' })
        )
        transport.on(TransportEvent.transportError, (e: unknown) =>
            service.noteProblem({ at: Date.now(), kind: 'transportError', link, reason: e instanceof Error ? e.message : String(e) })
        )
    })

    await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve))

    return {
        url: `${options.tls ? 'https' : 'http'}://${options.host}:${options.port}${base === '/' ? '' : base}`,
        service,
        close: async () => {
            await service.releaseAll()
            // After releaseAll, which is what drops the last tap and closes this with it. Closed
            // again here in case a tap expired mid-flight and left the link behind.
            await localBus?.releaseAll()
            await tapLink?.close().catch(() => undefined)
            await network.close()
            await new Promise<void>((resolve) => http.close(() => resolve()))
        }
    }
}
