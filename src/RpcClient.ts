import { EventEmitter } from 'events'
import { GenericModule, TransportEvent } from './RPC/Core.js'
import { defaultWebSocketPort, IManageRpc } from './RPC/Rpc.js'
import { defaultCallTimeout, RpcClientHandler } from './RPC/RpcClientHandler.js'
import type { IClientOptions } from 'mqtt'
import { MqttTransport } from './Transports/MqttTransport.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { JsonParser, JsonStringifierToUint8Array, MsgPackDecoder, MsgPackEncoder } from './Utilities/Converters.js'
import { v4 as uuidv4 } from 'uuid'

export interface RpcClientOptions {
    name: string
    /** Supply one to take full control of the link. When absent init() builds one from the url. */
    transport?: GenericModule
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
    parser?: JsonParser
    rpcClient?: RpcClientHandler
    stringifier?: JsonStringifierToUint8Array<object>
    manageRpc?: IManageRpc
    readyFlag = false
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
        this.readyFlag = false
    }
    async init() {
        // A caller-supplied transport is honoured. It used to be overwritten unconditionally, so
        // passing one had no effect at all.
        let transport = this.options.transport
        if (!transport) {
            const socketOptions = this.options.credentials ? { auth: this.options.credentials as { [key: string]: unknown } } : {}
            const mqttOptions = (this.options.credentials ?? {}) as IClientOptions
            if (this.url?.startsWith('http') || this.url?.startsWith('ws')) transport = new SocketIoClientTransport(this.url, undefined, socketOptions)
            else if (this.url?.startsWith('mqtt')) transport = new MqttTransport(this.options.name, this.url, { mqtt: mqttOptions })
            else transport = new SocketIoClientTransport(`http://localhost:${defaultWebSocketPort}`, undefined, socketOptions)
        }
        this.options.transport = transport
        if (this.options.useMsgPack) this.parser = new MsgPackDecoder([this.options.transport])
        else this.parser = new JsonParser([this.options.transport])
        this.rpcClient = new RpcClientHandler(this.options.name, [this.parser], this.options.callTimeout)
        if (this.options.useMsgPack) this.stringifier = new MsgPackEncoder([this.rpcClient])
        else this.stringifier = new JsonStringifierToUint8Array([this.rpcClient])
        this.stringifier.pipe(this.options.transport)
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
