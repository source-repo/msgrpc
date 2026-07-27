import { EventEmitter } from 'events'
import { GenericModule, PeerRegistry, Transport, TransportEvent } from './RPC/Core.js'
import { MessageSigner } from './RPC/Auth.js'
import { defaultWebSocketPort, IManageRpc } from './RPC/Rpc.js'
import { defaultCallTimeout, RpcClientHandler } from './RPC/RpcClientHandler.js'
import type { IClientOptions } from 'mqtt'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { codecFor } from './RPC/Codec.js'
import { v4 as uuidv4 } from 'uuid'

export interface RpcClientOptions {
    name: string
    /** Supply one to take full control of the link. When absent init() builds one from the url. */
    transport?: Transport
    defaultTarget?: string
    useMsgPack: boolean
    /** How long a call waits for a response before rejecting with an RpcError of code 'Timeout'. */
    callTimeout: number
    /** How long ready() waits for the transport to connect before throwing. 0 waits forever. */
    readyTimeout: number
    /** Reject in-flight calls as soon as the link drops instead of waiting out their timeouts. */
    failCallsOnDisconnect: boolean
    /**
     * Credentials presented when connecting to a server that authenticates. Passed to socket.io as
     * the handshake `auth` payload, and to MQTT as broker connect options. When the server
     * authenticates, `name` must match the identity these credentials resolve to - the server
     * drops frames whose source does not match.
     */
    credentials?: unknown
    /**
     * Sign outgoing frames. Only meaningful for MQTT, where there is no connection for a server to
     * authenticate and the source field would otherwise be an unverifiable claim.
     */
    sign?: MessageSigner
}

export interface RpcProxy<T> {
    name: string
    target?: string
    remote?: T
}

/**
 * Emits the TransportEvent.connected and TransportEvent.disconnected lifecycle events so an
 * application can show link state instead of inferring it from failed calls.
 */
export class RpcClient extends EventEmitter {
    rpcClient?: RpcClientHandler
    manageRpc?: IManageRpc
    readyFlag = false
    /** Peer name -> module, shared by this client's modules and nothing outside them. */
    readonly peers = new PeerRegistry()
    // No transport here: constructing one in a field initialiser opened a socket on every client
    // that init() then replaced and orphaned, leaving it reconnecting forever.
    options: RpcClientOptions = {
        name: uuidv4(),
        defaultTarget: '*',
        useMsgPack: true,
        callTimeout: defaultCallTimeout,
        readyTimeout: 30000,
        failCallsOnDisconnect: true
    }
    constructor(
        public url?: string,
        options: Partial<RpcClientOptions> = {}
    ) {
        super()
        this.options = { ...this.options, ...options }
        this.init()
    }
    async close() {
        this.rpcClient?.failPendingCalls('client closed')
        this.rpcClient?.subscriptions.clear()
        await this.rpcClient?.close()
        await this.options.transport?.close()
        this.peers.clear()
        this.readyFlag = false
    }
    async init() {
        // A caller-supplied transport is honoured. It used to be overwritten unconditionally, so
        // passing one had no effect at all.
        let transport = this.options.transport
        if (!transport) {
            const socketOptions = this.options.credentials ? { auth: this.options.credentials as { [key: string]: unknown } } : {}
            if (this.url?.startsWith('http') || this.url?.startsWith('ws')) transport = new SocketIoClientTransport(this.url, undefined, socketOptions)
            else if (this.url?.startsWith('mqtt')) {
                // Imported on demand so a browser bundle that only speaks WebSocket does not have
                // to carry the MQTT client. Bundlers split this into a chunk fetched only when an
                // mqtt:// url is actually used.
                const { MqttTransport } = await import('./Transports/MqttTransport.js')
                transport = new MqttTransport(this.options.name, this.url, {
                    mqtt: (this.options.credentials ?? {}) as IClientOptions,
                    sign: this.options.sign
                })
            } else transport = new SocketIoClientTransport(`http://localhost:${defaultWebSocketPort}`, undefined, socketOptions)
        }
        this.options.transport = transport
        // The transport encodes, so there is no converter between it and the handler. A structured
        // wire format such as MQTT 5 needs to see the message, not bytes a converter already flattened.
        transport.codec = codecFor(this.options.useMsgPack)
        this.rpcClient = new RpcClientHandler(this.options.name, [transport], this.options.callTimeout)
        this.rpcClient.pipe(transport)
        for (const module of [transport, this.rpcClient]) module.usePeerRegistry(this.peers)
        this.wireTransportLifecycle(transport)
        this.readyFlag = true
        // Built directly instead of via proxy(), which awaits ready(). init() is not awaited by
        // the constructor, so a ready() rejection here would surface as an unhandled rejection.
        // The proxy is inert until a call is made, so there is nothing to wait for.
        this.manageRpc = this.rpcClient.proxy<IManageRpc>('manageRpc', this.options.defaultTarget)
        await this.options.transport.open()
    }

    /**
     * React to the link coming and going. On reconnect the subscriptions are replayed, which both
     * restores server-side state and re-identifies this client so pushed events can reach it again.
     */
    private wireTransportLifecycle(transport: GenericModule) {
        transport.on(TransportEvent.disconnected, (reason: string) => {
            if (this.options.failCallsOnDisconnect) this.rpcClient?.failPendingCalls(`transport disconnected: ${reason ?? 'unknown reason'}`)
            this.emit(TransportEvent.disconnected, reason)
        })
        transport.on(TransportEvent.connected, () => {
            // No-op on the first connect, when nothing has been subscribed yet.
            this.rpcClient
                ?.resubscribe()
                .then((restored) => this.emit(TransportEvent.connected, { restoredSubscriptions: restored }))
                // Not 'error': an EventEmitter throws on an unhandled 'error' event.
                .catch((e) => this.emit('resubscribeError', e))
        })
    }

    async ready() {
        const deadline = Date.now() + this.options.readyTimeout
        while (!this.options.transport?.readyFlag || !this.readyFlag) {
            if (this.options.readyTimeout > 0 && Date.now() > deadline)
                throw new Error(`RpcClient '${this.options.name}': transport not ready within ${this.options.readyTimeout} ms`)
            await new Promise((res) => setTimeout(res, 10))
        }
    }
    async proxy<T>(name: string, target?: string) {
        await this.ready()
        const result: RpcProxy<T> = { name }
        if (target) result.target = target
        if (this.rpcClient) result.remote = this.rpcClient.proxy<T>(name, target ? target : this.options.defaultTarget)
        return result
    }
}
