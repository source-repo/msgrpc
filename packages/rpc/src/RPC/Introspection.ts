import EventEmitter from 'events'
import { rpc, rpcNamespace } from './Expose.js'
import type { RpcServerHandler } from './RpcServerHandler.js'
import type { MethodSchema, NamespaceSchema, RpcSchema, TypeNode } from './Schema.js'
import type { RpcMethodSemantics } from './Messages.js'
// Extracted from this file by `npm run contract` in the CLI package and committed, so building
// msgrpc never needs the extractor that reads it. A test there asserts it still matches this source.
import extracted from './Introspection.types.json' with { type: 'json' }

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
    /** Positionally matching `params`, when the schema carries them. */
    paramNames?: string[]
    rest?: TypeNode
    returns?: TypeNode
    /**
     * What calling it does to the world, when the method says: `query`, `idempotent-command` or
     * `non-repeatable-command`. Absent means it does not say, which a person reading a list of
     * methods should treat as "ask before pressing this".
     */
    semantics?: RpcMethodSemantics
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
    /** True when calls into this instance run one at a time rather than side by side. */
    serialised?: boolean
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
 * The schema format has one type map shared by every namespace, so a library adding types to a
 * user's schema has to stay out of their names - a plant defining its own `TypeNode` would
 * otherwise find describe() described against it. Everything here moves under a prefix that no
 * extracted type can collide with, since `.` is not part of an identifier.
 */
const PREFIX = 'msgrpc.'

const prefixRefs = (node: TypeNode): TypeNode => {
    switch (node.kind) {
        case 'ref':
            return { ...node, name: PREFIX + node.name }
        case 'array':
            return { ...node, items: prefixRefs(node.items) }
        case 'record':
            return { ...node, values: prefixRefs(node.values) }
        case 'tuple':
            return { ...node, items: node.items.map(prefixRefs) }
        case 'union':
            return { ...node, options: node.options.map(prefixRefs) }
        case 'object':
            return { ...node, fields: Object.fromEntries(Object.entries(node.fields).map(([name, field]) => [name, { ...field, type: prefixRefs(field.type) }])) }
        default:
            return node
    }
}

const prefixMethod = (method: MethodSchema): MethodSchema => ({
    ...method,
    params: method.params.map(prefixRefs),
    ...(method.rest ? { rest: prefixRefs(method.rest) } : {}),
    ...(method.returns ? { returns: prefixRefs(method.returns) } : {})
})

const source = extracted as RpcSchema

/** What this namespace offers, ready to merge into whatever schema a server was given. */
export const introspectionSchema: { namespace: NamespaceSchema; types: { [name: string]: TypeNode } } = {
    namespace: {
        ...source.namespaces.msgrpc,
        methods: Object.fromEntries(Object.entries(source.namespaces.msgrpc.methods).map(([name, method]) => [name, prefixMethod(method)])),
        ...(source.namespaces.msgrpc.events
            ? { events: Object.fromEntries(Object.entries(source.namespaces.msgrpc.events).map(([name, event]) => [name, { params: event.params.map(prefixRefs) }])) }
            : {})
    },
    types: Object.fromEntries(Object.entries(source.types ?? {}).map(([name, type]) => [PREFIX + name, prefixRefs(type)]))
}

/**
 * Adds the `msgrpc` namespace to a server's schema, so describe() is described like anything else -
 * and so `validation: 'required'` does not refuse the one call a peer makes to find out what is
 * here, which it did before this existed.
 *
 * A server given no schema still gets this one. That does not turn checking on: validation defaults
 * from the schema the *caller* passed, so an undescribed server stays undescribed and only reports
 * its own introspection honestly.
 *
 * A user schema already defining `msgrpc` wins untouched. It is the contract that server actually
 * serves, and overwriting it would describe the server as something it is not.
 */
export const withIntrospection = (schema: RpcSchema | undefined): RpcSchema => {
    if (schema?.namespaces.msgrpc) return schema
    return {
        schema: 1,
        ...schema,
        types: { ...schema?.types, ...introspectionSchema.types },
        namespaces: { ...schema?.namespaces, msgrpc: introspectionSchema.namespace }
    }
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
                const semantics = this.handler.semanticsOf({ path: name, method })
                return {
                    name: method,
                    ...(signature ? { params: signature.params, paramNames: signature.paramNames, rest: signature.rest, returns: signature.returns } : {}),
                    ...(semantics ? { semantics } : {})
                }
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

            const execution = manage.exposedExecution[name]
            return {
                name,
                ...(described?.version ? { version: described.version } : {}),
                // Worth reporting because it changes what a caller should expect: on a serialised
                // instance a slow method delays every other call into it, and that is a property of
                // the server rather than of the network.
                ...(execution && execution !== 'parallel' ? { serialised: true } : {}),
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
