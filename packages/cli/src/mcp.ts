import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { readableNameFor, type RpcSchema, type ServerDescription } from '@source-repo/msgrpc'
import { connectNetwork, type NetworkOptions } from './network.js'
import { looksLikeSchema, startFake, type FakeScript } from './fake.js'
import { checkPeerOn, diffPeersOn } from './conform.js'
import { openTap } from './tapping.js'
import type { TappedFrame } from './bus.js'

/**
 * An msgrpc network as an MCP server, so a model can look at a plant the way a person looks at the
 * console: who is out there, what each one exposes, and call it.
 *
 * MCP is JSON-RPC 2.0 over stdio, newline-delimited. That is little enough to speak directly, and
 * doing so keeps the CLI free of a second RPC framework - this package is, after all, about not
 * needing one. The consequence is the rule everything here obeys: **stdout carries protocol and
 * nothing else**. A stray console.log corrupts the stream and the client sees a parse error rather
 * than whatever was printed, so every diagnostic goes to stderr.
 *
 * The tools are the console's three verbs rather than one tool per method on the network. A peer
 * set that changes while a model is mid-conversation would mean re-issuing the tool list on every
 * arrival and departure; describe_peer hands over the argument types instead, which is the same
 * information in a form that does not go stale.
 */

/** What we answer initialize with when the client asks for something we do not recognise. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

export interface McpOptions extends NetworkOptions {
    /**
     * Where contracts may be written and read. Absent means the contract tools are not offered at
     * all, which is why it is a flag: a model that cannot write files should not be shown tools
     * that claim it can, and a directory says exactly where the writing is allowed to happen.
     */
    contracts?: string
}

/**
 * How long a watching tool may hold the client waiting. A model asking for an hour would get one,
 * and the conversation would look like it had hung.
 */
const MAX_WATCH_SECONDS = 60

/** Subscribing to a peer's events, for the watching tools. */
type Subscribable = {
    on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
    off: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
}

/** Contracts are named, not pathed. A name that could climb out of the directory is refused. */
const SAFE_CONTRACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const contractPath = (directory: string, name: string) => {
    if (!SAFE_CONTRACT_NAME.test(name)) throw new Error(`'${name}' is not a usable contract name`)
    const file = resolve(join(directory, `${name}.types.json`))
    // Proven to stay inside rather than assumed to, the same way the console proves an asset path.
    if (!file.startsWith(resolve(directory) + sep)) throw new Error(`'${name}' would write outside the contracts directory`)
    return file
}

interface JsonRpcRequest {
    jsonrpc: '2.0'
    id?: string | number | null
    method: string
    params?: { [key: string]: unknown }
}

/** JSON-RPC 2.0 error codes. Only the ones a well-behaved client can actually provoke. */
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/**
 * The tools, which depend on what this server was started with.
 *
 * The three read-and-call verbs are always here. The ones that stand a peer up are here because a
 * model asked to try something against a device that does not exist yet would otherwise need a
 * shell; the ones that write a contract to disk appear only when a directory was named, so a server
 * that cannot write files does not advertise tools claiming it can.
 */
const toolsFor = (contracts: string | undefined) => [
    {
        name: 'list_peers',
        description: 'List the peers currently on the msgrpc network, with the ones this server can reach right now.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'describe_peer',
        description:
            'Describe what one peer exposes: its namespaces, the methods in each, their argument names and types, and the events it emits. ' +
            'Call this before call_method - it is where the argument types come from. A peer whose server was started without introspection cannot answer.',
        inputSchema: {
            type: 'object',
            properties: { peer: { type: 'string', description: 'The peer name, as returned by list_peers.' } },
            required: ['peer'],
            additionalProperties: false
        }
    },
    {
        name: 'call_method',
        description:
            'Call a method on a peer and return what it returns. Arguments are positional, in the order describe_peer reports them. ' +
            'A call the peer refuses comes back as an error with its reason rather than as a failure of this tool.',
        inputSchema: {
            type: 'object',
            properties: {
                peer: { type: 'string', description: 'The peer name.' },
                namespace: { type: 'string', description: 'The namespace holding the method, e.g. "plant".' },
                method: { type: 'string', description: 'The method name.' },
                args: { type: 'array', description: 'Positional arguments, in the order describe_peer reports them. Omit for a method that takes none.', items: {} }
            },
            required: ['peer', 'namespace', 'method'],
            additionalProperties: false
        }
    },
    {
        name: 'start_fake',
        description:
            'Stand a peer up from a contract and put it on this network, so something can be called that does not exist yet. ' +
            'It answers every method the contract declares with a value of the declared shape, and refuses arguments the contract would refuse. ' +
            'Give it `schema` directly - no file is needed' +
            (contracts ? ", or `contract` to load one saved with save_contract" : '') +
            '. `script` can supply canned returns, deliberate failures and events on a timer: ' +
            '{"returns":{"plant.read":{"celsius":84}},"fails":{"plant.halt":"Unauthorized"},"emits":[{"event":"plant.alarm","every":2000}]}. ' +
            'The failure code "Timeout" is the special one - that method never answers at all, which is how a caller\'s own timeout is staged. ' +
            'This joins the real network, so it will not take a name a peer already answers to.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The peer name to serve under. Defaults to fake-<three words>.' },
                schema: { type: 'object', description: 'The contract, as an msgrpc schema: {"schema":1,"namespaces":{...}}.' },
                ...(contracts ? { contract: { type: 'string', description: 'The name of a saved contract to serve instead of passing one inline.' } } : {}),
                script: { type: 'object', description: 'Canned returns, deliberate failures and timed events. Optional.' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'stop_fake',
        description: 'Stop a peer started with start_fake and take it off the network. Fakes are stopped anyway when this server exits.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The peer name it was started under.' } }, required: ['name'], additionalProperties: false }
    },
    {
        name: 'list_fakes',
        description: 'The peers this server is standing up, and what each serves.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'check_peer',
        description:
            'Compare what a live peer serves with a contract callers were built against, and report what would break. ' +
            'Runs the same comparison the server applies to a caller declaring an older version, so "argument 0 narrowed" means here what it means in CI. ' +
            'A peer running without a schema is reported as unchecked rather than as passing. Give `schema` inline' +
            (contracts ? ', or `contract` naming a saved one' : '') +
            '.',
        inputSchema: {
            type: 'object',
            properties: {
                peer: { type: 'string', description: 'The peer to ask.' },
                schema: { type: 'object', description: 'The contract to compare against, as an msgrpc schema.' },
                ...(contracts ? { contract: { type: 'string', description: 'The name of a saved contract to compare against.' } } : {})
            },
            required: ['peer'],
            additionalProperties: false
        }
    },
    {
        name: 'diff_peers',
        description:
            'What two live peers expose differently: contract versions, methods one has and the other does not, signatures that changed, ' +
            'events one no longer emits. The usual answer to "why does this cell behave differently from that one".',
        inputSchema: {
            type: 'object',
            properties: { left: { type: 'string' }, right: { type: 'string' } },
            required: ['left', 'right'],
            additionalProperties: false
        }
    },
    {
        name: 'watch_traffic',
        description:
            'Watch what the network carries between other peers for a few seconds and return the frames - calls paired with their replies, ' +
            'each with the method it answers and the time it took. This is traffic this server is not part of, so it is how to see what an HMI ' +
            'and a device are actually saying to each other. Needs a broker exposing a bus, or an MQTT link.',
        inputSchema: {
            type: 'object',
            properties: {
                seconds: { type: 'number', description: `How long to watch. 1 to ${MAX_WATCH_SECONDS}, default 5.` },
                peer: { type: 'string', description: 'Only frames this peer sent or received.' },
                namespace: { type: 'string', description: 'Only this namespace.' },
                payloads: { type: 'boolean', description: 'Include arguments and results. Default true.' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'watch_events',
        description:
            "Subscribe to one of a peer's events for a few seconds and return what it emitted. The subscription is dropped again afterwards, " +
            'so looking does not leave a listener behind on the device.',
        inputSchema: {
            type: 'object',
            properties: {
                peer: { type: 'string' },
                namespace: { type: 'string', description: 'The namespace holding the event, e.g. "plant".' },
                event: { type: 'string' },
                seconds: { type: 'number', description: `How long to listen. 1 to ${MAX_WATCH_SECONDS}, default 5.` }
            },
            required: ['peer', 'namespace', 'event'],
            additionalProperties: false
        }
    },
    ...(contracts
        ? [
              {
                  name: 'save_contract',
                  description:
                      'Write a contract to the contracts directory so it survives this conversation, can be committed, and can be served later with ' +
                      '`msgrpc serve --contract <file>` or checked against a device with `msgrpc check --peer`. Returns the path written.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string', description: 'A name; the file becomes <name>.types.json in the contracts directory.' },
                          schema: { type: 'object', description: 'The contract, as an msgrpc schema: {"schema":1,"namespaces":{...}}.' }
                      },
                      required: ['name', 'schema'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'list_contracts',
                  description: 'The contracts saved in the contracts directory, with the namespaces each describes.',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false }
              }
          ]
        : [])
]

const failureText = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    return error?.code ? `${error.code}: ${error.message ?? ''}`.trim() : e instanceof Error ? e.message : String(e)
}

export const startMcp = async (options: McpOptions) => {
    if (!options.broker && !options.hub) throw new Error('startMcp: give it a broker, a hub, or both')

    // Exposes nothing. This is a window onto the network, not a peer offering anything to it.
    const connected = await connectNetwork(options)
    const { network, online } = connected

    /** Peers this server is standing up, stopped when it exits so none outlive the conversation. */
    const fakes = new Map<string, { namespaces: string[]; close: () => Promise<void> }>()

    /** A contract given inline, or the name of one saved in the contracts directory. */
    const contractFrom = async (args: { [key: string]: unknown }): Promise<{ schema: RpcSchema } | { problem: string }> => {
        if (args.schema) {
            if (!looksLikeSchema(args.schema)) return { problem: 'schema must be an msgrpc contract: {"schema":1,"namespaces":{…}}.' }
            return { schema: args.schema }
        }
        if (!args.contract) return { problem: 'Give it `schema` directly, or `contract` naming a saved one.' }
        if (!options.contracts) return { problem: 'This server was started without a contracts directory, so it cannot load a saved contract.' }
        try {
            const schema = JSON.parse(readFileSync(contractPath(options.contracts, String(args.contract)), 'utf8')) as RpcSchema
            if (!looksLikeSchema(schema)) return { problem: `${String(args.contract)} is not an msgrpc contract.` }
            return { schema }
        } catch (e) {
            return { problem: failureText(e) }
        }
    }

    const startFakeTool = async (args: { [key: string]: unknown }): Promise<{ text: string; isError?: boolean }> => {
        const stored = await contractFrom(args)
        if ('problem' in stored) return { text: stored.problem, isError: true }
        const name = String(args.name ?? readableNameFor('fake'))
        // The guard that matters. A fake taking a name a device already answers to would displace
        // it, and calls meant for the plant would reach a stand-in that agrees with everything.
        if (online.has(name)) return { text: `'${name}' is already a peer on this network. Standing a fake up under that name would take its place; choose another.`, isError: true }
        if (fakes.has(name)) return { text: `'${name}' is already being served here. Stop it first, or use another name.`, isError: true }
        try {
            const running = await startFake({ ...options, name, schema: stored.schema, ...(args.script ? { script: args.script as FakeScript } : {}) })
            fakes.set(name, { namespaces: running.namespaces, close: running.close })
            return { text: `${name} is on the network, answering ${running.namespaces.join(', ')} from the contract. It is a fake: it answers from the contract, not from a device.` }
        } catch (e) {
            return { text: `could not stand up ${name}: ${failureText(e)}`, isError: true }
        }
    }

    const describe = async (peer: string) => {
        const proxy = await network.proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', peer)
        return await proxy.remote!.describe()
    }

    const callTool = async (name: string, args: { [key: string]: unknown }): Promise<{ text: string; isError?: boolean }> => {
        if (name === 'list_peers') return { text: JSON.stringify({ peers: [...online].sort() }, null, 2) }

        if (name === 'describe_peer') {
            const peer = String(args.peer ?? '')
            if (!peer) return { text: 'describe_peer needs a peer name.', isError: true }
            try {
                return { text: JSON.stringify(await describe(peer), null, 2) }
            } catch (e) {
                // An error from the peer is an answer about the peer, not a broken tool call: the
                // model should read "it exposes no introspection" and move on, not retry.
                return { text: `${peer} could not be described: ${failureText(e)}`, isError: true }
            }
        }

        if (name === 'call_method') {
            const peer = String(args.peer ?? '')
            const namespace = String(args.namespace ?? '')
            const method = String(args.method ?? '')
            const parameters = Array.isArray(args.args) ? args.args : []
            if (!peer || !namespace || !method) return { text: 'call_method needs peer, namespace and method.', isError: true }
            try {
                const proxy = await network.proxy<{ [method: string]: (...a: unknown[]) => Promise<unknown> }>(namespace, peer)
                const result = await proxy.remote![method](...parameters)
                return { text: result === undefined ? 'The method returned nothing.' : JSON.stringify(result, null, 2) }
            } catch (e) {
                return { text: `${peer}.${namespace}.${method} failed: ${failureText(e)}`, isError: true }
            }
        }

        if (name === 'start_fake') return await startFakeTool(args)
        if (name === 'stop_fake') {
            const fake = fakes.get(String(args.name ?? ''))
            if (!fake) return { text: `Nothing called '${String(args.name ?? '')}' was started here.`, isError: true }
            await fake.close()
            fakes.delete(String(args.name))
            return { text: `${String(args.name)} stopped and taken off the network.` }
        }
        if (name === 'list_fakes')
            return { text: JSON.stringify({ fakes: [...fakes.entries()].map(([peer, fake]) => ({ peer, namespaces: fake.namespaces })) }, null, 2) }

        if (name === 'save_contract') {
            if (!options.contracts) return { text: 'This server was started without a contracts directory, so it cannot write one.', isError: true }
            try {
                if (!looksLikeSchema(args.schema)) return { text: 'schema must be an msgrpc contract: {"schema":1,"namespaces":{…}}.', isError: true }
                const file = contractPath(options.contracts, String(args.name ?? ''))
                writeFileSync(file, JSON.stringify(args.schema, null, 2) + '\n')
                return { text: `Wrote ${file}. Serve it with \`msgrpc serve --contract ${file}\`, or check a device against it with \`msgrpc check --peer <name> --against ${file}\`.` }
            } catch (e) {
                return { text: failureText(e), isError: true }
            }
        }
        if (name === 'list_contracts') {
            if (!options.contracts) return { text: 'This server was started without a contracts directory.', isError: true }
            try {
                const saved = readdirSync(options.contracts)
                    .filter((entry) => entry.endsWith('.types.json'))
                    .map((entry) => {
                        const contract = entry.replace(/\.types\.json$/, '')
                        try {
                            const schema = JSON.parse(readFileSync(join(options.contracts!, entry), 'utf8')) as RpcSchema
                            return { contract, namespaces: Object.keys(schema.namespaces ?? {}) }
                        } catch {
                            return { contract, namespaces: [], unreadable: true }
                        }
                    })
                return { text: JSON.stringify({ directory: resolve(options.contracts), contracts: saved }, null, 2) }
            } catch (e) {
                return { text: failureText(e), isError: true }
            }
        }

        if (name === 'check_peer') {
            const peer = String(args.peer ?? '')
            if (!peer) return { text: 'check_peer needs a peer name.', isError: true }
            const stored = await contractFrom(args)
            if ('problem' in stored) return { text: stored.problem, isError: true }
            try {
                const report = await checkPeerOn(connected, { peer, stored: stored.schema })
                const count = report.problems.length + report.missing.length
                return {
                    text: JSON.stringify(report, null, 2),
                    // A device behind its contract is an answer about the device, and the model
                    // should read it rather than treat the tool as broken - but it is not a pass.
                    ...(count ? { isError: true } : {})
                }
            } catch (e) {
                return { text: failureText(e), isError: true }
            }
        }
        if (name === 'diff_peers') {
            const left = String(args.left ?? '')
            const right = String(args.right ?? '')
            if (!left || !right) return { text: 'diff_peers needs two peer names.', isError: true }
            try {
                return { text: JSON.stringify(await diffPeersOn(connected, { left, right }), null, 2) }
            } catch (e) {
                return { text: failureText(e), isError: true }
            }
        }

        if (name === 'watch_traffic') {
            const seconds = Math.min(Math.max(Number(args.seconds ?? 5), 1), MAX_WATCH_SECONDS)
            const frames: unknown[] = []
            const filter = {
                payloads: args.payloads !== false,
                ...(args.peer ? { peer: String(args.peer) } : {}),
                ...(args.namespace ? { namespace: String(args.namespace) } : {}),
                ttl: Math.ceil(seconds) + 10
            }
            const tap = await openTap(connected, options, filter, (frame: TappedFrame) => void frames.push(frame))
            if (!tap.sources.length) {
                await tap.close()
                return { text: 'Nothing here can watch traffic: no broker exposing a bus, and no --broker link.', isError: true }
            }
            await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
            await tap.close()
            return { text: JSON.stringify({ watchedFor: seconds, sources: tap.sources, frames }, null, 2) }
        }
        if (name === 'watch_events') {
            const peer = String(args.peer ?? '')
            const namespace = String(args.namespace ?? '')
            const event = String(args.event ?? '')
            if (!peer || !namespace || !event) return { text: 'watch_events needs peer, namespace and event.', isError: true }
            const seconds = Math.min(Math.max(Number(args.seconds ?? 5), 1), MAX_WATCH_SECONDS)
            const heard: unknown[] = []
            const handler = (...emitted: unknown[]) => void heard.push({ at: Date.now(), args: emitted })
            try {
                const proxy = await network.proxy<Subscribable>(namespace, peer)
                await proxy.remote!.on(event, handler)
                await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
                // Dropped again, so a look does not leave a subscription behind on the device.
                await proxy.remote!.off(event, handler).catch(() => undefined)
                return { text: JSON.stringify({ watchedFor: seconds, event: `${peer}.${namespace}.${event}`, heard }, null, 2) }
            } catch (e) {
                return { text: `cannot watch ${peer}.${namespace}.${event}: ${failureText(e)}`, isError: true }
            }
        }

        return { text: `Unknown tool '${name}'.`, isError: true }
    }

    const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
    const respond = (id: JsonRpcRequest['id'], result: unknown) => write({ jsonrpc: '2.0', id, result })
    const fail = (id: JsonRpcRequest['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })

    const handle = async (request: JsonRpcRequest) => {
        // A notification has no id and must not be answered at all, not even with an error.
        const isNotification = request.id === undefined || request.id === null

        switch (request.method) {
            case 'initialize': {
                // Echo the client's version when it names one. This server is thin enough to speak
                // any revision that still calls tools the same way, and refusing a version we have
                // simply never heard of would be worse than answering it.
                const asked = request.params?.protocolVersion
                respond(request.id, {
                    protocolVersion: typeof asked === 'string' && asked ? asked : FALLBACK_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    // Bumped with the package. Clients show it when reporting which server said what.
                    serverInfo: { name: 'msgrpc', version: '2.5.0' },
                    instructions:
                        'This is a live msgrpc network. Start with list_peers, then describe_peer to learn a peer' +
                        ' contract before calling it. Calls reach real devices, so treat anything that writes as consequential.' +
                        ' start_fake puts a peer of your own on the same network, built from a contract you supply - use it to try something' +
                        ' against a device that does not exist yet, rather than against one that does. watch_traffic shows what other peers' +
                        ' are saying to each other, which is most of what is happening.'
                })
                return
            }
            case 'notifications/initialized':
            case 'notifications/cancelled':
                return
            case 'ping':
                if (!isNotification) respond(request.id, {})
                return
            case 'tools/list':
                respond(request.id, { tools: toolsFor(options.contracts) })
                return
            case 'tools/call': {
                const name = String(request.params?.name ?? '')
                const args = (request.params?.arguments ?? {}) as { [key: string]: unknown }
                if (!name) {
                    fail(request.id, INVALID_PARAMS, 'tools/call needs a tool name')
                    return
                }
                const { text, isError } = await callTool(name, args)
                respond(request.id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
                return
            }
            default:
                if (!isNotification) fail(request.id, METHOD_NOT_FOUND, `unknown method '${request.method}'`)
        }
    }

    let buffered = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
        buffered += chunk
        // Newline-delimited, and a chunk boundary can fall anywhere, so the tail is kept for next
        // time rather than parsed as a truncated message.
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            newline = buffered.indexOf('\n')
            if (!line) continue
            let request: JsonRpcRequest
            try {
                request = JSON.parse(line) as JsonRpcRequest
            } catch {
                // No id to answer to, so there is nowhere to send a parse error that the client
                // could match up. Said on stderr, which is where a person will look.
                process.stderr.write('msgrpc mcp: ignoring a line that is not JSON\n')
                continue
            }
            void handle(request).catch((e) => {
                if (request.id !== undefined && request.id !== null) fail(request.id, INTERNAL_ERROR, failureText(e))
                else process.stderr.write(`msgrpc mcp: ${failureText(e)}\n`)
            })
        }
    })

    const close = async () => {
        process.stdin.removeAllListeners('data')
        // Before the network goes: a fake left running would hold a link this is about to drop.
        for (const fake of fakes.values()) await fake.close().catch(() => undefined)
        fakes.clear()
        await connected.close()
    }
    // Not stdout: see the note at the top. A client learns what is here from initialize.
    process.stderr.write(`msgrpc mcp: ${options.name} on ${options.broker ?? ''}${options.broker && options.hub ? ' and ' : ''}${options.hub ?? ''}\n`)
    return { network, close, peers: online }
}
