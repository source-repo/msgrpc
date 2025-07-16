import { GenericModule } from './RPC/Core.js'
import { defaultWebSocketPort, IManageRpc } from './RPC/Rpc.js'
import { RpcClientHandler } from './RPC/RpcClientHandler.js'
import { MqttTransport } from './Transports/MqttTransport.js'
import { SocketIoClientTransport } from './Transports/SocketIoClientTransport.js'
import { JsonParser, JsonStringifierToUint8Array, MsgPackDecoder, MsgPackEncoder } from './Utilities/Converters.js'
import { v4 as uuidv4 } from 'uuid'

export interface RpcClientOptions {
    name: string
    transport: GenericModule
    defaultTarget?: string
    useMsgPack: boolean
}

export interface RpcProxy<T> {
    name: string
    target?: string
    remote?: T
}

export class RpcClient {
    parser?: JsonParser
    rpcClient?: RpcClientHandler
    stringifier?: JsonStringifierToUint8Array<object>
    manageRpc?: IManageRpc
    readyFlag = false
    options: RpcClientOptions = { name: uuidv4(), transport: new SocketIoClientTransport(), defaultTarget: '*', useMsgPack: true }
    constructor(
        public url?: string,
        options: Partial<RpcClientOptions> = {}
    ) {
        this.options = { ...this.options, ...options }
        this.init()
    }
    async close() {
        this.rpcClient?.close()
        this.options.transport.close()
    }
    async init() {
        let transport: GenericModule | undefined
        if (this.url?.startsWith('http') || this.url?.startsWith('ws')) transport = new SocketIoClientTransport(this.url, undefined)
        if (this.url?.startsWith('mqtt')) transport = new MqttTransport(this.options.name, this.url)
        if (!transport) transport = new SocketIoClientTransport(`http://localhost:${defaultWebSocketPort}`)
        this.options.transport = transport
        if (this.options.useMsgPack) this.parser = new MsgPackDecoder([this.options.transport])
        else this.parser = new JsonParser([this.options.transport])
        this.rpcClient = new RpcClientHandler(this.options.name, [this.parser])
        if (this.options.useMsgPack) this.stringifier = new MsgPackEncoder([this.rpcClient])
        else this.stringifier = new JsonStringifierToUint8Array([this.rpcClient])
        this.stringifier.pipe(this.options.transport)
        this.readyFlag = true
        this.manageRpc = (await this.proxy<IManageRpc>('manageRpc')).remote
        await this.options.transport.open()
    }
    async ready() {
        while (!this.options.transport.readyFlag || !this.readyFlag) await new Promise((res) => setTimeout(res, 10))
    }
    async proxy<T>(name: string, target?: string) {
        await this.ready()
        const result: RpcProxy<T> = { name }
        if (target) result.target = target
        if (this.rpcClient) result.remote = this.rpcClient.proxy<T>(name, target ? target : this.options.defaultTarget)
        return result
    }
}
