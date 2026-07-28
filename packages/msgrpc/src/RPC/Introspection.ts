import EventEmitter from 'events'
import { rpc, rpcNamespace } from './Expose.js'
import type { RpcServerHandler } from './RpcServerHandler.js'
import type { TypeNode } from './Schema.js'

/**
 * What a server can say about itself.
 *
 * Deliberately msgrpc's own shape rather than a borrowed one. OpenAPI is HTTP-shaped and has no
 * good way to describe a server pushing events; AsyncAPI models everything as a channel, which
 * fights an RPC surface. Both would mean describing this system in someone else's concepts to
 * satisfy a viewer we would then still want to replace.
 */

export interface DescribedMethod {
    name: string
    /** Present when a schema describes this method; absent when nothing does. */
    params?: TypeNode[]
    rest?: TypeNode
    returns?: TypeNode
}

export interface DescribedEvent {
    name: string
    params?: TypeNode[]
    /** How many peers currently hold a subscription to it. */
    subscribers: number
}

export interface DescribedNamespace {
    name: string
    version?: string
    /** Class the exposed instance came from, which is usually what a person is looking for. */
    className?: string
    /** True when the instance was created at runtime through createRpcInstance. */
    created: boolean
    /** True when the instance can emit events at all. */
    emitter: boolean
    methods: DescribedMethod[]
    events: DescribedEvent[]
}

export interface ServerDescription {
    /** Name this server is addressed by. */
    name: string
    /** Contract version of the schema as a whole, when one is loaded. */
    version?: string
    /** True when arguments are being checked, which tells a caller how much to trust the types. */
    validating: boolean
    namespaces: DescribedNamespace[]
    /** Named types the described methods refer to. */
    types?: { [name: string]: TypeNode }
}

/**
 * Exposed under the namespace `msgrpc` when RpcServer is constructed with exposeIntrospection.
 *
 * Off by default, and it goes through the ordinary dispatch path, so authorize() sees it as a call
 * on `msgrpc.describe` and can restrict it. Listing every class, method and live instance is
 * reconnaissance, and on a plant network instance names tend to encode plant structure.
 */
@rpcNamespace('msgrpc')
export class Introspection {
    constructor(private handler: RpcServerHandler) {}

    @rpc
    async describe(): Promise<ServerDescription> {
        const manage = this.handler.manageRpc
        const schema = this.handler.schema
        const created = new Set(manage.createdInstances.keys())

        const namespaces: DescribedNamespace[] = Object.entries(manage.exposedNameSpaceInstances).map(([name, instance]) => {
            const described = schema?.namespaces[name]
            const methodNames = [...(manage.findNameSpaceMethodMap(name)?.keys() ?? [])].sort()
            const methods: DescribedMethod[] = methodNames.map((method) => {
                const signature = described?.methods[method]
                return { name: method, ...(signature ? { params: signature.params, rest: signature.rest, returns: signature.returns } : {}) }
            })

            // Declared events plus any a peer is currently subscribed to, since a server without a
            // schema still knows what has been subscribed.
            const eventNames = new Set(Object.keys(described?.events ?? {}))
            for (const proxy of this.handler.eventProxies.values()) if (proxy.instanceName === name) eventNames.add(proxy.event)
            const events: DescribedEvent[] = [...eventNames].sort().map((event) => ({
                name: event,
                ...(described?.events?.[event] ? { params: described.events[event].params } : {}),
                subscribers: [...this.handler.eventProxies.values()].filter((proxy) => proxy.instanceName === name && proxy.event === event).length
            }))

            return {
                name,
                ...(described?.version ? { version: described.version } : {}),
                className: instance.constructor?.name,
                created: created.has(name),
                emitter: instance instanceof EventEmitter,
                methods,
                events
            }
        })

        return {
            name: this.handler.name,
            ...(schema?.version ? { version: schema.version } : {}),
            validating: !!schema && this.handler.validation !== 'off',
            namespaces: namespaces.sort((a, b) => a.name.localeCompare(b.name)),
            ...(schema?.types ? { types: schema.types } : {})
        }
    }
}
