import type { DescribedMethod, ServerDescription, TypeNode } from '@source-repo/rpc'
import { awaitPeer, connectNetwork, type ConnectedNetwork, type NetworkOptions } from './network.js'

/**
 * The console's verbs without the browser: `peers`, `describe`, `call` and `watch`, one shot each,
 * with an exit code.
 *
 * Everything the network could be asked was reachable only through the console (which needs a
 * browser) or the MCP server (which needs a model), so a shell script and a CI job had nothing.
 * These are the same five verbs `ConsoleService` exposes, minus the HTTP server, plus the two
 * things a command line needs and an RPC service does not: an exit status, and output that survives
 * a pipe.
 *
 * `--json` on every verb, because the human rendering is for reading and the JSON is for `jq`, and
 * guessing which one is wanted from whether stdout is a tty is the kind of cleverness that breaks
 * in CI.
 */

/** Where a verb writes. Injected so tests can read what a command printed. */
export interface Output {
    out: (text: string) => void
    err: (text: string) => void
}

export const processOutput: Output = {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text)
}

export interface VerbOptions extends NetworkOptions {
    json: boolean
    /** How long to wait for a peer to appear before giving up on it. */
    wait: number
}

const failureText = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    return error?.code ? `${error.code}: ${error.message ?? ''}`.trim() : e instanceof Error ? e.message : String(e)
}

/** Resolves a `ref` so a caller does not have to care whether a type was named. */
const resolveType = (type: TypeNode | undefined, types: ServerDescription['types']): TypeNode | undefined =>
    type?.kind === 'ref' ? resolveType(types?.[type.name], types) : type

/** A parameter is optional when its type admits null, which is how the extractor writes `mode?`. */
const isOptional = (type: TypeNode | undefined) =>
    type?.kind === 'any' || (type?.kind === 'union' && type.options.some((option) => option.kind === 'literal' && option.value === null))

/** The type to convert against, with the optional-ness stripped off. */
const requiredPart = (type: TypeNode | undefined): TypeNode | undefined => {
    if (type?.kind !== 'union') return type
    const options = type.options.filter((option) => !(option.kind === 'literal' && option.value === null))
    return options.length === 1 ? options[0] : { ...type, options }
}

/** How a type reads when written out, which is what a signature line should show. */
export const typeText = (type: TypeNode | undefined): string => {
    if (!type) return 'unknown'
    switch (type.kind) {
        case 'literal':
            return JSON.stringify(type.value)
        case 'array':
            return `${typeText(type.items)}[]`
        case 'tuple':
            return `[${type.items.map(typeText).join(', ')}]`
        case 'union':
            return type.options.map(typeText).join(' | ')
        case 'ref':
            return type.name
        case 'object':
            return `{ ${Object.entries(type.fields)
                .map(([name, field]) => `${name}${field.optional ? '?' : ''}: ${typeText(field.type)}`)
                .join(', ')} }`
        case 'record':
            return `{ [key: string]: ${typeText(type.values)} }`
        case 'number':
            return type.min !== undefined || type.max !== undefined ? `number(${type.min ?? ''}..${type.max ?? ''})` : 'number'
        default:
            return type.kind
    }
}

export const signatureOf = (method: DescribedMethod) => {
    if (!method.params) return `${method.name}(…)`
    const names = method.paramNames ?? method.params.map((_, index) => `argument ${index}`)
    const parameters = method.params.map((type, index) => `${names[index]}${isOptional(type) ? '?' : ''}: ${typeText(requiredPart(type))}`)
    return `${method.name}(${parameters.join(', ')})${method.returns ? `: ${typeText(method.returns)}` : ''}`
}

/**
 * Turns one command-line word into the value the contract asks for.
 *
 * A shell has only strings, so without this `source-rpc call plant plant.writeSetpoint 1200` sends
 * "1200" and comes back `InvalidParams: expected number, got string` - technically correct and
 * useless. The peer's own contract says what argument 0 is, so it decides.
 *
 * Where there is no contract the rule is JSON-if-it-parses, else the literal text: `42` is a
 * number, `{"a":1}` is an object, and `hello` is a string rather than a syntax error.
 */
export const coerceArgument = (text: string, declared: TypeNode | undefined, types: ServerDescription['types']): unknown => {
    const type = resolveType(requiredPart(declared), types)
    if (!type) return looseValue(text)
    switch (type.kind) {
        case 'string':
            return text
        case 'number': {
            const value = Number(text)
            if (!Number.isFinite(value)) throw new Error(`expected a number, got '${text}'`)
            return value
        }
        case 'boolean':
            if (text === 'true' || text === '1') return true
            if (text === 'false' || text === '0') return false
            throw new Error(`expected true or false, got '${text}'`)
        case 'date': {
            const value = new Date(text)
            if (Number.isNaN(value.getTime())) throw new Error(`expected a date, got '${text}'`)
            return value
        }
        case 'bytes': {
            const hex = text.startsWith('0x') ? text.slice(2) : text
            if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new Error(`expected hex bytes, got '${text}'`)
            return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
        }
        case 'literal':
            // A union of literals is a fixed set of words, so matching the text against them beats
            // JSON-parsing it: 'auto' is the value, not a string that happens to look like one.
            return typeof type.value === 'string' && text === type.value ? type.value : looseValue(text)
        case 'union': {
            const literal = type.options.find((option) => option.kind === 'literal' && String(option.value) === text)
            if (literal) return (literal as { value: unknown }).value
            return looseValue(text)
        }
        case 'any':
            return looseValue(text)
        default:
            // object, array, tuple, record: nothing but JSON will do, and a failure here is worth
            // naming, since the alternative is sending the brace-laden text as a string.
            try {
                return JSON.parse(text)
            } catch {
                throw new Error(`expected ${typeText(type)} as JSON, got '${text}'`)
            }
    }
}

const looseValue = (text: string): unknown => {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

/** Coerces a whole argument list, naming the argument that would not convert. */
export const coerceArguments = (texts: string[], method: DescribedMethod | undefined, types: ServerDescription['types']) => {
    const names = method?.paramNames
    return texts.map((text, index) => {
        try {
            return coerceArgument(text, method?.params?.[index], types)
        } catch (e) {
            throw new Error(`argument ${index}${names?.[index] ? ` (${names[index]})` : ''}: ${(e as Error).message}`, { cause: e })
        }
    })
}

/** `plant.writeSetpoint` - one word, because two positional arguments here read as one thing. */
const splitTarget = (target: string) => {
    const dot = target.lastIndexOf('.')
    if (dot <= 0 || dot === target.length - 1) return undefined
    return { namespace: target.slice(0, dot), member: target.slice(dot + 1) }
}

const describePeer = async (connected: ConnectedNetwork, peer: string) => {
    const proxy = await connected.network.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', peer)
    return await proxy.remote!.describe()
}

/**
 * Runs a verb against a network and closes it again, whatever happened.
 *
 * Every verb is one shot, so the link is opened for the length of one answer. The exception is
 * `watch`, which hands back a promise that settles on Ctrl-C.
 */
const withNetwork = async (options: VerbOptions, io: Output, body: (connected: ConnectedNetwork) => Promise<number>) => {
    let connected: ConnectedNetwork
    try {
        connected = await connectNetwork(options)
    } catch (e) {
        io.err(`source-rpc: cannot join the network: ${failureText(e)}\n`)
        return 1
    }
    try {
        return await body(connected)
    } catch (e) {
        io.err(`source-rpc: ${failureText(e)}\n`)
        return 1
    } finally {
        await connected.close().catch(() => undefined)
    }
}

/** A peer that never appeared, said once and the same way everywhere. */
const missing = (peer: string, options: VerbOptions, io: Output) => {
    io.err(`source-rpc: ${peer} did not appear within ${options.wait} ms. Run 'source-rpc peers' to see who is there.\n`)
    return 1
}

export const runPeers = (options: VerbOptions, io: Output = processOutput) =>
    withNetwork(options, io, async (connected) => {
        // Presence is retained, so most of the list is already here - but it arrives just after the
        // subscription does, and a command that read the set immediately would sometimes print
        // nothing on a network that was plainly up.
        await new Promise((resolve) => setTimeout(resolve, Math.min(options.wait, 1000)))
        const peers = [...connected.online].sort()
        if (options.json) io.out(JSON.stringify({ peers }, null, 2) + '\n')
        else if (peers.length === 0) io.err('source-rpc: no peers announced themselves.\n')
        else io.out(peers.map((peer) => peer + '\n').join(''))
        return 0
    })

export const runDescribe = (peer: string, options: VerbOptions, io: Output = processOutput) =>
    withNetwork(options, io, async (connected) => {
        if (!(await awaitPeer(connected, peer, options.wait))) return missing(peer, options, io)
        let description: ServerDescription
        try {
            description = await describePeer(connected, peer)
        } catch (e) {
            // An answer about the peer, not a broken command: a server started without
            // exposeIntrospection is a fact worth reporting plainly.
            io.err(`source-rpc: ${peer} could not be described: ${failureText(e)}\n`)
            return 1
        }
        if (options.json) {
            io.out(JSON.stringify(description, null, 2) + '\n')
            return 0
        }
        io.out(`${description.name}${description.version ? ` (contract ${description.version})` : ''} — arguments ${description.validating ? 'checked' : 'not checked'}\n`)
        for (const namespace of description.namespaces) {
            io.out(`\n${namespace.name}${namespace.version ? `@${namespace.version}` : ''}${namespace.className ? `  ${namespace.className}` : ''}${namespace.created ? ' (created at runtime)' : ''}\n`)
            for (const method of namespace.methods) io.out(`  ${signatureOf(method)}\n`)
            for (const event of namespace.events)
                io.out(`  event ${event.name}(${event.params ? event.params.map(typeText).join(', ') : '…'})  ${event.subscribers} subscriber${event.subscribers === 1 ? '' : 's'}\n`)
        }
        return 0
    })

export const runCall = (peer: string, target: string, argumentTexts: string[], options: VerbOptions & { rawArgs?: string }, io: Output = processOutput) =>
    withNetwork(options, io, async (connected) => {
        const split = splitTarget(target)
        if (!split) {
            io.err(`source-rpc: '${target}' should be <namespace>.<method>, e.g. plant.writeSetpoint\n`)
            return 1
        }
        if (!(await awaitPeer(connected, peer, options.wait))) return missing(peer, options, io)

        let args: unknown[]
        if (options.rawArgs !== undefined) {
            // The escape hatch, for a call the contract cannot describe or a value the shell would
            // mangle. Whatever is in here is sent as it parses.
            let parsed: unknown
            try {
                parsed = JSON.parse(options.rawArgs)
            } catch (e) {
                io.err(`source-rpc: --args is not JSON: ${(e as Error).message}\n`)
                return 1
            }
            if (!Array.isArray(parsed)) {
                io.err('source-rpc: --args must be a JSON array of positional arguments\n')
                return 1
            }
            args = parsed
        } else {
            // Described first, so the contract decides what each word means. A peer with no
            // introspection is not an error here - it just means the loose rule applies.
            const description = await describePeer(connected, peer).catch(() => undefined)
            const method = description?.namespaces.find((namespace) => namespace.name === split.namespace)?.methods.find((entry) => entry.name === split.member)
            try {
                args = coerceArguments(argumentTexts, method, description?.types)
            } catch (e) {
                io.err(`source-rpc: ${(e as Error).message}\n`)
                return 1
            }
        }

        const started = Date.now()
        try {
            const proxy = await connected.network.proxy<{ [method: string]: (...a: unknown[]) => Promise<unknown> }>(split.namespace, peer)
            const result = await proxy.remote![split.member](...args)
            const ms = Date.now() - started
            if (options.json) io.out(JSON.stringify({ result, ms }, null, 2) + '\n')
            else {
                // The result on stdout and the timing on stderr, so piping into jq gets the value
                // and nothing else while a person still sees what it cost.
                io.out((result === undefined ? '' : JSON.stringify(result, null, 2)) + '\n')
                io.err(`${ms} ms\n`)
            }
            return 0
        } catch (e) {
            const failure = e as { code?: string; message?: string }
            if (options.json) io.out(JSON.stringify({ error: failure.message ?? String(e), code: failure.code, ms: Date.now() - started }, null, 2) + '\n')
            else io.err(`source-rpc: ${peer}.${target} failed: ${failureText(e)}\n`)
            // A refused call is a failed command. That is the whole point of running this in CI.
            return 1
        }
    })

/**
 * Streams one event as one line of JSON until the caller stops it.
 *
 * jsonl rather than the human rendering the other verbs get: this is the verb whose output is most
 * likely to be piped somewhere, and a stream that is pleasant to read is a stream nothing can parse.
 */
export const runWatch = (
    peer: string,
    target: string,
    options: VerbOptions,
    io: Output = processOutput,
    /** Resolves to stop watching. Ctrl-C on a command line; a promise the test controls in a test. */
    until: Promise<void> = new Promise(() => {})
) =>
    withNetwork(options, io, async (connected) => {
        const split = splitTarget(target)
        if (!split) {
            io.err(`source-rpc: '${target}' should be <namespace>.<event>, e.g. plant.alarm\n`)
            return 1
        }
        if (!(await awaitPeer(connected, peer, options.wait))) return missing(peer, options, io)

        type Subscribable = { on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>; off: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown> }
        const handler = (...args: unknown[]) => io.out(JSON.stringify({ at: Date.now(), peer, namespace: split.namespace, event: split.member, args }) + '\n')
        let proxy
        try {
            proxy = await connected.network.proxy<Subscribable>(split.namespace, peer)
            await proxy.remote!.on(split.member, handler)
        } catch (e) {
            io.err(`source-rpc: cannot watch ${peer}.${target}: ${failureText(e)}\n`)
            return 1
        }
        io.err(`source-rpc: watching ${peer}.${target}. Ctrl-C to stop.\n`)
        await until
        // Drops the server's subscription too, rather than only walking away from it: a debugging
        // session should not leave listeners behind on a device that outlives it.
        await proxy.remote!.off(split.member, handler).catch(() => undefined)
        return 0
    })
