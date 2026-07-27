import { MessageModule, Message, MessageType, GenericModule } from './Core.js'
import { isEventFunction } from './Rpc.js'
import {
    RpcErrorPayload,
    RpcEventPayload,
    RpcErrorCode,
    RpcCallInstanceMethodPayload,
    RpcMessage,
    RpcSuccessPayload,
    RpcMessageType
} from './RpcServerHandler.js'
import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'

export const defaultCallTimeout = 10000

export class RpcError extends Error {
    constructor(
        public code: RpcErrorCode,
        message?: string,
        /** Stack trace from the remote peer, when it sent one. */
        public remoteStack?: string
    ) {
        super(message ? `${code}: ${message}` : code)
        this.name = 'RpcError'
    }
}

export interface RpcClientEmitter extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> {
    on(event: string, handler: (_event: string, params: unknown[]) => void): this
    emit(event: string, params: unknown[]): boolean
    removeListener(event: string, handler: (params: unknown[]) => void): this
}

function isSuccessResponse(payload: RpcMessage): payload is RpcSuccessPayload {
    return payload.type === RpcMessageType.success
}

function isEventMessage(payload: RpcMessage): payload is RpcEventPayload {
    return payload.type === RpcMessageType.event
}

function isErrorResponse(payload: RpcMessage): payload is RpcErrorPayload {
    return payload.type === RpcMessageType.error
}

export type PromiseResolver<T> = { resolve: (result: T) => void; reject: (reason?: unknown) => void }

export class RpcClientHandler extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> implements RpcClientEmitter {
    responsePromiseMap = new Map<string, PromiseResolver<unknown>>()
    responseTimeoutMap = new Map<string, NodeJS.Timeout>()
    /** Remote subscriptions held by this client, replayed by resubscribe() after a reconnect. */
    subscriptions = new Map<string, { remote?: string; instanceName: string; event: string }>()
    eventEmitter: { [index: string]: unknown } = new EventEmitter() as unknown as { [index: string]: unknown }
    constructor(
        name: string,
        sources?: GenericModule<unknown, unknown, Message, RpcMessage>[],
        public callTimeout = defaultCallTimeout
    ) {
        super(name, sources)
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override async receive(message: Message<RpcMessage>, source?: string, target?: string) {
        const payload = message.payload
        if (!payload) return
        if (isEventMessage(payload)) {
            if (this.eventEmitter instanceof EventEmitter) this.eventEmitter.emit(payload.event, ...payload.params)
            this.emit(payload.event, payload.params)
            return
        }
        if (isSuccessResponse(payload)) {
            this.takePending(payload.id)?.resolve(payload.result)
            return
        }
        if (isErrorResponse(payload)) {
            // Requires payload.id. A peer older than this fix sends errors without one, in which
            // case the call can only be settled by its timeout.
            this.takePending(payload.id)?.reject(new RpcError(payload.code, payload.error?.message, payload.error?.stack))
        }
    }

    /**
     * Re-issue every remote subscription this client holds. Called after the transport reconnects:
     * if the server kept its state the calls are no-ops on its side, and if the server restarted
     * they rebuild it. Either way the outgoing frames re-identify this client to the server, which
     * is what makes server-pushed events addressable again.
     */
    async resubscribe() {
        const results = await Promise.allSettled(
            [...this.subscriptions.values()].map((subscription) => this.call(subscription.remote, subscription.instanceName, 'on', subscription.event))
        )
        const failed = results.filter((result) => result.status === 'rejected').length
        if (failed) this.emit('resubscribeFailed', failed)
        return results.length - failed
    }

    /**
     * Reject every in-flight call. A reply to a call that was in flight when the link dropped can
     * no longer reach us, so failing now beats making every caller wait out the full timeout.
     */
    failPendingCalls(reason: string) {
        for (const id of [...this.responsePromiseMap.keys()]) this.takePending(id)?.reject(new RpcError('TransportError', reason))
    }

    /** Detach a pending call and cancel its timeout. Returns undefined if it already settled. */
    private takePending(id: string | undefined) {
        if (id === undefined) return undefined
        const promise = this.responsePromiseMap.get(id)
        this.responsePromiseMap.delete(id)
        const timeout = this.responseTimeoutMap.get(id)
        if (timeout !== undefined) {
            clearTimeout(timeout)
            this.responseTimeoutMap.delete(id)
        }
        return promise
    }

    /**
     * Call a method on the RPC server.
     * @param method The method to call.
     * @param additionalParameter The (optional) additionalParameter to include. See the JsonRpc class for more details.
     * @param params
     */
    public call(remote: string | undefined, instanceName: string, method: string, ...params: unknown[]): Promise<unknown> {
        const payload: RpcCallInstanceMethodPayload = {
            id: uuidv4(),
            type: RpcMessageType.CallInstanceMethod,
            path: instanceName,
            method,
            params
        }
        return new Promise((resolve, reject) => {
            // Registered before sending: a response can arrive before sendPayload's promise settles.
            this.responsePromiseMap.set(payload.id, { resolve, reject })
            this.responseTimeoutMap.set(
                payload.id,
                setTimeout(() => {
                    this.takePending(payload.id)?.reject(new RpcError('Timeout', `no response to ${instanceName}.${method} within ${this.callTimeout} ms`))
                }, this.callTimeout)
            )
            this.sendPayload(payload, MessageType.RequestMessage, this.name, remote).catch((e) => {
                this.takePending(payload.id)?.reject(new RpcError('TransportError', e instanceof Error ? e.message : String(e)))
            })
        })
    }

    /**
     * Create a proxy object - a sort of wrapper for calling methods and listening for events.
     * @param name Name of an existing instance on the server instance. If in the form "name: Class" an instance of type Class will be created
     * on the server if it does not already exist.
     */
    proxy<T>(name: string, remote?: string) {
        const proxyObj: { [index: string]: unknown } = {}
        return new Proxy(proxyObj, {
            get: (target, prop) => {
                let result: unknown
                if (typeof prop === 'string') {
                    if (target[prop]) {
                        return target[prop]
                    } else if (isEventFunction(prop)) {
                        target[prop] = (...args: unknown[]) => {
                            ;(this.eventEmitter[prop] as (...args: unknown[]) => void)(...args)
                            // 'on' is the only form the server holds state for, so it is the only
                            // one worth replaying after a reconnect.
                            if (typeof args[0] === 'string') {
                                const key = `${remote ?? ''} ${name} ${args[0]}`
                                if (prop === 'on') this.subscriptions.set(key, { remote, instanceName: name, event: args[0] })
                                else if (prop === 'off' || prop === 'removeListener') this.subscriptions.delete(key)
                            }
                            return this.call(remote, name, prop, args[0])
                        }
                    } else {
                        target[prop] = (...args: unknown[]) => this.call(remote, name, prop as string, ...args)
                    }
                    result = target[prop]
                }
                return result
            }
        }) as T
    }
}
