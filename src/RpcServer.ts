import { Server } from 'http'
import { GenericModule, PeerRegistry, Transport, TransportEvent } from './RPC/Core.js'
import { RpcAuthenticator, RpcAuthorizer } from './RPC/Auth.js'
import { RpcServerHandler } from './RPC/RpcServerHandler.js'
import { MqttTransport, MqttTransportOptions } from './Transports/MqttTransport.js'
import { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'
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

export interface MqttServerOptions extends ServerOptions, MqttTransportOptions {
    brokerurl: string
}

export interface RpcServerOptions {
    name: string
    transports: (HttpServerOptions | ExternalServerOptions | MqttServerOptions | Transport)[]
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
     * Publish manageRpc.createRpcInstance so peers can instantiate exposed classes remotely.
     * Off by default: it is remote object construction, and it is rarely needed.
     */
    exposeManagement?: boolean
    /** How long ready() waits for every transport to connect before throwing. 0 waits forever. */
    readyTimeout: number
}

export class RpcServer implements IManageRpc {
    public rpc: RpcServerHandler
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
        for (const transport of this.transports) transport.codec = codec
        this.rpc = new RpcServerHandler(this.options.name, this.transports)
        this.switch = new Switch([this.rpc])
        this.switch.setTargets(this.transports)
        // One registry for this server's modules only. The transports record which peer they saw a
        // message from; the switch reads it back to route the reply out of the same transport.
        for (const module of [...this.transports, this.rpc, this.switch]) module.usePeerRegistry(this.peers)
        this.transports.forEach((transport) =>
            transport.on(TransportEvent.peerGone, (peer: string) => {
                // Drop the peer's event subscriptions and forget its route as soon as it goes away.
                this.rpc.removePeer(peer)
                this.peers.delete(peer)
            })
        )

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
        if (this.options.exposeManagement) this.rpc.manageRpc.exposeManagement()
        this.readyFlag = true
        this.init()
    }
    async close() {
        // forEach with an async callback did not await anything, so close() returned while the
        // listeners were still open.
        await Promise.all(this.transports.map((transport) => transport.close()))
        this.transports = []
        this.peers.clear()
    }
    exposeClassInstance(instance: object, name: string, prototypeSteps?: number): void {
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
