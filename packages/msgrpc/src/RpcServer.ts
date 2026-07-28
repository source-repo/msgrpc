import { Server } from 'http'
import { GenericModule, PeerRegistry, Transport, TransportEvent } from './RPC/Core.js'
import { RpcAuthenticator, RpcAuthorizer } from './RPC/Auth.js'
import { RpcSchema } from './RPC/Schema.js'
import { Introspection } from './RPC/Introspection.js'
import { RpcServerHandler } from './RPC/RpcServerHandler.js'
import { defaultCallTimeout, RpcClientHandler } from './RPC/RpcClientHandler.js'
import { RpcProxy } from './RpcClient.js'
import { MqttTransport, MqttTransportOptions } from './Transports/MqttTransport.js'
import { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { RelayRule } from './Transports/Presence.js'
import { codecFor } from './RPC/Codec.js'
import { Switch } from './Utilities/Switch.js'
import { defaultWebSocketPort, IManageRpc } from './RPC/Rpc.js'

export interface ServerOptions {
    description?: string
}

export interface HttpServerOptions extends ServerOptions {
    port: number
    https?: boolean
    path?: string
}

export interface ExternalServerOptions extends ServerOptions {
    server: Server
    path?: string
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
}

export interface MqttServerOptions extends ServerOptions, MqttTransportOptions {
    brokerurl: string
}

export interface RpcServerOptions {
    name: string
    transports: (HttpServerOptions | ExternalServerOptions | ConnectServerOptions | MqttServerOptions | Transport)[]
    useMsgPack: boolean
    /**
     * Verify credentials when a peer connects. Applied to socket.io transports this server builds.
     * MQTT has no server-side handshake, so MQTT peers are authenticated by the broker instead.
     */
    authenticate?: RpcAuthenticator
    /** Called for every call and every event subscription. Return false to reject it. */
    authorize?: RpcAuthorizer
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
    /** Refuse to expose a class that marks no @rpc methods, rather than publishing all of them. */
    requireExplicitExposure?: boolean
    /** Refuse a caller declaring a contract version the schema has no history for. Default 'allow'. */
    unknownVersion?: 'allow' | 'reject'
    /**
     * Publish msgrpc.describe(), which reports the exposed namespaces, their methods and events,
     * and which instances are live. Off by default: listing all of that is reconnaissance, and it
     * is subject to authorize() like any other call.
     */
    exposeIntrospection?: boolean
}

export class RpcServer implements IManageRpc {
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
    options: RpcServerOptions = { name: '*', transports: [], useMsgPack: true, readyTimeout: 30000 }
    constructor(options: Partial<RpcServerOptions> = {}) {
        this.options = { ...this.options, ...options }
        this.transports = this.options.transports.map((serveroption) => {
            let transport: Transport | undefined
            if (serveroption instanceof GenericModule) transport = serveroption as Transport
            else if ((serveroption as HttpServerOptions).port)
                transport = new SocketIoServerTransport(
                    this.options.name,
                    undefined,
                    (serveroption as HttpServerOptions).port,
                    (serveroption as HttpServerOptions).https,
                    [],
                    { path: (serveroption as HttpServerOptions).path },
                    this.options.authenticate
                )
            else if ((serveroption as MqttServerOptions).brokerurl) {
                const mqttServerOptions = serveroption as MqttServerOptions
                transport = new MqttTransport(this.options.name, mqttServerOptions.brokerurl, {
                    // A server should not lose requests published while it was restarting, so it
                    // keeps its broker session by default. Clients do not: a late reply is useless
                    // to a call that has already timed out, and every short-lived peer would leave
                    // session state behind on the broker.
                    persistentSession: true,
                    ...mqttServerOptions
                })
            }
            else if ((serveroption as ConnectServerOptions).connect) {
                const connectOptions = serveroption as ConnectServerOptions
                transport = new SocketIoClientTransport(
                    this.options.name,
                    connectOptions.connect,
                    [],
                    {
                        ...(connectOptions.path ? { path: connectOptions.path } : {}),
                        ...(connectOptions.credentials ? { auth: connectOptions.credentials as { [key: string]: unknown } } : {})
                    }
                )
            }
            else if ((serveroption as ExternalServerOptions).server)
                transport = new SocketIoServerTransport(
                    this.options.name,
                    (serveroption as ExternalServerOptions).server,
                    0,
                    false,
                    [],
                    { path: (serveroption as ExternalServerOptions).path },
                    this.options.authenticate
                )
            if (!transport) throw new Error('RpcServer: Invalid transport defined')
            return transport
        })
        if (this.transports.length == 0) this.transports.push(new SocketIoServerTransport('*', undefined, defaultWebSocketPort, false))

        // The transports encode, so there is no converter between them and the handler. A
        // structured wire format such as MQTT 5 needs to see the message rather than bytes a
        // converter already flattened.
        const codec = codecFor(this.options.useMsgPack)
        for (const transport of this.transports) {
            transport.codec = codec
            if (this.options.relay !== undefined && transport instanceof SocketIoServerTransport) transport.relay = this.options.relay
        }
        this.rpc = new RpcServerHandler(this.options.name, this.transports)
        // Both handlers see every inbound frame and each ignores what is not theirs: the server
        // handler acts only on calls, the client handler only on responses and events.
        this.caller = new RpcClientHandler(this.options.name, this.transports, this.options.callTimeout ?? defaultCallTimeout)
        this.switch = new Switch([this.rpc, this.caller])
        this.switch.setTargets(this.transports)
        // One registry for this server's modules only. The transports record which peer they saw a
        // message from; the switch reads it back to route the reply out of the same transport.
        for (const module of [...this.transports, this.rpc, this.caller, this.switch]) module.usePeerRegistry(this.peers)
        this.transports.forEach((transport) => {
            transport.on(TransportEvent.peerGone, (peer: string) => {
                // Drop the peer's event subscriptions and forget its route as soon as it goes away.
                this.rpc.removePeer(peer)
                this.peers.delete(peer)
                this.relayPresence(transport, peer, 'offline')
                // A gateway subscription taken out for this peer has nothing left to collect.
                for (const other of this.transports) if (other instanceof MqttTransport) void other.stopWatchingFor(peer)
            })
            // A peer that arrives on one transport is announced on the others, so a browser
            // connected over socket.io learns about a peer that only exists on the broker.
            transport.on(TransportEvent.peerOnline, (peer: string) => this.relayPresence(transport, peer, 'online'))
            // Subscriptions this server holds on other peers are replayed when a link returns, the
            // same way RpcClient does it - otherwise a server that watches its peers goes deaf
            // after a blip with nothing to say so.
            transport.on(TransportEvent.connected, () => void this.caller.resubscribe().catch((e) => this.emitSafely('resubscribeError', e)))
        })

        this.rpc.authorize = this.options.authorize
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
        this.rpc.unknownVersion = this.options.unknownVersion ?? 'allow'
        this.rpc.manageRpc.requireExplicitExposure = this.options.requireExplicitExposure ?? false
        if (this.options.exposeManagement) this.rpc.manageRpc.exposeManagement()
        if (this.options.exposeIntrospection) this.rpc.manageRpc.exposeClassInstance(new Introspection(this.rpc))
        this.readyFlag = true
        this.init()
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
            if (transport instanceof SocketIoServerTransport) transport.announcePeer(peer, state)
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
     * A typed proxy for calling another peer, over this server's own transports and under its own
     * name. The mirror of RpcClient.proxy, so a peer that both serves and calls needs one object.
     */
    async proxy<T>(name: string, target?: string) {
        await this.ready()
        const result: RpcProxy<T> = { name }
        if (target) result.target = target
        result.remote = this.caller.proxy<T>(name, target ?? '*')
        return result
    }

    async close() {
        this.caller.failPendingCalls('server closed')
        this.caller.subscriptions.clear()
        await this.caller.close()
        // forEach with an async callback did not await anything, so close() returned while the
        // listeners were still open.
        await Promise.all(this.transports.map((transport) => transport.close()))
        this.transports = []
        this.peers.clear()
    }
    exposeClassInstance(instance: object, name?: string, prototypeSteps?: number): void {
        this.rpc.manageRpc.exposeClassInstance(instance, name, prototypeSteps)
    }
    exposeClass<T>(constructor: new (...args: unknown[]) => T, aliasName?: string): void {
        this.rpc.manageRpc.exposeClass(constructor, aliasName)
    }
    exposeObject(obj: object, name: string): void {
        this.rpc.manageRpc.exposeObject(obj, name)
    }
    expose(methodName: string, method: () => void): void {
        this.rpc.manageRpc.expose(methodName, method)
    }
    createRpcInstance(className: string, instanceName?: string, ...args: unknown[]): Promise<string | undefined> {
        return this.rpc.manageRpc.createRpcInstance(className, instanceName, ...args)
    }
    addTarget(target: string, transport: GenericModule) {
        this.switch?.setTarget(transport)
    }
    async init() {}
    async ready() {
        const allTransportsReady = () => {
            return this.transports.filter((trp) => !trp.readyFlag).length == 0
        }
        // Previously an unbounded wait, so a server whose broker was unreachable hung at startup
        // with no diagnostic at all.
        const deadline = Date.now() + this.options.readyTimeout
        while (!allTransportsReady() || !this.readyFlag) {
            if (this.options.readyTimeout > 0 && Date.now() > deadline) {
                const pending = this.transports.filter((trp) => !trp.readyFlag).map((trp) => trp.getName())
                throw new Error(`RpcServer '${this.options.name}': transports not ready within ${this.options.readyTimeout} ms: ${pending.join(', ')}`)
            }
            await new Promise((res) => setTimeout(res, 10))
        }
    }
}
