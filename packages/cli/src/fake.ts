import { EventEmitter } from 'events'
import { RpcServer, type NamespaceSchema, type RpcSchema, type TypeNode } from '@source-repo/rpc'
import { networkTransports, type NetworkOptions } from './network.js'
import { javascriptRuntime, pythonRuntime, type HandlerRuntime } from './handlers.js'

/**
 * A peer built from a contract rather than from code: it answers every method the contract declares
 * with a value of the declared shape, and refuses a call the contract would refuse.
 *
 * The point is to have something to develop against. An HMI cannot be worked on without the plant
 * it talks to, a console cannot be exercised without a peer to select, and a test that needs a
 * device which times out or throws needs a device willing to do that on request - which a real one
 * is not. The contract is already extracted and committed for the deployed peer, so standing a
 * stand-in up from it costs nothing and cannot drift: `source-rpc check` fails the build if it does.
 *
 * Generated values are deterministic. A fake whose readings wander is nicer to look at and useless
 * to assert on, and `--script` is there for when a particular answer is what the test needs.
 */

/** Canned answers, deliberate failures and events on a timer. All optional. */
export interface FakeScript {
    /** `plant.read` -> the value to answer with, instead of one generated from the contract. */
    returns?: { [target: string]: unknown }
    /**
     * `plant.writeSetpoint` -> an RPC error code to answer with: Exception, Unauthorized,
     * InvalidParams, and so on. `Timeout` is the special one - the call is never answered at all,
     * which is the failure an HMI handles worst and can otherwise only be staged by pulling a cable.
     */
    fails?: { [target: string]: string }
    /** Events to emit on a timer, for the receiving end of an HMI that has nothing to receive. */
    emits?: { event: string; every: number; params?: unknown[] }[]
    /**
     * Starting values for `state`, which the handlers below share and keep between calls.
     *
     * This is what makes a fake a simulator rather than a recording: a pump that ramps toward the
     * setpoint it was last given cannot be expressed by `returns`, because the answer depends on
     * what was called before it.
     */
    state?: { [key: string]: unknown }
    /**
     * `plant.read` -> a JavaScript function, as source. It is called with the arguments the caller
     * sent and shares the mutable `state` above.
     *
     * Needs `--allow-exec`: this is the script author's code running in this process. See handlers.ts.
     */
    handlers?: { [target: string]: string }
    /**
     * A Python program answering calls, for a simulation with more arithmetic in it than a
     * JavaScript one-liner wants to carry. Decorate functions with `@rpc('plant.read')`; the
     * interpreter is started once and keeps its own state.
     *
     * Needs `--allow-exec`, and a `python3` on PATH.
     */
    python?: { program: string; targets: string[]; interpreter?: string }
}

export interface FakeOptions extends NetworkOptions {
    /** The contract to serve. Every namespace in it is exposed. */
    schema: RpcSchema
    script?: FakeScript
    /**
     * Permit `handlers` and `python`, which run code the script supplied. Off by default, and the
     * container ships without it: the flag is the security boundary, so it has to be given
     * deliberately rather than inherited from a config file somebody copied.
     */
    allowExec?: boolean
}

/** What a script asks for that only `--allow-exec` grants. Empty when it asks for neither. */
export const execUsedBy = (script?: FakeScript) =>
    [...(script?.handlers && Object.keys(script.handlers).length ? ['handlers'] : []), ...(script?.python ? ['python'] : [])]

/** Whether something handed over as a contract is one, so the wrong object is refused kindly. */
export const looksLikeSchema = (value: unknown): value is RpcSchema =>
    !!value && typeof value === 'object' && !!(value as RpcSchema).namespaces && typeof (value as RpcSchema).namespaces === 'object'

/** The code that means "never answer" rather than "answer with this error". */
const NEVER_ANSWERS = 'Timeout'

/**
 * How deep a generated value goes before it stops. A recursive type - the schema's own TypeNode is
 * one - would otherwise descend forever, and a sample twenty levels down says nothing a sample two
 * levels down does not.
 */
const MAX_DEPTH = 6

const SAMPLE_TEXT = 'sample'

/**
 * A value of the declared shape.
 *
 * Bounds are honoured where the type language carries them, because a fake that answers 3000 where
 * the contract says 0..2000 would be refused by the very validator this exists to exercise. What it
 * cannot honour is `pattern`: satisfying an arbitrary regular expression is a different problem, so
 * a constrained string comes back as the placeholder and is documented as such.
 */
export const sampleFor = (type: TypeNode | undefined, types: RpcSchema['types'], seen: Set<string> = new Set(), depth = 0): unknown => {
    if (!type || depth > MAX_DEPTH) return null
    switch (type.kind) {
        case 'any':
        case 'null':
            return null
        case 'boolean':
            return true
        case 'number': {
            // Inside the declared range, and the low end of it when only one side is given: a
            // setpoint that starts at its maximum is a surprising thing for a fake to assert.
            if (type.min !== undefined && type.max !== undefined) {
                const middle = (type.min + type.max) / 2
                return type.integer ? Math.round(middle) : middle
            }
            const value = type.min ?? (type.max !== undefined ? Math.min(0, type.max) : 0)
            return type.integer ? Math.round(value) : value
        }
        case 'string': {
            let text = SAMPLE_TEXT
            if (type.minLength !== undefined && text.length < type.minLength) text = text.padEnd(type.minLength, 'x')
            if (type.maxLength !== undefined && text.length > type.maxLength) text = text.slice(0, type.maxLength)
            return text
        }
        case 'bytes':
            return Uint8Array.from([0x00, 0x01, 0x02, 0x03].slice(0, type.maxBytes ?? 4))
        case 'date':
            // The one value that is not fixed. A device reporting the epoch reads as a broken clock.
            return new Date()
        case 'literal':
            return type.value
        case 'array':
            return type.maxItems === 0 ? [] : [sampleFor(type.items, types, seen, depth + 1)]
        case 'tuple':
            return type.items.map((item) => sampleFor(item, types, seen, depth + 1))
        case 'object':
            // Required fields only, the same rule the console's argument forms use when they
            // pre-fill a shape: an optional field is optional, and inventing one is not more honest.
            return Object.fromEntries(
                Object.entries(type.fields)
                    .filter(([, field]) => !field.optional)
                    .map(([name, field]) => [name, sampleFor(field.type, types, seen, depth + 1)])
            )
        case 'record':
            // A key pattern cannot be satisfied in general, and an empty dictionary is a valid one.
            if (type.keyPattern || type.maxEntries === 0) return {}
            return { [SAMPLE_TEXT]: sampleFor(type.values, types, seen, depth + 1) }
        case 'union': {
            // The first option that is not the null half of an optional: `mode?: 'auto' | 'manual'`
            // should come back as 'auto' rather than as nothing at all.
            const options = type.options.filter((option) => !(option.kind === 'literal' && option.value === null))
            return sampleFor(options[0] ?? type.options[0], types, seen, depth + 1)
        }
        case 'ref': {
            // Broken on the way back round: a type that contains itself has no finite sample.
            if (seen.has(type.name)) return null
            const resolved = types?.[type.name]
            return sampleFor(resolved, types, new Set([...seen, type.name]), depth + 1)
        }
        default:
            return null
    }
}

/**
 * One namespace as an object whose own properties are its methods.
 *
 * An EventEmitter, because the RPC layer only accepts a subscription to an instance that is one,
 * and the methods are own properties because that is what `exposeObject` publishes - a plain
 * object's methods are invisible to `exposeClassInstance`, which reads the prototype chain.
 */
class Fake extends EventEmitter {}

const buildNamespace = (name: string, namespace: NamespaceSchema, types: RpcSchema['types'], script?: FakeScript, runtimes: HandlerRuntime[] = []) => {
    // Named, so a console describing this peer says `Fake` where a real one names its class. That
    // line is the only place the browser says out loud that it is not talking to a device.
    const instance = new Fake() as Fake & { [method: string]: unknown }
    for (const [method, described] of Object.entries(namespace.methods)) {
        const target = `${name}.${method}`
        // The arguments are taken now, where before they were ignored: a handler is only worth
        // having if it can see what it was called with.
        instance[method] = async (...params: unknown[]) => {
            const failure = script?.fails?.[target]
            // Never answered rather than answered with a timeout: a caller has to see the call go
            // unanswered for its own timeout to be what fires, which is the behaviour being staged.
            if (failure === NEVER_ANSWERS) return await new Promise(() => {})
            if (failure) throw Object.assign(new Error(`${target} is set to fail`), { code: failure })
            // Before `returns`, because a handler is the more specific instruction: a script that
            // carries both means the canned value for everything the handler does not answer.
            const runtime = runtimes.find((candidate) => candidate.handles(target))
            if (runtime) return await runtime.call(target, params)
            if (script?.returns && target in script.returns) return script.returns[target]
            return sampleFor(described.returns, types)
        }
    }
    return instance
}

export const startFake = async (options: FakeOptions) => {
    const namespaces = Object.entries(options.schema.namespaces).filter(([name]) => name !== 'msgrpc')
    if (!namespaces.length) throw new Error('startFake: the contract describes no namespaces to serve')

    // Refused here rather than ignored. A script whose handlers were silently dropped would serve
    // generated values that look plausible and answer nothing the simulation was written to answer,
    // which is worse than not starting.
    const wantsExec = execUsedBy(options.script)
    if (wantsExec.length && !options.allowExec)
        throw new Error(`startFake: this script uses ${wantsExec.join(' and ')}, which run code it supplied. Pass --allow-exec to permit that; it is off by default and not enabled in the container.`)

    const runtimes: HandlerRuntime[] = []
    if (options.allowExec && options.script?.handlers && Object.keys(options.script.handlers).length)
        runtimes.push(javascriptRuntime(options.script.handlers, options.script.state ?? {}))
    if (options.allowExec && options.script?.python)
        runtimes.push(
            await pythonRuntime(options.script.python.program, options.script.python.targets, options.script.python.interpreter)
        )

    // Built here rather than through connectNetwork, which makes a window onto the network; this
    // one is a peer that serves. The schema is handed over so the fake refuses exactly what the real
    // peer would - a stand-in that accepts calls the device rejects teaches the wrong lesson.
    const network = new RpcServer({
        name: options.name,
        callTimeout: options.callTimeout,
        readyTimeout: 15000,
        schema: options.schema,
        exposeIntrospection: true,
        transports: networkTransports(options)
    })

    const instances = new Map<string, EventEmitter>()
    for (const [name, namespace] of namespaces) {
        const instance = buildNamespace(name, namespace, options.schema.types, options.script, runtimes)
        network.exposeObject(instance, name)
        instances.set(name, instance)
    }
    await network.ready()

    // Emitted on a timer, with parameters of the declared shape unless the script supplies them.
    const timers = (options.script?.emits ?? []).map((emit) => {
        const dot = emit.event.lastIndexOf('.')
        const namespace = dot > 0 ? emit.event.slice(0, dot) : ''
        const event = dot > 0 ? emit.event.slice(dot + 1) : emit.event
        const instance = instances.get(namespace)
        if (!instance) throw new Error(`startFake: nothing called '${namespace}' to emit ${emit.event} from`)
        const declared = options.schema.namespaces[namespace]?.events?.[event]
        const params = emit.params ?? (declared?.params ?? []).map((type) => sampleFor(type, options.schema.types))
        // Unref'd: a fake with an emitter should not be the reason a process refuses to exit.
        return setInterval(() => instance.emit(event, ...params), Math.max(emit.every, 50)).unref()
    })

    return {
        network,
        namespaces: namespaces.map(([name]) => name),
        close: async () => {
            for (const timer of timers) clearInterval(timer)
            for (const runtime of runtimes) await runtime.close()
            await network.close()
        }
    }
}
