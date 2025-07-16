import { MessageModule, Message, MessageType, Payload, GenericModule } from './Core.js'
import { v4 as uuidv4 } from 'uuid'
import { IManageRpc } from './Rpc.js'
import EventEmitter from 'events'
import { RpcClient } from '../RpcClient.js'
import { ILogger, LogLevel } from '../Logging/ILogger.js'

export enum RpcMessageType {
    CallInstanceMethod = 'POST',
    success = 'SUCCESS',
    error = 'ERROR',
    event = 'EVENT'
}

export interface RpcMessage extends Payload {
    type: RpcMessageType
}

export interface RpcCallInstanceMethodPayload extends RpcMessage {
    id: string
    path: string
    method: string
    params: unknown[]
}

export type RpcErrorCode = 'ClassNotFound' | 'MethodNotFound' | 'Exception'

export interface RpcErrorPayload extends RpcMessage {
    code: RpcErrorCode
    exception?: unknown
}
export interface RpcSuccessPayload extends RpcMessage {
    id: string
    result: unknown
}
export interface RpcEventPayload extends RpcMessage {
    event: string
    params: unknown[]
}

class EventProxy {
    constructor(
        public rpcServer: RpcServerHandler,
        public instance: object,
        public event: string,
        public target: string
    ) {}
    on(...args: unknown[]) {
        this.rpcServer.sendEvent(this.target, this.event, args)
    }
}

export type BindObject = {
    [index: string]: (...args: unknown[]) => unknown
}

export type ObjectByString = { [index: string]: unknown }

const isRpcCallInstanceMethodPayload = (payload: RpcMessage): payload is RpcCallInstanceMethodPayload => {
    return payload.type === RpcMessageType.CallInstanceMethod
}

export class RpcServerHandler extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> {
    manageRpc = new ManageRpc()
    eventProxies = new Map<{ instanceName: string; event: string; source: string }, EventProxy>()

    constructor(name: string, sources?: GenericModule<unknown, unknown, Message, RpcMessage>[]) {
        super(name, sources)
        this.manageRpc.logger?.log('Information', 'RpcServerHandler {name} starting', { name })
    }

    async receive(message: Message<RpcMessage>, source: string, target: string) {
        this.manageRpc.logger?.log('Debug', 'RpcServerHandler {name} received message type {type} from {source} to {target}: {message}', {
            name: this.name,
            type: message.type,
            source,
            target,
            message: JSON.stringify(message)
        })
        if (message.payload) this.receivePayload(message.payload, source, target)
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async receivePayload(payload: RpcMessage, source: string, target: string) {
        if (isRpcCallInstanceMethodPayload(payload)) {
            const map = this.manageRpc.getNameSpaceMethodMap(payload.path)
            const handler = map.get(payload.method)
            if (!handler) {
                const instanceName = payload.path
                const event = payload.params[0] as string
                const inst = this.manageRpc.exposedNameSpaceInstances[instanceName]
                if (payload.method === 'on' && inst instanceof EventEmitter) {
                    const eventKey = { instanceName, event, source }
                    let eventProxy = this.eventProxies.get(eventKey)
                    if (!eventProxy) {
                        eventProxy = new EventProxy(this, inst, event, source)
                        this.eventProxies.set(eventKey, eventProxy)
                        ;(inst as EventEmitter).on(event, eventProxy.on.bind(eventProxy))
                        this.sendPayload(
                            { type: RpcMessageType.success, result: 'ok', id: payload.id } as RpcSuccessPayload,
                            MessageType.ResponseMessage,
                            this.name,
                            source
                        )
                    } else
                        this.sendPayload(
                            { type: RpcMessageType.success, result: 'ok - already exists', id: payload.id } as RpcSuccessPayload,
                            MessageType.ResponseMessage,
                            this.name,
                            source
                        )
                } else this.sendPayload({ type: RpcMessageType.error, code: 'MethodNotFound' } as RpcErrorPayload, MessageType.ErrorMessage, this.name, source)
                return
            }

            const params = [...payload.params]
            let result
            try {
                result = await handler(...params)
                this.sendPayload({ type: RpcMessageType.success, id: payload.id, result } as RpcSuccessPayload, MessageType.ResponseMessage, this.name, source)
            } catch (e) {
                this.sendPayload(
                    { type: RpcMessageType.error, code: 'Exception', exception: e } as RpcErrorPayload,
                    MessageType.ErrorMessage,
                    this.name,
                    source
                )
            }
        }
    }

    async sendEvent(target: string, event: string, params: unknown[]) {
        return await this.sendPayload({ type: RpcMessageType.event, event, params } as RpcEventPayload, MessageType.EventMessage, this.name, target)
    }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class DummyLogger implements ILogger {
    log(level: LogLevel, messageTemplate: string, properties?: { [key: string]: unknown } | undefined) {
        console.log(`LEVEL ${level.toString()}, messageTemplate: ${messageTemplate}, properties: "${properties ? JSON.stringify(properties) : '<empty>'}"`)
    }
}

export class ManageRpc implements IManageRpc {
    exposedNameSpaceMethodMaps: { [nameSpace: string]: Map<string, (...args: unknown[]) => void> } = {}
    exposedNameSpaceInstances: { [nameSpace: string]: object } = {}
    exposedClasses: { [className: string]: new (...args: unknown[]) => unknown } = {}
    createdInstances = new Map<string, object>()
    rpcClientConnections: { [url: string]: RpcClient } = {}

    constructor(public logger?: ILogger) {
        this.exposeClassInstance(this, ManageRpc.name.charAt(0).toLowerCase() + ManageRpc.name.slice(1))
        if (this.logger) this.exposeClassInstance(this.logger, 'logger')
    }
    getNameSpaceMethodMap(name: string) {
        let result = this.exposedNameSpaceMethodMaps[name]
        if (!result) {
            result = new Map<string, () => void>()
            this.exposedNameSpaceMethodMaps[name] = result
        }
        return result
    }

    exposeClassInstance(instance: object, name: string, prototypeSteps?: number) {
        this.exposedNameSpaceInstances[name] = instance
        // Iterate upwards to find all the methods within the prototype chain.
        let props = Object.getOwnPropertyNames(instance.constructor.prototype)
        let parent = Object.getPrototypeOf(instance.constructor.prototype)
        while (parent && parent.constructor.name !== 'Object' && parent.constructor.name !== 'EventEmitter') {
            const parentProps = Object.getOwnPropertyNames(parent)
            props = props.concat(parentProps)
            parent = Object.getPrototypeOf(parent)
            if (prototypeSteps && prototypeSteps-- === 0) break
        }
        // All methods was found.
        const map = this.getNameSpaceMethodMap(name)
        for (const f of props) {
            if (f !== 'constructor' && typeof (instance as ObjectByString)[f] === 'function') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                map.set(f, (instance as BindObject)[f].bind(instance))
            }
        }
    }

    exposeClass<T>(constructor: new () => T, aliasName?: string) {
        let name = constructor.name
        if (aliasName) name = aliasName
        this.exposedClasses[name] = constructor
    }

    exposeObject(obj: object, name: string) {
        this.exposedNameSpaceInstances[name] = obj
        const props = Object.getOwnPropertyNames(obj)
        for (const f of props) {
            if (f !== 'constructor' && typeof (obj as ObjectByString)[f] === 'function') {
                const map = this.getNameSpaceMethodMap(name)
                map.set(f, (obj as BindObject)[f])
            }
        }
    }

    expose(methodName: string, method: () => void) {
        const map = this.getNameSpaceMethodMap(methodName)
        map.set(methodName, method)
    }
    async createRpcInstance(className: string, instanceName?: string, ...args: unknown[]) {
        let result: string = ''
        const con = this.exposedClasses[className]
        if (con) {
            const id = instanceName ? instanceName : uuidv4()
            const instance = new con(...args)
            this.createdInstances.set(id, instance as ObjectByString)
            this.exposeClassInstance(instance as object, id)
            result = id
        }
        return result
    }
}
