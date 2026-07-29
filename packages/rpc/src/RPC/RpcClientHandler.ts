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

/**
 * Identifies one subscription: which peer, which exposed instance, which event.
 *
 * Handlers used to be registered under the bare event name, so a client watching `alarm` on two
 * namespaces - or on two peers over one MQTT transport - delivered each event to all of them. An
 * empty source matches any peer, for a proxy created without a target.
 */
export const subscriptionKey = (source: string, namespace: string, event: string) => `${source}\u0000${namespace}\u0000${event}`

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
    /** Contract versions this client was built against, by namespace, declared on each call. */
    schemaVersions?: { [namespace: string]: string | undefined }
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
            this.deliverEvent(payload, source)
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
     * Routes an event to the handlers registered for that peer and that instance, rather than to
     * everything listening for the name.
     */
    private deliverEvent(payload: RpcEventPayload, source?: string) {
        // Held in a local so the narrowing survives into the delivery callbacks below.
        const emitter = this.eventEmitter
        if (emitter instanceof EventEmitter) {
            const from = source ?? ''
            const keys = payload.path
                ? [subscriptionKey(from, payload.path, payload.event), subscriptionKey('', payload.path, payload.event)]
                : // A peer that does not name the emitting instance: deliver to every subscription
                  // for this event whose peer matches, whatever namespace it was taken out on.
                  emitter
                      .eventNames()
                      .filter((name): name is string => typeof name === 'string')
                      .filter((name) => {
                          const [keySource, , keyEvent] = name.split('\u0000')
                          return keyEvent === payload.event && (keySource === from || keySource === '')
                      })
            for (const key of new Set(keys)) this.deliverSafely(() => emitter.emit(key, ...payload.params), payload)
        }
        // The handler's own emitter stays keyed by name: it is a firehose of everything this client
        // receives, and its consumers read the path off the payload.
        this.deliverSafely(() => this.emit(payload.event, payload.params), payload)
    }

    /**
     * Run one subscriber without letting it unwind into the transport that delivered the event.
     *
     * These are application callbacks reached from a transport's inbound loop, so a handler that
     * threw propagated all the way back out and became an unhandled rejection - one subscriber's
     * bug ending the process for everything else the client was doing.
     */
    private deliverSafely(deliver: () => void, payload: RpcEventPayload) {
        try {
            deliver()
        } catch (e) {
            this.emit('subscriberError', { event: payload.event, path: payload.path, error: e })
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
            params,
            version: this.schemaVersions?.[instanceName],
            // The same number that arms the timer below, so what the far end is told is exactly
            // what this caller is going to do. A request carrying no ttl is one with no deadline,
            // which is what a caller that has disabled its own timeout is asking for.
            ttl: this.callTimeout > 0 ? this.callTimeout : undefined
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
                            const event = args[0]
                            if (typeof event === 'string') {
                                // Registered against this peer and this namespace, so a name shared
                                // with another instance does not deliver to both.
                                const key = subscriptionKey(remote ?? '', name, event)
                                ;(this.eventEmitter[prop] as (...args: unknown[]) => void)(key, ...args.slice(1))
                                // 'on' is the only form the server holds state for, so it is the
                                // only one worth replaying after a reconnect.
                                if (prop === 'on') this.subscriptions.set(key, { remote, instanceName: name, event })
                                else if (prop === 'off' || prop === 'removeListener') this.subscriptions.delete(key)
                            } else {
                                // removeAllListeners, setMaxListeners and friends take no event.
                                ;(this.eventEmitter[prop] as (...args: unknown[]) => void)(...args)
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
