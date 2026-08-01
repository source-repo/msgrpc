import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { readableNameFor, validateValue, type RemoteSurface, type RpcSchema, type ServerDescription } from '@source-repo/rpc'
import { connectNetwork, type NetworkOptions } from './network.js'
import { looksLikeSchema, startFake, type FakeScript } from './fake.js'
import { environmentFor } from './scripts.js'
import { versionSkewLine } from './packages.js'
import { ScriptingService, scriptingAuthorizer } from './scripting.js'
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
    /**
     * Permit a fake whose behaviour is JavaScript or Python the model wrote. Absent means the fields
     * are not offered on `start_fake` at all - the same rule the contracts directory follows, and for
     * the same reason: a tool description that advertises what the server will refuse wastes a turn
     * and teaches the model something untrue.
     *
     * It is off by default because it is code execution on whoever runs this server. See handlers.ts.
     */
    allowExec?: boolean
    /**
     * Where scripts may be written, read and run from. Absent means the script tools are not offered
     * at all - the same rule the contracts directory follows.
     *
     * A script is a Node process with the privileges of whoever started this server, so this is a
     * bigger grant than `allowExec` and is separate from it on purpose: a simulator body in a
     * sandbox and a program that can open sockets are not the same permission.
     */
    scripts?: string
    /**
     * Peer names permitted to script this node from elsewhere. Empty - the default - means the
     * scripting namespace is not offered to the bus at all, so a server with `--scripts` can drive
     * its own machine and cannot be driven by anybody else's.
     *
     * Naming somebody here is the grant, and it is made on the node being scripted rather than by
     * the one doing the scripting - which is why the key that peer authenticates with has to reach
     * it out of band. A bus able to hand over that key is a bus able to script the node.
     */
    scriptableBy?: string[]
    /**
     * Serve streamable HTTP on this port as a second door beside stdio. Absent means stdio only,
     * which is where this server has always lived. The door exists because stdio means exactly one
     * client: the field trial found a node already attached to another session, and the second
     * agent's fallback - driving the CLI by hand - forked the scripts state the node was custodian
     * of. Over the door, every client shares one view: one scripts directory, one set of fakes, one
     * memory of watch cursors, because there is only one of everything here.
     */
    port?: number
    /** The interface for the door. Default 127.0.0.1; see the warnings startMcp prints. */
    host?: string
    /**
     * Bearer token the door requires. An HTTP door is a new surface where stdio's authorization was
     * implicit in process ownership, so the rule is fail-closed where it matters: a door widened
     * past loopback without a token refuses to start, and a loopback door without one says plainly
     * that any process on this machine can drive the node.
     */
    doorToken?: string
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
const toolsFor = (contracts: string | undefined, allowExec = false, scripts?: string) => [
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
        name: 'find_capability',
        description:
            "List the peers implementing a package-qualified capability, e.g. '@scope/contracts/UiBuilder'. " +
            'Capabilities come from extracted contracts, and a peer implementing a subinterface satisfies a search for its parent. ' +
            'An empty list means nobody implements it - that is an answer, not an error. ' +
            'Discovery proposes, never appoints: whether a peer may be asked to act stays an authorization question.',
        inputSchema: {
            type: 'object',
            properties: { capability: { type: 'string', description: "The package-qualified name, e.g. '@scope/contracts/UiBuilder'. Bare names match nothing." } },
            required: ['capability'],
            additionalProperties: false
        }
    },
    {
        name: 'call_method',
        description:
            'Call a method on a peer and return what it returns. Arguments are positional, in the order describe_peer reports them. ' +
            'A call the peer refuses comes back as an error with its reason rather than as a failure of this tool. ' +
            'When the peer has been described, arguments are checked against its contract locally first, so a wrong shape fails before it travels.',
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
            (allowExec
                ? 'For a simulation that reacts rather than repeats, `state` seeds shared variables and `handlers` gives a method a JavaScript body: ' +
                  '{"state":{"celsius":20,"setpoint":20},"handlers":{"plant.setSetpoint":"(v) => { state.setpoint = v }","plant.read":"() => ({celsius: state.celsius += Math.sign(state.setpoint - state.celsius)})"}}. ' +
                  '`python` runs a program instead - {"python":{"program":"@rpc(\'plant.read\')\\ndef read(): return {\'celsius\': 20}","targets":["plant.read"]}} - which keeps its own state and is started once. '
                : '') +
            'This joins the real network, so it will not take a name a peer already answers to.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The peer name to serve under. Defaults to fake-<three words>.' },
                schema: { type: 'object', description: 'The contract, as an msgrpc schema: {"schema":1,"namespaces":{...}}.' },
                ...(contracts ? { contract: { type: 'string', description: 'The name of a saved contract to serve instead of passing one inline.' } } : {}),
                script: { type: 'object', description: 'Canned returns, deliberate failures and timed events. Optional.' + (allowExec ? ' May also carry `state`, `handlers` and `python`.' : '') }
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
            'so looking does not leave a listener behind on the device. The answer also says whether anything was missed since your previous ' +
            'watch of the same stream: "saw nothing" and "saw nothing and missed nothing" are different answers, and `loss` states which one ' +
            'this was - or that the server restarted between watches, which makes the question unanswerable, or that the peer is too old to say.',
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
                      '`source-rpc serve --contract <file>` or checked against a device with `source-rpc check --peer`. Returns the path written.',
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
        : []),
    ...(scripts
        ? [
              {
                  name: 'save_script',
                  description:
                      'Write a script to the scripts directory. A script is an ESM Node program that imports @source-repo/rpc and is a peer in its own right - ' +
                      'so unlike start_fake it is not bound to one contract and can call as well as answer, drive a sequence, watch events, or stand several peers up at once. ' +
                      'It runs as its own process. The network this server is on is in the environment as SOURCE_RPC_HUB, SOURCE_RPC_BROKER, SOURCE_RPC_PREFIX and SOURCE_RPC_TOKEN, ' +
                      'so a script should read those rather than hardcode a url. Saving does not start it.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string', description: 'A name; the file becomes <name>.ts (or <name>.mjs) in the scripts directory.' },
                          source: { type: 'string', description: 'The program. TypeScript by default - Node runs it directly - so `import type { Pump } from ...` gives a typed proxy.' },
                          language: { type: 'string', enum: ['ts', 'mjs'], description: 'Default ts. Use mjs for plain JavaScript, or when the server runs on a Node older than 22.6.' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name', 'source'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'list_scripts',
                  description: 'The scripts in the directory, which of them are running here, and which directory that is.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      additionalProperties: false
                  }
              },
              {
                  name: 'read_script',
                  description: 'The source of one saved script, for changing a part of it rather than rewriting the whole.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'delete_script',
                  description: 'Remove a script from the directory. It is stopped first if it is running.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'start_script',
                  description: 'Run a saved script as its own process. Returns immediately; use script_output to see what it printed.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'stop_script',
                  description: 'Stop a running script. Scripts are stopped anyway when this server exits.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'list_packages',
                  description: 'The npm packages a script in this directory may import, with what is declared and what is actually installed.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      additionalProperties: false
                  }
              },
              {
                  name: 'add_package',
                  description:
                      'Install an npm package into the scripts directory so a script can import it. Give a name, optionally with a range: `zod` or `@scope/name@^2`. ' +
                      'Install scripts are skipped by default, because a postinstall hook is unreviewed code from the registry running here - pass allowInstallScripts only for a package that needs a native build, and say why.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          spec: { type: 'string', description: 'Package name, optionally with a version range.' },
                          allowInstallScripts: { type: 'boolean', description: 'Permit the package to run its own install hooks. Default false.' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['spec'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'remove_package',
                  description: 'Uninstall an npm package from the scripts directory.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              },
              {
                  name: 'script_output',
                  description: 'The most recent output of a script, running or finished, with stderr lines marked "! ". This is how a script reports; it has no other channel.',
                  inputSchema: {
                      type: 'object',
                      properties: {
                          name: { type: 'string' },
                          node: {
                                  type: 'string',
                                  description:
                                      'Which node to do this on. Absent means this one. Another peer works only if that node has named this one as permitted to script it, which is arranged there and not here.'
                              }
                      },
                      required: ['name'],
                      additionalProperties: false
                  }
              }
          ]
        : [])
]

/**
 * A failure as one line of text.
 *
 * The code is worth prefixing because an RPC error carries it apart from its message - `Forbidden`
 * beside "not permitted to relay" - and the code is the part a model can act on. A `node:fs` error
 * already opens with its own code, so prefixing that one again produced
 * `ENOENT: ENOENT: no such file or directory`, which reads as the same thing having gone wrong
 * twice rather than as one missing directory.
 */
export const failureText = (e: unknown) => {
    const error = e as { code?: string; message?: string }
    const message = (error?.message ?? (e instanceof Error ? e.message : String(e))).trim()
    if (!error?.code) return message
    if (!message) return error.code
    return message.startsWith(error.code) ? message : `${error.code}: ${message}`
}

export const startMcp = async (options: McpOptions) => {
    // stdout carries the protocol, so this goes to stderr like every other word this server says.
    if (options.allowExec)
        process.stderr.write('source-rpc mcp: --allow-exec is on, so start_fake will run JavaScript or Python the client sends. Development machines only.\n')
    // Said at least as loudly as --allow-exec, because it is the larger grant of the two: a handler
    // is a method body in a sandbox that is not a boundary, and a script is a process with this
    // server's own privileges, its environment and its bus credentials. The smaller one announcing
    // itself while the bigger one stayed quiet was the wrong way round.
    if (options.scripts)
        process.stderr.write(
            `source-rpc mcp: --scripts is on, so this server will write and run programs in ${options.scripts} with your privileges, and may install packages there. Development machines only.\n`
        )
    if (options.scripts) {
        // A statement, not a refusal: an old script against its own pinned library is legitimate.
        // What the line prevents is new code quietly written against the API the directory happens
        // to hold, which is what the first field trial did for an afternoon without noticing.
        const skew = versionSkewLine(options.scripts, 'mcp')
        if (skew) process.stderr.write(skew)
    }
    // Louder than the rest, because this is the one that puts it on the network rather than under
    // the person at the keyboard.
    if (options.scriptableBy?.length)
        process.stderr.write(
            `source-rpc mcp: --scriptable-by is on, so ${options.scriptableBy.join(' and ')} may write and run programs on this machine over the network. They must authenticate as those names; a peer this network cannot identify is refused.\n`
        )
    if (!options.broker && !options.hub) throw new Error('startMcp: give it a broker, a hub, or both')

    // A window onto the network and nothing more, unless --scriptable-by names somebody - at which
    // point this peer offers one namespace and the guard that comes with it. The guard goes on at
    // construction rather than afterwards, so there is no instant where the namespace is reachable
    // and unguarded.
    const scriptableBy = options.scriptableBy?.filter((entry) => entry.trim()) ?? []
    const scripting = options.scripts
        ? new ScriptingService({ directory: options.scripts, environment: environmentFor(options), allow: scriptableBy })
        : undefined
    const connected = await connectNetwork({
        ...options,
        ...(scriptableBy.length
            ? {
                  authorize: scriptingAuthorizer({ directory: options.scripts ?? '', allow: scriptableBy }),
                  // Before ready(), so a queued request cannot arrive at a peer that has not exposed
                  // the namespace yet - see the note on `expose`.
                  expose: (network) => network.exposeClassInstance(scripting!)
              }
            : {})
    })
    const { network, online } = connected

    /** Peers this server is standing up, stopped when it exits so none outlive the conversation. */
    const fakes = new Map<string, { namespaces: string[]; close: () => Promise<void> }>()
    // Given the same network this server joined, so a script reads its broker url rather than
    // inventing one that is right on this machine and wrong on the next.
    // The same service a node exposes to the bus, held directly rather than called over RPC - which
    // is what "local" means for the guard: not a peer name to compare, but no RPC at all.
    // The object is held for this server's own use whether or not it was exposed above: that is the
    // difference between a node that can script itself and one that can be scripted.

    /**
     * Whichever node a tool was aimed at. Absent, or this server's own name, is the local object;
     * anything else is that peer's `scripting` namespace, reached the ordinary way.
     *
     * This is the whole of what makes a test hall one place. The tools below do not know which they
     * are talking to, because there is nothing to know - the method names are the same either way,
     * which is the point of having made it a namespace rather than a set of tool handlers.
     */
    const scriptingOn = async (node: unknown): Promise<RemoteSurface<ScriptingService>> => {
        const target = typeof node === 'string' && node.trim() ? node.trim() : undefined
        if (!target || target === options.name) {
            if (!scripting) throw new Error('scripting is not enabled here - start this server with --scripts <dir>')
            return scripting
        }
        if (!(await connected.network.awaitPeer(target, 5000)))
            throw new Error(`'${target}' is not on this network. Run list_peers to see who is.`)
        return (await connected.network.proxy<ScriptingService>('scripting', target))
    }

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
        return await proxy.describe()
    }

    /**
     * The discovery cache: find_capability fills it sweeping the network, call_method validates
     * from it. Short-lived, because a contract can change with a redeploy and a stale cache would
     * refuse arguments the peer now takes - thirty seconds keeps a conversation's worth of calls
     * cheap without remembering last week's shape. The description hash presence carries cuts the
     * other way too: a peer announcing a hash other than the one this entry was described under is
     * refetched at once rather than trusted out the rest of its thirty seconds, and an unchanged
     * peer costs nothing extra. A peer announcing no hash - anything from before the field
     * existed - keeps the age-based bargain it always had.
     */
    const described = new Map<string, { description: ServerDescription; at: number; shape?: string }>()
    const DESCRIBE_CACHE_MS = 30_000

    /**
     * Where each watched event stream stood when its last watch window closed, so the next window
     * can say whether anything fell between them. Held here for the life of this server - the
     * windows are the model's, but the memory of them is one process's, which is exactly the
     * lifetime the answer is honest for: a restarted MCP server starts over at "first watch".
     */
    const watchCursors = new Map<string, { epoch: string; seq: number }>()
    const describedOf = async (peer: string) => {
        const held = described.get(peer)
        const announced = network.peers.shapeOf(peer)
        if (held && Date.now() - held.at < DESCRIBE_CACHE_MS && (announced === undefined || held.shape === announced)) return held.description
        // Read before the describe, not after: a shape that changes mid-flight then differs from
        // the stored one, and the next lookup refetches rather than trusting a torn pair.
        const shape = announced
        const description = await describe(peer)
        described.set(peer, { description, at: Date.now(), ...(shape !== undefined ? { shape } : {}) })
        return description
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

        if (name === 'find_capability') {
            const capability = String(args.capability ?? '')
            if (!capability) return { text: "find_capability needs a package-qualified capability name, e.g. '@scope/contracts/UiBuilder'.", isError: true }
            const matches: { peer: string; namespace: string; version?: string; capabilities: string[] }[] = []
            await Promise.all(
                [...online].sort().map(async (who) => {
                    let description: ServerDescription
                    try {
                        description = await describedOf(who)
                    } catch {
                        // Not discoverable without introspection, which is the rule, not a failure.
                        return
                    }
                    for (const namespace of description.namespaces)
                        if (namespace.capabilities?.includes(capability))
                            matches.push({ peer: who, namespace: namespace.name, ...(namespace.version ? { version: namespace.version } : {}), capabilities: namespace.capabilities })
                })
            )
            matches.sort((a, b) => a.peer.localeCompare(b.peer) || a.namespace.localeCompare(b.namespace))
            return { text: JSON.stringify({ capability, matches }, null, 2) }
        }

        if (name === 'call_method') {
            const peer = String(args.peer ?? '')
            const namespace = String(args.namespace ?? '')
            const method = String(args.method ?? '')
            const parameters = Array.isArray(args.args) ? args.args : []
            if (!peer || !namespace || !method) return { text: 'call_method needs peer, namespace and method.', isError: true }
            // The contract fetched during discovery pays off here: a hallucinated wiring - the
            // wrong shape into a method - fails locally as InvalidParams before spending a network
            // hop. A peer that cannot be described cannot be pre-checked; the call itself answers.
            try {
                const description = await describedOf(peer)
                const target = description.namespaces.find((held) => held.name === namespace)?.methods.find((held) => held.name === method)
                if (target?.params) {
                    for (let index = 0; index < parameters.length && index < target.params.length; index++) {
                        const problem = validateValue(parameters[index], target.params[index], description.types, target.paramNames?.[index] ?? `argument ${index}`)
                        if (problem) return { text: `InvalidParams, before sending: ${problem}`, isError: true }
                    }
                }
            } catch {
                // Undescribable: send it and let the peer answer.
            }
            try {
                const proxy = await network.proxy<{ [method: string]: (...a: unknown[]) => Promise<unknown> }>(namespace, peer)
                const result = await proxy[method](...parameters)
                return { text: result === undefined ? 'The method returned nothing.' : JSON.stringify(result, null, 2) }
            } catch (e) {
                return { text: `${peer}.${namespace}.${method} failed: ${failureText(e)}`, isError: true }
            }
        }

        if (scripting && options.scripts) {
            const scriptName = String(args.name ?? '')
            // One shape for every one of these: find the node, call the method, report what came
            // back. A refusal from the far end arrives as Forbidden, and saying what that means is
            // worth more than the code - a key is exchanged out of band, never over this bus.
            const on = async (act: (target: RemoteSurface<ScriptingService>) => Promise<{ text: string; isError?: boolean }>) => {
                let target: RemoteSurface<ScriptingService>
                try {
                    target = await scriptingOn(args.node)
                } catch (e) {
                    return { text: failureText(e), isError: true }
                }
                try {
                    return await act(target)
                } catch (e) {
                    const refused = /Forbidden/.test(failureText(e))
                    return {
                        text: refused
                            ? `${String(args.node)} refused: it has not named this peer as one that may script it. That is granted on the far node and the key comes to you out of band - it is deliberately not something this bus can hand over.`
                            : failureText(e),
                        isError: true
                    }
                }
            }

            if (name === 'save_script') {
                if (!scriptName || args.source === undefined) return { text: 'save_script needs name and source.', isError: true }
                return await on(async (target) => ({
                    text: `Saved ${await target.save(scriptName, String(args.source), args.language === 'mjs' ? 'mjs' : 'ts')}. It is not running; start_script runs it.`
                }))
            }
            if (name === 'list_scripts') {
                // Said with the list, because an empty list from the directory you meant and an
                // empty list from one you did not are the same two characters - and a `--scripts`
                // given the next flag as its value produces exactly the second, with nothing else
                // on hand to tell them apart. A remote node is named instead of its directory,
                // which is a path on a machine this server cannot look at.
                const where = args.node ? { node: String(args.node) } : { directory: options.scripts }
                return await on(async (target) => ({ text: JSON.stringify({ ...where, scripts: await target.list() }, null, 2) }))
            }
            if (name === 'read_script') return await on(async (target) => ({ text: await target.read(scriptName) }))
            if (name === 'delete_script')
                return await on(async (target) => {
                    await target.remove(scriptName)
                    return { text: `${scriptName} deleted.` }
                })
            if (name === 'start_script')
                return await on(async (target) => {
                    const started = await target.start(scriptName)
                    return { text: `${scriptName} started as pid ${started.pid ?? 'unknown'}. It is a process of its own; script_output is how it reports.` }
                })
            if (name === 'stop_script')
                return await on(async (target) => {
                    await target.stop(scriptName)
                    return { text: `${scriptName} stopped.` }
                })
            if (name === 'list_packages') return await on(async (target) => ({ text: JSON.stringify(await target.packages(), null, 2) }))
            if (name === 'add_package')
                return await on(async (target) => {
                    const result = await target.addPackage(String(args.spec ?? ''), args.allowInstallScripts === true)
                    return { text: result.output || 'Installed.', isError: !result.ok }
                })
            if (name === 'remove_package')
                return await on(async (target) => {
                    const result = await target.removePackage(scriptName)
                    return { text: result.output || 'Removed.', isError: !result.ok }
                })
            if (name === 'script_output')
                return await on(async (target) => {
                    const record = await target.output(scriptName)
                    const ended = record.ended ? `\n(ended: code ${String(record.ended.code)}${record.ended.signal ? `, signal ${record.ended.signal}` : ''})` : ''
                    return { text: (record.output.length ? record.output.join('\n') : 'It has printed nothing yet.') + ended }
                })
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
                // Made on the way past, the way saveScript makes the scripts directory. `--contracts
                // ./contracts` names where contracts are to go, not somewhere that already has to
                // exist, and a tool that is offered and then fails ENOENT on the first thing asked
                // of it reads as a broken server rather than as a directory nobody created.
                mkdirSync(resolve(options.contracts), { recursive: true })
                writeFileSync(file, JSON.stringify(args.schema, null, 2) + '\n')
                return { text: `Wrote ${file}. Serve it with \`source-rpc serve --contract ${file}\`, or check a device against it with \`source-rpc check --peer <name> --against ${file}\`.` }
            } catch (e) {
                return { text: failureText(e), isError: true }
            }
        }
        if (name === 'list_contracts') {
            if (!options.contracts) return { text: 'This server was started without a contracts directory.', isError: true }
            try {
                // Not yet created is not an error: it is an empty directory, which is the same
                // answer listScripts gives from the same state and for the same reason. Anything
                // else - a directory that is there and cannot be read - still is one.
                const saved = (existsSync(options.contracts) ? readdirSync(options.contracts) : [])
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
            const heard: { at: number; args: unknown[]; seq?: number }[] = []
            const caller = network.caller
            const handler = (...emitted: unknown[]) => {
                // Read on the handler's first line, which is the one moment the stamp is this
                // delivery's - see lastDeliveredStamp. Absent means the server does not track it.
                const stamp = caller?.lastDeliveredStamp
                heard.push({ at: Date.now(), args: emitted, ...(stamp && stamp.event === event ? { seq: stamp.seq } : {}) })
            }
            // The counter's stand at the emitting server, this incarnation. Undefined for a peer
            // that predates cursors or serves no introspection - the loss answer says so rather
            // than pretending. Asking also starts the counter for an ad-hoc event, so even when
            // this watch cannot say, the next one can.
            const cursorOf = async () => {
                try {
                    const msgrpc = await network.proxy<{ eventCursor(ns: string, ev: string): Promise<{ epoch: string; seq: number | null; since?: number }> }>('msgrpc', peer)
                    return await msgrpc.eventCursor(namespace, event)
                } catch {
                    return undefined
                }
            }
            try {
                const proxy = await network.proxy<Subscribable>(namespace, peer)
                await proxy.on(event, handler)
                await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
                // Dropped again, so a look does not leave a subscription behind on the device.
                await proxy.off(event, handler).catch(() => undefined)
                const streamKey = `${peer}\u0000${namespace}\u0000${event}`
                const previous = watchCursors.get(streamKey)
                const cursor = await cursorOf()
                let loss: string
                if (!cursor || cursor.seq === null) loss = 'unknown - the peer reports no cursor for this event, so nothing can be said about what fell between watches'
                else {
                    watchCursors.set(streamKey, { epoch: cursor.epoch, seq: cursor.seq })
                    if (!previous) loss = 'first watch of this stream here - the next one can say whether anything fell between them'
                    else if (previous.epoch !== cursor.epoch) loss = 'unknowable - the server restarted between watches, and a fresh incarnation cannot say what happened before it'
                    else {
                        // Everything that fired since the last watch ended, minus what this one
                        // heard, is what fell between them - or was lost mid-watch, which the
                        // per-event seq stamps in `heard` distinguish.
                        const missed = cursor.seq - previous.seq - heard.length
                        loss =
                            missed <= 0
                                ? `gapless - nothing fired between this watch and the previous one that was not heard (${cursor.seq - previous.seq} fired, ${heard.length} heard)`
                                : `missed ${missed} - ${cursor.seq - previous.seq} fired since the previous watch and only ${heard.length} were heard here`
                    }
                }
                return {
                    text: JSON.stringify(
                        { watchedFor: seconds, event: `${peer}.${namespace}.${event}`, heard, loss, ...(cursor && cursor.seq !== null ? { cursor } : {}) },
                        null,
                        2
                    )
                }
            } catch (e) {
                return { text: `cannot watch ${peer}.${namespace}.${event}: ${failureText(e)}`, isError: true }
            }
        }

        return { text: `Unknown tool '${name}'.`, isError: true }
    }

    /**
     * One answer for one JSON-RPC message, whichever door it arrived through - the same dispatch
     * serves stdio and the streamable HTTP door, which is precisely what makes two clients share
     * one view of the scripts, fakes, watches and cursors: there is only one of everything here.
     * Returns undefined for a notification, which must not be answered at all.
     */
    const answerTo = async (request: JsonRpcRequest): Promise<{ result: unknown } | { error: { code: number; message: string } } | undefined> => {
        const isNotification = request.id === undefined || request.id === null

        switch (request.method) {
            case 'initialize': {
                // Echo the client's version when it names one. This server is thin enough to speak
                // any revision that still calls tools the same way, and refusing a version we have
                // simply never heard of would be worse than answering it.
                const asked = request.params?.protocolVersion
                return {
                    result: {
                        protocolVersion: typeof asked === 'string' && asked ? asked : FALLBACK_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        // Bumped with the package. Clients show it when reporting which server said what.
                        serverInfo: { name: 'source-rpc', version: '3.0.0' },
                        instructions:
                            'This is a live Source RPC network. Start with list_peers, then describe_peer to learn a peer' +
                            ' contract before calling it. Calls reach real devices, so treat anything that writes as consequential.' +
                            ' start_fake puts a peer of your own on the same network, built from a contract you supply - use it to try something' +
                            ' against a device that does not exist yet, rather than against one that does. watch_traffic shows what other peers' +
                            ' are saying to each other, which is most of what is happening.'
                    }
                }
            }
            case 'notifications/initialized':
            case 'notifications/cancelled':
                return undefined
            case 'ping':
                return isNotification ? undefined : { result: {} }
            case 'tools/list':
                return { result: { tools: toolsFor(options.contracts, options.allowExec, options.scripts) } }
            case 'tools/call': {
                const name = String(request.params?.name ?? '')
                const args = (request.params?.arguments ?? {}) as { [key: string]: unknown }
                if (!name) return { error: { code: INVALID_PARAMS, message: 'tools/call needs a tool name' } }
                const { text, isError } = await callTool(name, args)
                return { result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }
            }
            default:
                return isNotification ? undefined : { error: { code: METHOD_NOT_FOUND, message: `unknown method '${request.method}'` } }
        }
    }

    const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
    const fail = (id: JsonRpcRequest['id'], code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })

    const handle = async (request: JsonRpcRequest) => {
        const answer = await answerTo(request)
        if (answer) write({ jsonrpc: '2.0', id: request.id, ...answer })
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
                process.stderr.write('source-rpc mcp: ignoring a line that is not JSON\n')
                continue
            }
            void handle(request).catch((e) => {
                if (request.id !== undefined && request.id !== null) fail(request.id, INTERNAL_ERROR, failureText(e))
                else process.stderr.write(`source-rpc mcp: ${failureText(e)}\n`)
            })
        }
    })

    /**
     * The second door: streamable HTTP, spoken directly for the same reason stdio is - the
     * protocol is a POST carrying one JSON-RPC message and a JSON answer, which is little enough
     * that an SDK would be the bigger dependency. Two deliberate simplifications the spec allows:
     * no session ids are assigned, because the door exists to *share* one process-wide state and
     * a session would only pretend otherwise; and GET's server-initiated stream is declined with
     * 405, because this server has no server-initiated messages to send.
     */
    let door: ReturnType<typeof createHttpServer> | undefined
    if (options.port) {
        const doorHost = options.host ?? '127.0.0.1'
        const local = doorHost === '127.0.0.1' || doorHost === 'localhost'
        // Fail closed before the port opens: a wide door with no lock is not started, warned about
        // and left open - it is refused, and the sentence says what would make it acceptable.
        if (!local && !options.doorToken)
            throw new Error(`mcp: refusing to serve HTTP on ${doorHost} without a token - the network could drive this node. Set SOURCE_RPC_MCP_TOKEN, or bind 127.0.0.1.`)
        const MAX_BODY = 4 * 1024 * 1024
        door = createHttpServer((request, response) => {
            if (request.method !== 'POST') {
                response.writeHead(405, { Allow: 'POST' }).end()
                return
            }
            if (options.doorToken && request.headers.authorization !== `Bearer ${options.doorToken}`) {
                response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end()
                return
            }
            let body = ''
            request.setEncoding('utf8')
            request.on('data', (chunk: string) => {
                body += chunk
                if (body.length > MAX_BODY) request.destroy()
            })
            request.on('end', () => {
                let message: JsonRpcRequest
                try {
                    message = JSON.parse(body) as JsonRpcRequest
                } catch {
                    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_PARAMS, message: 'the body is not a JSON-RPC message' } }))
                    return
                }
                if (Array.isArray(message)) {
                    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_PARAMS, message: 'batches are not accepted here - send one message per POST' } }))
                    return
                }
                // A notification is taken and not answered, which over HTTP is 202.
                if (message.id === undefined || message.id === null) {
                    void answerTo(message).catch((e) => process.stderr.write(`source-rpc mcp: ${failureText(e)}\n`))
                    response.writeHead(202).end()
                    return
                }
                void answerTo(message)
                    .then((answer) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer })))
                    .catch((e) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: INTERNAL_ERROR, message: failureText(e) } })))
            })
        })
        await new Promise<void>((resolvePromise, rejectPromise) => {
            door!.on('error', rejectPromise)
            door!.listen(options.port, doorHost, () => resolvePromise())
        })
        process.stderr.write(`source-rpc mcp: streamable HTTP on ${doorHost}:${options.port} - a second client can attach here and sees the same scripts, fakes and watches as stdio.\n`)
        if (local && !options.doorToken)
            process.stderr.write('source-rpc mcp: the HTTP door has no token, so any process on this machine can drive this node. SOURCE_RPC_MCP_TOKEN is what gates it.\n')
        if (!local)
            // The console's warning, for the same widening.
            process.stderr.write(`source-rpc mcp: bound to ${doorHost}, so these tools are reachable from the network. Anyone with the token can call, script and fake through this node.\n`)
    }

    const close = async () => {
        process.stdin.removeAllListeners('data')
        if (door) await new Promise<void>((resolvePromise) => door!.close(() => resolvePromise()))
        // Before the network goes: a fake left running would hold a link this is about to drop.
        for (const fake of fakes.values()) await fake.close().catch(() => undefined)
        fakes.clear()
        // Scripts are separate processes, so they would outlive this one and go on holding peer
        // names nobody is serving. Stopped rather than orphaned.
        await scripting?.close()
        await connected.close()
    }
    // Not stdout: see the note at the top. A client learns what is here from initialize.
    process.stderr.write(`source-rpc mcp: ${options.name} on ${options.broker ?? ''}${options.broker && options.hub ? ' and ' : ''}${options.hub ?? ''}\n`)
    return { network, close, peers: online }
}
