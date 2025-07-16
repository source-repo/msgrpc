import { Server } from 'http'
import { GenericModule } from './RPC/Core.js'
import { RpcServerHandler } from './RPC/RpcServerHandler.js'
import { MqttTransport } from './Transports/MqttTransport.js'
import { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'
import { JsonParser, JsonStringifierToUint8Array, MsgPackDecoder, MsgPackEncoder } from './Utilities/Converters.js'
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

export interface MqttServerOptions extends ServerOptions {
    brokerurl: string
}

export interface RpcServerOptions {
    name: string
    transports: (HttpServerOptions | ExternalServerOptions | MqttServerOptions | GenericModule)[]
    useMsgPack: boolean
}

export class RpcServer implements IManageRpc {
    parser?: JsonParser
    public rpc: RpcServerHandler
    stringifier?: JsonStringifierToUint8Array<object>
    readyFlag = false
    switch?: Switch
    transports: GenericModule[] = []
    options: RpcServerOptions = { name: '*', transports: [], useMsgPack: true }
    constructor(options: Partial<RpcServerOptions> = {}) {
        this.options = { ...this.options, ...options }
        this.transports = this.options.transports.map((serveroption) => {
            let transport: GenericModule | undefined
            if (serveroption instanceof GenericModule) transport = serveroption
            else if ((serveroption as HttpServerOptions).port)
                transport = new SocketIoServerTransport(
                    this.options.name,
                    undefined,
                    (serveroption as HttpServerOptions).port,
                    (serveroption as HttpServerOptions).https,
                    [],
                    { path: (serveroption as HttpServerOptions).path }
                )
            else if ((serveroption as MqttServerOptions).brokerurl)
                transport = new MqttTransport(this.options.name, (serveroption as MqttServerOptions).brokerurl)
            else if ((serveroption as ExternalServerOptions).server)
                transport = new SocketIoServerTransport(this.options.name, (serveroption as ExternalServerOptions).server, 0, false, [], {
                    path: (serveroption as ExternalServerOptions).path
                })
            if (!transport) throw new Error('RpcServer: Invalid transport defined')
            return transport
        })
        if (this.transports.length == 0) this.transports.push(new SocketIoServerTransport('*', undefined, defaultWebSocketPort, false))

        if (this.options.useMsgPack) this.parser = new MsgPackDecoder(this.transports)
        else this.parser = new JsonParser(this.transports)
        this.rpc = new RpcServerHandler(this.options.name, [this.parser])
        if (this.options.useMsgPack) this.stringifier = new MsgPackEncoder([this.rpc])
        else this.stringifier = new JsonStringifierToUint8Array([this.rpc])
        this.switch = new Switch([this.stringifier])
        this.switch.setTargets(this.transports)
        this.readyFlag = true
        this.init()
    }
    async close() {
        this.transports.forEach(async (trp) => await trp.close())
        this.transports = []
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
        while (!allTransportsReady() || !this.readyFlag) await new Promise((res) => setTimeout(res, 10))
    }
}
