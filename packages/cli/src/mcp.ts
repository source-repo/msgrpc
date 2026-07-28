import { MqttTransport, RpcServer, SocketIoClientTransport, TransportEvent, type MessageSigner, type MessageVerifier, type ServerDescription } from '@source-repo/msgrpc'

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

export interface McpOptions {
    broker?: string
    hub?: string
    prefix?: string
    name: string
    callTimeout: number
    sign?: MessageSigner
    verify?: MessageVerifier
    hubCredentials?: unknown
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

const TOOLS = [
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
    }
] as const

const failureText = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    return error?.code ? `${error.code}: ${error.message ?? ''}`.trim() : e instanceof Error ? e.message : String(e)
}

export const startMcp = async (options: McpOptions) => {
    if (!options.broker && !options.hub) throw new Error('startMcp: give it a broker, a hub, or both')

    const online = new Set<string>()
    // Exposes nothing. This is a window onto the network, not a peer offering anything to it.
    const network = new RpcServer({
        name: options.name,
        callTimeout: options.callTimeout,
        readyTimeout: 15000,
        transports: [
            ...(options.broker
                ? [
                      new MqttTransport(options.name, options.broker, {
                          ...(options.prefix ? { prefix: options.prefix } : {}),
                          ...(options.sign ? { sign: options.sign } : {}),
                          ...(options.verify ? { verify: options.verify } : {})
                      })
                  ]
                : []),
            ...(options.hub
                ? [
                      new SocketIoClientTransport(options.name, options.hub, [], {
                          ...(options.hubCredentials ? { auth: options.hubCredentials as { [key: string]: unknown } } : {})
                      })
                  ]
                : [])
        ]
    })
    await network.ready()
    for (const peer of network.peers.names()) if (peer !== options.name) online.add(peer)
    for (const transport of network.transports) {
        transport.on(TransportEvent.peerOnline, (peer: string) => void (peer !== options.name && online.add(peer)))
        transport.on(TransportEvent.peerGone, (peer: string) => void online.delete(peer))
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
                    serverInfo: { name: 'msgrpc', version: '2.4.0' },
                    instructions:
                        'This is a live msgrpc network. Start with list_peers, then describe_peer to learn a peer' +
                        ' contract before calling it. Calls reach real devices, so treat anything that writes as consequential.'
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
                respond(request.id, { tools: TOOLS })
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
        await network.close()
    }
    // Not stdout: see the note at the top. A client learns what is here from initialize.
    process.stderr.write(`msgrpc mcp: ${options.name} on ${options.broker ?? ''}${options.broker && options.hub ? ' and ' : ''}${options.hub ?? ''}\n`)
    return { network, close, peers: online }
}
