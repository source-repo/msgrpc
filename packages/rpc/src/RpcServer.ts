import { EventEmitter } from 'events'
import { GenericModule, PeerRegistry, Transport, TransportEvent } from './RPC/Core.js'
import { ComponentChannels, componentFacade, type RpcComponentLike, type RpcComponentProxy } from './RPC/ComponentClient.js'
import { HostTopology, type HostTopologyOptions, type RpcRef } from './RPC/Topology.js'
import { contextEvent, contextNamespace, HostContext, type RpcCapturedContext, type RpcContextProviderHandle, type RpcContextToken } from './RPC/Context.js'
import { ContextResolver, type RpcContextStore } from './RPC/ContextResolver.js'
import { RpcAuthenticator, RpcAuthorizer, type TrustedCertificateAuthority } from './RPC/Auth.js'
import { validateAiGrants, type RpcAiGrants } from './RPC/Grants.js'
import { RpcSchema } from './RPC/Schema.js'
import { Introspection, surfaceShape, withIntrospection } from './RPC/Introspection.js'
import { ExposeOptions, RpcServerHandler } from './RPC/RpcServerHandler.js'
import type { RpcIdempotencyStore } from './RPC/Idempotency.js'
import { defaultCallTimeout, RpcClientHandler } from './RPC/RpcClientHandler.js'
import { RpcProxy } from './RpcClient.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { RelayRule, settledAfterSweeps } from './Transports/Presence.js'
import { codecFor } from './RPC/Codec.js'
import { Switch } from './Utilities/Switch.js'
import { IManageRpc } from './RPC/Rpc.js'

export interface ServerOptions {
    description?: string
}

/**
 * Serve over a connection this server opens, rather than one it accepts. A browser page cannot
 * listen, so this is the only way it can host an RpcServer: it dials a hub, announces its name, and
 * the hub relays calls to it.
 */
export interface ConnectServerOptions extends ServerOptions {
    connect: string
    path?: string
    /** Presented to a hub that authenticates. */
    credentials?: unknown
    /**
     * Dial an `https://` or `wss://` hub without checking its certificate. Deliberately unsafe:
     * anything able to answer on that address can then read and rewrite this link. For a
     * development hub with a self-signed certificate.
     */
    allowInsecureTls?: boolean
    /**
     * A certificate authority to trust when dialling the hub, on top of the system ones. What a
     * plant issuing its own certificates wants, and what to reach for before `allowInsecureTls`:
     * verification stays on, so anything this does not vouch for is still refused.
     */
    ca?: TrustedCertificateAuthority
}

export interface RpcServerOptions {
    name: string
    /**
     * What this server serves over. Only the two a browser can use are here; NodeRpcServer widens
     * it with a socket.io listener, an existing http.Server and a broker connection, which is what
     * makes `{ port: 8080 }` in browser code a compile error rather than a surprise at runtime.
     */
    transports: (ConnectServerOptions | Transport)[]
    useMsgPack: boolean
    /**
     * Verify credentials when a peer connects. Applied to socket.io transports this server builds.
     * MQTT has no server-side handshake, so MQTT peers are authenticated by the broker instead.
     */
    authenticate?: RpcAuthenticator
    /** Called for every call and every event subscription. Return false to reject it. */
    authorize?: RpcAuthorizer
    /**
     * What AI principals may do on this server. Absent - the default everywhere - means the four
     * capability grants are closed: a credentialed AI principal may observe wherever ordinary
     * authorization allows, and every write or programming call is refused until a rung is opened
     * by name. Enforced before `authorize` runs, so a server with no authorizer at all still
     * refuses. A malformed document refuses the server rather than being quietly ignored.
     */
    aiGrants?: RpcAiGrants
    /** Called for every AI-gated decision, allowed or refused. The open half of the audit story. */
    onAiDecision?: (record: { source: string; path: string; method: string; effect: string; allowed: boolean; grant?: string; reason: string }) => void
    /**
     * Reject calls from peers no transport can vouch for. Defaults to true when `authenticate` is
     * set. Note that MQTT peers can never be vouched for at this layer, so a server that mixes an
     * authenticating socket.io transport with MQTT will reject its MQTT peers unless this is
     * explicitly false.
     */
    requireAuthenticatedPeers?: boolean
    /**
     * Forward frames addressed to another peer connected to this server's socket.io transports,
     * instead of running them here. On by default, because a peer that can only dial out has no
     * other way to be reached. A predicate decides per connection; `false` forwards nothing.
     */
    relay?: RelayRule
    /**
     * Publish manageRpc.createRpcInstance so peers can instantiate exposed classes remotely.
     * Off by default: it is remote object construction, and it is rarely needed.
     */
    exposeManagement?: boolean
    /** How long ready() waits for every transport to connect before throwing. 0 waits forever. */
    readyTimeout: number
    /** How long this server's own outgoing calls wait. See proxy(). */
    callTimeout?: number
    /** Describes what exposed methods accept, so arguments off the wire can be checked. */
    schema?: RpcSchema
    /**
     * 'described' (the default when a schema is given) checks the namespaces the schema covers.
     * 'required' refuses anything undescribed. 'off' disables checking without removing the schema.
     */
    validation?: 'off' | 'described' | 'required'
    /** Check what handlers return against the schema too. Off by default: it is a self-check. */
    validateResults?: boolean
    /**
     * Check component props/state commits against the schema's component contract. Off by default
     * for the same reason validateResults is: it is a self-check on this server's own code, not
     * protection from callers. An invalid commit throws at the setState call site and the previous
     * snapshot stays current.
     */
    validateComponentSnapshots?: boolean
    /**
     * Honour methods that declare `sets: '*'` - the generic setters, which take a path and a value
     * and write wherever the caller names.
     *
     * Off by default, and the state-write sibling of `topology.allowRemoteMutation`: a deployment
     * that never enables it has no such surface at all, however its classes are written. A generic
     * setter is a development affordance - it is what makes a console usable against a component
     * carrying three hundred tags, where declaring a marker per field would be absurd - and on a
     * plant the answer is the per-field `sets` declarations, whose methods carry the interlocks.
     *
     * Enabling it is not the same as opening the state. Every call still passes authorize() with
     * the path in params and the caller resolved, so a policy can rule on *which* path rather than
     * only on the method, and the method's own body still decides what it will accept.
     */
    allowStatePathWrites?: boolean
    /** Refuse to expose a class that marks no @rpc methods, rather than publishing all of them. */
    requireExplicitExposure?: boolean
    /** Refuse a caller declaring a contract version the schema has no history for. Default 'allow'. */
    unknownVersion?: 'allow' | 'reject'
    /**
     * Where this host physically is and how it displays: `place` is a sequence of ids declared at
     * deployment - never in a class contract, since the same class is bolted into every building -
     * `label` is free text from the project's own drawings, and `store` decides whether topology
     * epochs survive a restart. All optional: a host that declares nothing gets a synthetic
     * `$host` root and is done.
     */
    topology?: HostTopologyOptions & {
        /**
         * Accept msgrpc.updateTopology from remote callers. Off by default: restructuring the
         * plant from anywhere on the network is a decision, and enabling it without an authorize()
         * that names who may is a decision made badly.
         */
        allowRemoteMutation?: boolean
    }
    /**
     * Where to record what a non-repeatable command did, so a request redelivered after this
     * process died is answered from the record instead of run a second time.
     *
     * Without one, delivery and execution are at least once - which is the honest description of
     * every RPC system that has no such store. See RPC/Idempotency.ts for what exactly it closes.
     */
    idempotency?: RpcIdempotencyStore
    /**
     * Publish msgrpc.describe(), which reports the exposed namespaces, their methods and events,
     * and which instances are live. Off by default: listing all of that is reconnaissance, and it
     * is subject to authorize() like any other call.
     */
    exposeIntrospection?: boolean
}

/**
 * Everything that works anywhere: a peer serves over connections it opens, or over transports it
 * was handed. Listening for connections and speaking MQTT need Node, and live in NodeRpcServer,
 * which is what `RpcServer` means when imported outside a browser.
 */
export class RpcServerBase implements IManageRpc {
    public rpc: RpcServerHandler
    /**
     * This server as a caller. A server on a bus is rarely only a server: it answers its peers and
     * calls them back. Sharing the transports means it does so under its own name, over the
     * connection it already has, rather than needing a second RpcClient with a second name - which
     * over MQTT means a second broker session, and over socket.io a second announced peer.
     */
    public caller: RpcClientHandler
    readyFlag = false
    switch?: Switch
    transports: Transport[] = []
    /** Peer name -> transport, shared by this server's modules and nothing outside them. */
    readonly peers = new PeerRegistry()
    /** This host's parent/owner records: the federated topology core, host-authoritative. */
    readonly topology: HostTopology
    /** This host's context providers, served under $context and resolved over the chains. */
    readonly context: HostContext
    private readonly contextResolver: ContextResolver
    /** Created on the first component() call; every channel this server observes lives in it. */
    private componentChannels?: ComponentChannels
    /**
     * The lifecycle feed component channels stale from. RpcClient re-emits transport events on
     * itself and hands the channels `this`; this class deliberately does not re-emit - transports
     * are its public surface - so the channels get their own emitter, fed from attach().
     */
    private readonly componentLifecycle = new EventEmitter()
    options: RpcServerOptions = { name: '*', transports: [], useMsgPack: true, readyTimeout: 30000 }
    constructor(options: Partial<RpcServerOptions> = {}) {
        this.options = { ...this.options, ...options }
        // Handlers first, with no sources. Transports attach to them as they are built, which is
        // what lets exposeClassInstance() run before any link exists - and lets the two node-only
        // transports be imported on demand, so a browser bundle carrying RpcServer does not carry
        // socket.io's server and the MQTT client to reach a hub it dials.
        this.rpc = new RpcServerHandler(this.options.name)
        this.caller = new RpcClientHandler(this.options.name, [], this.options.callTimeout ?? defaultCallTimeout)
        this.switch = new Switch([this.rpc, this.caller])
        // One registry for this server's modules only. The transports record which peer they saw a
        // message from; the switch reads it back to route the reply out of the same transport.
        for (const module of [this.rpc, this.caller, this.switch]) module.usePeerRegistry(this.peers)

        this.rpc.authorize = this.options.authorize
        // Validated here rather than consulted hopefully later: a node that starts holding an
        // unreadable security policy is the failure this exists to prevent, so a malformed
        // document refuses the server rather than quietly granting nothing.
        if (this.options.aiGrants) this.rpc.aiGrants = validateAiGrants(this.options.aiGrants)
        this.rpc.onAiDecision = this.options.onAiDecision
        this.rpc.requireIdentity = this.options.requireAuthenticatedPeers ?? !!this.options.authenticate
        // Identity comes from whichever transport the peer is connected to, never from the message
        // itself. Authenticating transports pin a peer name to one connection, so this lookup
        // cannot be spoofed by claiming someone else's source.
        this.rpc.resolveIdentity = (source) => {
            for (const transport of this.transports) {
                const identity = transport.getIdentity(source)
                if (identity) return identity
            }
            return undefined
        }
        this.rpc.schema = this.options.schema
        this.rpc.validation = this.options.validation ?? (this.options.schema ? 'described' : 'off')
        this.rpc.validateResults = this.options.validateResults ?? false
        if (this.options.validateComponentSnapshots)
            this.rpc.manageRpc.componentContractFor = (namespace) => {
                const component = this.rpc.schema?.namespaces[namespace]?.component
                return component ? { component, types: this.rpc.schema?.types } : undefined
            }
        this.rpc.unknownVersion = this.options.unknownVersion ?? 'allow'
        this.rpc.idempotency = this.options.idempotency
        this.rpc.manageRpc.requireExplicitExposure = this.options.requireExplicitExposure ?? false
        if (this.options.exposeManagement) this.rpc.manageRpc.exposeManagement()
        if (this.options.exposeIntrospection) {
            this.rpc.manageRpc.exposeClassInstance(new Introspection(this.rpc))
            // Describing the describer. Without this the one call a peer makes to find out what is
            // here is the only undescribed thing on the server, and 'required' refuses it outright.
            this.rpc.schema = withIntrospection(this.rpc.schema)
        }

        this.topology = new HostTopology(this.options.name, this.options.topology)
        this.rpc.hostTopology = this.topology
        this.rpc.allowTopologyMutation = this.options.topology?.allowRemoteMutation ?? false
        this.rpc.allowStatePathWrites = this.options.allowStatePathWrites ?? false
        this.context = new HostContext(this.topology)
        this.topology.onCommitted = () => this.context.changed()
        this.rpc.hostContext = this.context
        this.context.push = (source, frame) => void this.rpc.sendEvent(source, contextEvent, [frame], contextNamespace).catch(() => undefined)
        this.contextResolver = new ContextResolver(this.context, this.options.name, this.caller, this.componentLifecycle)

        // Building a listener or a broker connection means loading a module, so this is where the
        // constructor stops being synchronous. ready() awaits it and reports what went wrong.
        // Topology loads first: a durable store's epochs must be in memory before anything can be
        // asked about them, and ready() is the promise that they are.
        this.starting = this.topology
            .init()
            .then(() => this.buildTransports())
            .then(
            () => {
                this.readyFlag = true
            },
            (e: unknown) => {
                this.initError = e
            }
        )
        // init() is a no-op here but is meant to be overridden, and the constructor cannot await
        // it. Left unguarded, a subclass whose init() rejected took the process down from a
        // constructor; kept instead, so ready() can name the cause.
        void this.init().catch((e) => {
            this.initError = e
            this.emitSafely('initError', e)
        })
    }
    /** Why init() failed, rethrown by ready() so the caller sees the cause and not a timeout. */
    private initError?: unknown
    /** Resolves when every transport has been built and wired. ready() waits on it. */
    private starting: Promise<void> = Promise.resolve()

    /**
     * Build each configured transport and wire it in. The socket.io listener and the MQTT client
     * are imported here rather than at the top of the file: a page hosting an RpcServer over a
     * connection it dials has no use for either, and a static import would put both in its bundle.
     */
    /** What to build when nothing was configured. A peer that cannot listen has no useful default. */
    protected configuredTransports(): unknown[] {
        return this.options.transports
    }

    /**
     * Turn one configuration entry into a transport, or undefined if this class does not know that
     * shape. NodeRpcServer overrides it for the shapes that need Node and defers here for the rest.
     */
    protected async buildTransport(serveroption: unknown): Promise<Transport | undefined> {
        if (serveroption instanceof GenericModule) return serveroption as Transport
        if ((serveroption as ConnectServerOptions).connect) {
            const connectOptions = serveroption as ConnectServerOptions
            return new SocketIoClientTransport(
                this.options.name,
                connectOptions.connect,
                [],
                {
                    ...(connectOptions.path ? { path: connectOptions.path } : {}),
                    ...(connectOptions.credentials ? { auth: connectOptions.credentials as { [key: string]: unknown } } : {}),
                    // The typings narrow `ca` to a string; the runtime takes what Node's tls does.
                    ...(connectOptions.ca ? { ca: connectOptions.ca as unknown as string } : {})
                },
                true,
                connectOptions.allowInsecureTls
            )
        }
        return undefined
    }

    private async buildTransports() {
        const codec = codecFor(this.options.useMsgPack)
        for (const serveroption of this.configuredTransports()) {
            const transport = await this.buildTransport(serveroption)
            if (!transport) throw new Error(`RpcServer '${this.options.name}': no transport can be built from ${JSON.stringify(serveroption)}`)
            // The transports encode, so there is no converter between them and the handler. A
            // structured wire format such as MQTT 5 needs to see the message rather than bytes a
            // converter already flattened.
            transport.codec = codec
            if (this.options.relay !== undefined && 'relay' in transport) (transport as { relay: RelayRule }).relay = this.options.relay
            this.attach(transport)
        }
    }

    /**
     * Tell the transports what this server's surface currently hashes to, so presence carries it.
     * Called wherever the surface changes; before any transport exists it is a no-op, and the
     * attach() below hands a late-built transport the current hash so nothing depends on ordering
     * between exposing and connecting.
     */
    private announceShape() {
        if (!this.rpc) return
        // A changed surface owes the network two things: the new hash in presence, and counters
        // on whatever events the schema now declares - counted from expose, not from the first
        // subscriber, or "nothing fired while nobody watched" could never be said honestly.
        this.rpc.trackDeclaredEvents()
        const shape = surfaceShape(this.rpc)
        for (const transport of this.transports) (transport as unknown as { announceShape?: (shape: string) => void }).announceShape?.(shape)
    }

    /** Put one transport into the graph: piped into both handlers, routable from the switch. */
    private attach(transport: Transport) {
        this.transports.push(transport)
        ;(transport as unknown as { announceShape?: (shape: string) => void }).announceShape?.(surfaceShape(this.rpc))
        transport.usePeerRegistry(this.peers)
        transport.pipe(this.rpc)
        transport.pipe(this.caller)
        this.switch?.setTarget(transport)
        // Both listeners are guarded: a transport emits these synchronously from its own inbound
        // path, so anything thrown here unwinds into the transport rather than into something able
        // to report it.
        transport.on(TransportEvent.peerGone, (peer: string) =>
            this.safely('peerGone', peer, () => {
                // Drop the peer's event subscriptions and forget its route as soon as it goes.
                this.rpc.removePeer(peer)
                this.context.dropSubscriber(peer)
                this.peers.delete(peer)
                this.relayPresence(transport, peer, 'offline')
                // A gateway subscription taken out for this peer has nothing left to collect.
                for (const other of this.transports) {
                    const gateway = other as { stopWatchingFor?: (peer: string) => Promise<void> }
                    if (gateway.stopWatchingFor) void gateway.stopWatchingFor(peer).catch((e) => this.emitSafely('presenceError', { peer, error: e }))
                }
            })
        )
        // A peer that arrives on one transport is announced on the others, so a browser connected
        // over socket.io learns about a peer that only exists on the broker.
        transport.on(TransportEvent.peerOnline, (peer: string) => this.safely('peerOnline', peer, () => this.relayPresence(transport, peer, 'online')))
        // Subscriptions this server holds on other peers are replayed when a link returns, the same
        // way RpcClient does it - otherwise a server that watches its peers goes deaf after a blip
        // with nothing to say so.
        transport.on(TransportEvent.connected, () => void this.caller.resubscribe().catch((e) => this.emitSafely('resubscribeError', e)))
        // Component channels and context chains learn staleness from the first three. Link down
        // stales every picture; a peer going or being displaced stales only that peer's. The
        // component channels need no recovery listener - resubscribe() above replays their event
        // subscription - but the context resolver's subscriptions are method-registered, so
        // `connected` is forwarded too and re-subscribing is its own replay.
        for (const event of [TransportEvent.disconnected, TransportEvent.peerGone, TransportEvent.peerDisplaced, TransportEvent.connected])
            transport.on(event, (payload: unknown) => this.componentLifecycle.emit(event, payload))
    }
    /**
     * Pass a presence change from the transport that saw it to the other links: told directly to
     * the peers connected here, and advertised to the hubs this server has dialled into. The
     * advertisement is what makes a network deeper than a star work - and it never includes a peer
     * back on the link it was learned from, or two hubs each end up believing the other is the way
     * to it.
     */
    private relayPresence(from: Transport, peer: string, state: 'online' | 'offline') {
        for (const transport of this.transports) {
            if (transport === from) continue
            const listener = transport as { announcePeer?: (peer: string, state: 'online' | 'offline') => void }
            if (listener.announcePeer) listener.announcePeer(peer, state)
        }
        this.advertiseReachability()
    }

    private advertiseReachability() {
        for (const transport of this.transports) {
            if (!(transport instanceof SocketIoClientTransport)) continue
            transport.advertise(this.peers.names().filter((name) => name !== this.options.name && this.peers.get(name) !== transport))
        }
    }

    /** Not 'error': an EventEmitter throws on an unhandled 'error' event. */
    private emitSafely(event: string, payload: unknown) {
        for (const transport of this.transports) transport.emit(event, payload)
    }

    /**
     * Run a presence reaction without letting it escape into the transport that emitted the event.
     * Bookkeeping here failing is worth reporting; it is not worth ending the process over.
     */
    private safely(what: string, peer: string, react: () => void) {
        try {
            react()
        } catch (e) {
            this.emitSafely('presenceError', { what, peer, error: e })
        }
    }

    /**
     * A typed proxy for calling another peer, over this server's own transports and under its own
     * name. The mirror of RpcClient.proxy, so a peer that both serves and calls needs one object.
     */
    async proxy<T>(name: string, target?: string): Promise<RpcProxy<T>> {
        await this.ready()
        return this.caller.proxy<T>(name, target ?? '*') as RpcProxy<T>
    }

    /**
     * Observe another peer's component over this server's own link and name - the mirror of
     * RpcClient.component, for the same reason proxy() exists: a peer that both serves and calls
     * needs one object, and a browser page hosting a service is exactly such a peer.
     */
    async component<T extends RpcComponentLike>(name: string, target?: string): Promise<RpcComponentProxy<T>> {
        await this.ready()
        this.componentChannels ??= new ComponentChannels(this.caller, this.componentLifecycle)
        const channel = await this.componentChannels.open(name, target)
        return componentFacade(channel, channel.inner) as RpcComponentProxy<T>
    }

    /**
     * Provide one context value at one of this host's topology nodes. The handle is ownership:
     * set() and clear() are the provider's own, and nothing remote can reach either - a remote
     * caller that wants the value changed calls a method on whatever authority the value names.
     */
    provideContext<TValue>(instance: string, token: RpcContextToken<TValue>, initialValue: TValue): RpcContextProviderHandle<TValue> {
        return this.context.provide(instance, token, initialValue)
    }

    /** The resolved, cached view of one token at one local node, live across every host it crosses. */
    contextOf(instance: string, token: RpcContextToken): RpcContextStore {
        return this.contextResolver.store(instance, token)
    }

    /**
     * The same view, for a node on another peer: what *it* sees, not what this host would.
     *
     * For observing rather than acting - a console, a diagnostic, an operator asking why a machine
     * is behaving as though it were on the night shift. Code that *depends* on context should ask
     * about its own node with contextOf(), because a decision taken from another node's ambient
     * data is a decision taken on the wrong node's behalf.
     *
     * The alternative a console would otherwise reach for is grafting itself into the topology
     * next to the node it wants to read, which is a claim about the plant that happens to be
     * false, and which physical edges refuse anyway - they cross hosts only root to root.
     */
    contextAt(node: RpcRef, token: RpcContextToken): RpcContextStore {
        return this.contextResolver.storeAt(node, token)
    }

    /** The policy gate: throws on invalid and missing, and on stale where the token rejects it. */
    requireContext(instance: string, token: RpcContextToken): unknown {
        return this.contextResolver.require(instance, token)
    }

    /** Deliberately capture what this node sees, for a payload - bounded, and explicit-only. */
    captureContext(instance: string, tokens: RpcContextToken[]): RpcCapturedContext {
        return this.contextResolver.capture(instance, tokens)
    }

    async close() {
        // Construction is asynchronous, so a server closed straight after `new` was closing an
        // empty transport list while its listener was still being built - which then bound its
        // port with nobody left holding a reference. Found on a machine where the default port was
        // free; invisible on any machine where something else already owned it, because the bind
        // failed and there was nothing to leak. Awaited settled-or-failed: initError is close's
        // business to ignore, not to wait out.
        await this.starting.catch(() => undefined)
        // Stores are told 'closed' rather than left waiting on a link that is gone; the server at
        // the far end reaps a departed subscriber, so local teardown is all that is owed.
        this.componentChannels?.closeAll()
        this.caller.failPendingCalls('server closed')
        this.caller.subscriptions.clear()
        await this.caller.close()
        // forEach with an async callback did not await anything, so close() returned while the
        // listeners were still open.
        await Promise.all(this.transports.map((transport) => transport.close()))
        this.transports = []
        this.peers.clear()
    }
    exposeClassInstance(instance: object, name?: string, options?: number | ExposeOptions): void {
        this.rpc.manageRpc.exposeClassInstance(instance, name, options)
        this.announceShape()
    }
    exposeClass<T>(constructor: new (...args: unknown[]) => T, aliasName?: string): void {
        this.rpc.manageRpc.exposeClass(constructor, aliasName)
        this.announceShape()
    }
    exposeObject(obj: object, name: string): void {
        this.rpc.manageRpc.exposeObject(obj, name)
        this.announceShape()
    }
    expose(methodName: string, method: () => void): void {
        this.rpc.manageRpc.expose(methodName, method)
        this.announceShape()
    }
    async createRpcInstance(className: string, instanceName?: string, ...args: unknown[]): Promise<string | undefined> {
        const created = await this.rpc.manageRpc.createRpcInstance(className, instanceName, ...args)
        this.announceShape()
        return created
    }
    addTarget(target: string, transport: GenericModule) {
        this.switch?.setTarget(transport)
    }
    async init() {}
    async ready() {
        await this.starting
        const allTransportsReady = () => {
            return this.transports.filter((trp) => !trp.readyFlag).length == 0
        }
        // Previously an unbounded wait, so a server whose broker was unreachable hung at startup
        // with no diagnostic at all.
        const deadline = Date.now() + this.options.readyTimeout
        while (!allTransportsReady() || !this.readyFlag) {
            // A transport that can never come up says so, rather than being waited out: a port
            // already in use is not something more time fixes.
            const failed = this.transports.find((transport) => (transport as { startupError?: unknown }).startupError !== undefined)
            if (failed) this.initError = (failed as { startupError?: unknown }).startupError
            if (this.initError !== undefined)
                throw new Error(`RpcServer '${this.options.name}': could not start: ${this.initError instanceof Error ? this.initError.message : String(this.initError)}`, {
                    cause: this.initError
                })
            if (this.options.readyTimeout > 0 && Date.now() > deadline) {
                const pending = this.transports.filter((trp) => !trp.readyFlag).map((trp) => trp.getName())
                throw new Error(`RpcServer '${this.options.name}': transports not ready within ${this.options.readyTimeout} ms: ${pending.join(', ')}`)
            }
            await new Promise((res) => setTimeout(res, 10))
        }
    }

    /**
     * Wait until a peer is addressable from here, rather than calling it and hoping.
     *
     * `ready()` says this peer's own links are up. It says nothing about anyone else, and it cannot:
     * presence arrives over those links a moment after they open, and over MQTT a retained
     * announcement lands a moment after the subscription does. Calling in that moment reaches a
     * switch with no route and fails.
     *
     * This is the wait that closes it, and the reason it is here rather than in each application is
     * that everything built on this library has needed it - the CLI's verbs, its recorder, its
     * replayer and its console each grew their own copy before this existed.
     *
     * Returns true when the peer is addressable, false if it never appeared. A `false` is worth
     * reporting as "nobody is answering to that name" rather than retrying: the usual cause is a
     * peer that is not running or is running under a different name.
     */
    async awaitPeer(peer: string, timeout = 5000) {
        const deadline = Date.now() + timeout
        for (;;) {
            if (this.peers.get(peer)) return true
            if (Date.now() >= deadline) return false
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
    }

    /**
     * awaitPeer's sibling for when no name is known: ready(), and then the first presence sweep
     * on every transport that receives one - the retained presence read on MQTT, the announced
     * list delivered on socket.io. A transport with no sweep to wait for, such as a listener that
     * learns peers as they dial in, settles at once, so a freshly started hub honestly reports
     * whoever has already dialled and nobody else.
     *
     * Settled means exactly that the first sweep arrived, not that every peer that will ever
     * exist has: a peer that joins a second from now still appears a second from now, and a
     * network with nobody on it settles empty. `waitMs` bounds the wait and then resolves rather
     * than throws - the names known at the bound are still worth more than an error.
     *
     * Returns the peer names known at that moment, this server's own excluded.
     */
    async peersSettled(waitMs = 2000): Promise<string[]> {
        await this.ready()
        await settledAfterSweeps(this.transports, waitMs)
        return this.peers.names().filter((name) => name !== this.options.name)
    }
}
