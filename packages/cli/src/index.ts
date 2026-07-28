#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHmacSigner, createHmacVerifier, namespaceProblems, readableNameFor, type MessageSigner, type MessageVerifier, type RpcSchema } from '@source-repo/msgrpc'
import { Diagnostic, extractSchema } from './extract.js'
import { startConsole } from './console.js'
import { startBroker } from './broker.js'
import { startMcp } from './mcp.js'
import { processOutput, runCall, runDescribe, runPeers, runWatch } from './verbs.js'

/**
 * msgrpc extract  - read the contract out of TypeScript source and write it to a file
 * msgrpc check    - compare the source against a written contract and report breaking changes
 *
 * check is the one worth wiring into CI. It uses the same comparison the server uses at runtime,
 * so a change that would refuse an older peer is caught before it ships rather than when that peer
 * next calls.
 */

const usage = `msgrpc <command> [options]

  extract   write the contract described by the source to a file
  check     compare the source against a written contract and fail on a breaking change
  console   browse a live network in a browser: peers, what they expose, calls and events
  broker    run a WebSocket bus: relays between the peers that connect to it, until Ctrl-C
  mcp       serve the network to an MCP client over stdio: list peers, describe them, call them

  peers                             who is on the network right now
  describe  <peer>                  what one peer exposes
  call      <peer> <ns.method> [a…] call it, and exit 1 if it refuses
  watch     <peer> <ns.event>       stream its events as jsonl until Ctrl-C

  extract / check
    --project <tsconfig.json>   default ./tsconfig.json
    --out <file>                default ./msgrpc.types.json   (extract)
    --against <file>            default ./msgrpc.types.json   (check)
    --keep-history              move the previous contract into history before writing

  peers / describe / call / watch
    --broker <url>              an MQTT network, e.g. mqtt://localhost:1883
    --hub <url>                 a socket.io network, e.g. http://hub:8080
                                one of --broker and --hub is required; both watches both
    --prefix <topic>            topic namespace, default the transport's own
    --timeout <ms>              call timeout, default 10000
    --wait <ms>                 how long to wait for the peer to appear, default 5000
    --name <peer>               how it identifies itself, default cli-<three words>
    --sign <keyfile>            HMAC keys, for a signed network
    --json                      machine-readable output
    --args <json>               (call) the whole argument list as a JSON array, instead of words

  console
    --broker <url>              an MQTT network, e.g. mqtt://localhost:1883
    --hub <url>                 a socket.io network, e.g. http://hub:8080
                                one of --broker and --hub is required; both watches both
    --prefix <topic>            topic namespace, default the transport's own
    --port <n>                  default 7300
    --host <address>            default 127.0.0.1 - see the warning it prints before widening this
    --timeout <ms>              call timeout, default 10000
    --name <peer>               how the console identifies itself, default console-<three words>
    --sign <keyfile>            HMAC keys, so the console can talk to a signed network

  mcp
    --broker <url>              an MQTT network
    --hub <url>                 a socket.io network
                                one of --broker and --hub is required; both watches both
    --prefix <topic>            topic namespace, default the transport's own
    --timeout <ms>              call timeout, default 10000
    --name <peer>               how it identifies itself, default mcp-<three words>
    --sign <keyfile>            HMAC keys, for a signed network
                                stdio carries the protocol, so it is not for interactive use

  broker
    --port <n>                  default 8080, on every interface
    --name <peer>               how the broker identifies itself, default broker-<three words>
    --upstream <url>            join another broker, repeatable; the two become one network
    --quiet                     do not log peers arriving and leaving
`

const argument = (argv: string[], flag: string, fallback: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? fallback : (argv[index + 1] ?? fallback)
}

/** Every occurrence of a repeatable flag, so --upstream can be given more than once. */
const argumentList = (argv: string[], flag: string) =>
    argv.map((value, index) => (value === flag ? argv[index + 1] : undefined)).filter((value): value is string => !!value)

const DIAGNOSTIC_LIMIT = 25

const reportDiagnostics = (diagnostics: Diagnostic[]) => {
    for (const diagnostic of diagnostics.slice(0, DIAGNOSTIC_LIMIT)) {
        const at = diagnostic.file ? ` (${diagnostic.file}:${diagnostic.line})` : ''
        process.stderr.write(`  ${diagnostic.where} ${diagnostic.reason}${at}\n`)
    }
    // Named rather than silently dropped, so nobody reads a truncated list as the whole story.
    if (diagnostics.length > DIAGNOSTIC_LIMIT) process.stderr.write(`  … and ${diagnostics.length - DIAGNOSTIC_LIMIT} more\n`)
}

const readSchema = (path: string): RpcSchema => JSON.parse(readFileSync(path, 'utf8')) as RpcSchema

/** Rolls the stored contract into history, so a later run can tell what changed since. */
const withHistory = (next: RpcSchema, previous: RpcSchema | undefined): RpcSchema => {
    if (!previous) return next
    for (const [name, namespace] of Object.entries(next.namespaces)) {
        const before = previous.namespaces[name]
        if (!before?.version || before.version === namespace.version) continue
        const { history: _dropped, ...snapshot } = before
        namespace.history = { ...(before.history ?? {}), ...namespace.history, [before.version]: snapshot }
    }
    return next
}

/**
 * HMAC keys for the console, read from a file rather than a flag: a secret on the command line is
 * visible to anyone who can run ps.
 *
 *   { "name": "console-1", "secret": "…", "peers": { "plantServer": "…" } }
 *
 * `peers` is optional. Supplying it makes the console check signatures on what it receives too,
 * which means an unsigned peer's frames are then dropped.
 */
interface SigningKeys {
    name?: string
    secret: string
    peers?: { [peer: string]: string }
}

const readSigningKeys = (path: string, command: string) => {
    let keys: SigningKeys
    try {
        keys = JSON.parse(readFileSync(path, 'utf8')) as SigningKeys
    } catch (e) {
        process.stderr.write(`msgrpc ${command}: cannot read keys from ${path}: ${(e as Error).message}\n`)
        process.exit(1)
    }
    if (typeof keys.secret !== 'string' || !keys.secret) {
        process.stderr.write(`msgrpc ${command}: ${path} has no "secret"\n`)
        process.exit(1)
    }
    try {
        // Worth saying out loud: this file is the console's identity on the network.
        if (statSync(path).mode & 0o077) process.stderr.write(`msgrpc ${command}: ${path} is readable by other users\n`)
    } catch {
        // Not worth failing over if the mode cannot be read.
    }
    const sign: MessageSigner = createHmacSigner(keys.secret)
    const verify: MessageVerifier | undefined = keys.peers ? createHmacVerifier((peer) => keys.peers?.[peer]) : undefined
    return { keys, sign, verify }
}

/**
 * The flags every command that joins a network takes, read once.
 *
 * console, mcp and the one-shot verbs all need the same six, and the two checks that go with them:
 * that there is something to join at all, and that a --name does not contradict the name the key
 * file belongs to. A signed frame is checked against the key held for the name it claims, so a
 * process signing with one peer's key while calling itself another is refused - and refused as a
 * timeout, with nothing to say why. Better to stop here than to let that happen on a plant network.
 */
const resolveNetworkFlags = (argv: string[], command: string, defaultNamePrefix: string) => {
    const broker = argument(argv, '--broker', '')
    const hub = argument(argv, '--hub', '')
    if (!broker && !hub) {
        process.stderr.write(`msgrpc ${command}: give it --broker, --hub, or both\n`)
        process.exit(1)
    }
    const prefix = argument(argv, '--prefix', '')
    const keyFile = argument(argv, '--sign', '')
    const signing = keyFile ? readSigningKeys(keyFile, command) : undefined
    const requestedName = argument(argv, '--name', '')
    if (signing?.keys.name && requestedName && signing.keys.name !== requestedName) {
        process.stderr.write(`msgrpc ${command}: --name ${requestedName} does not match "${signing.keys.name}" in ${keyFile}\n`)
        process.exit(1)
    }
    return {
        ...(broker ? { broker } : {}),
        ...(hub ? { hub } : {}),
        ...(prefix ? { prefix } : {}),
        name: requestedName || signing?.keys.name || readableNameFor(defaultNamePrefix),
        callTimeout: Number(argument(argv, '--timeout', '10000')),
        ...(signing ? { sign: signing.sign, ...(signing.verify ? { verify: signing.verify } : {}) } : {}),
        signing
    }
}

/**
 * The words a command was given, with the flags and their values taken out.
 *
 * `msgrpc call plant plant.setpoint 1200 --hub http://bus --json` has to yield exactly
 * ['plant', 'plant.setpoint', '1200'], which means knowing which flags consume the word after them.
 */
const VALUE_FLAGS = new Set(['--broker', '--hub', '--prefix', '--timeout', '--wait', '--name', '--sign', '--args', '--project', '--out', '--against', '--port', '--host', '--upstream'])

const positionals = (argv: string[]) => {
    const words: string[] = []
    for (let index = 0; index < argv.length; index++) {
        const word = argv[index]
        if (word.startsWith('--')) {
            if (VALUE_FLAGS.has(word)) index++
            continue
        }
        words.push(word)
    }
    return words
}

/**
 * peers, describe, call and watch: the console's verbs for a shell rather than a browser.
 *
 * The exit code is the product. `msgrpc call` returning 1 when a device refuses is what lets a
 * smoke test be a line in a CI file rather than a program that parses output.
 */
const runVerb = async (command: string, argv: string[]) => {
    const flags = resolveNetworkFlags(argv, command, 'cli')
    const options = {
        ...flags,
        json: argv.includes('--json'),
        wait: Number(argument(argv, '--wait', '5000'))
    }
    // The command itself is the first word, and every verb takes at least a peer after it.
    const [, peer, target] = positionals(argv)

    if (command === 'peers') return await runPeers(options)

    if (!peer) {
        process.stderr.write(`msgrpc ${command}: which peer? Run 'msgrpc peers' to see who is there.\n`)
        return 1
    }
    if (command === 'describe') return await runDescribe(peer, options)

    if (!target) {
        process.stderr.write(`msgrpc ${command}: give it <namespace>.<${command === 'watch' ? 'event' : 'method'}>, e.g. plant.${command === 'watch' ? 'alarm' : 'writeSetpoint'}\n`)
        return 1
    }
    if (command === 'watch') {
        // Ctrl-C is how this one ends, and it has to end tidily: the subscription on the far side
        // outlives this process otherwise.
        const stopped = new Promise<void>((resolve) => {
            process.on('SIGINT', () => resolve())
            process.on('SIGTERM', () => resolve())
        })
        return await runWatch(peer, target, options, processOutput, stopped)
    }

    const rawArgs = argv.includes('--args') ? argument(argv, '--args', '[]') : undefined
    return await runCall(peer, target, positionals(argv).slice(3), { ...options, ...(rawArgs !== undefined ? { rawArgs } : {}) })
}

const runBroker = async (argv: string[]) => {
    const port = Number(argument(argv, '--port', '8080'))
    const upstream = argumentList(argv, '--upstream')
    const quiet = argv.includes('--quiet')
    const name = argument(argv, '--name', readableNameFor('broker'))

    const running = await startBroker({
        port,
        name,
        ...(upstream.length ? { upstream } : {}),
        ...(quiet ? {} : { onPeer: (peer, state, where) => process.stdout.write(`  ${state === 'online' ? '+' : '-'} ${peer} (${where})\n`) })
    }).catch((e: Error) => {
        // A port already taken is the ordinary way this fails, and it deserves a sentence.
        process.stderr.write(`msgrpc broker: cannot start on port ${port}: ${e.message}\n`)
        process.exit(1)
    })
    process.stdout.write(`msgrpc broker ${name} on port ${port}${upstream.length ? `, joined to ${upstream.join(', ')}` : ''}\n`)
    // It listens on every interface and forwards for whoever connects, without checking who they
    // are. Worth saying plainly rather than leaving to be discovered.
    process.stderr.write('msgrpc broker: relaying for any peer that connects, on every interface. Put it behind a network you trust.\n')
    // And now it will also show them everything it relays, if they ask. They could always have read
    // it by impersonating a peer; this is merely one call. Said out loud for the same reason.
    process.stderr.write('msgrpc broker: bus.tap() mirrors every frame crossing this broker to whoever calls it. Use authenticate to gate that.\n')

    // Catching matters most here: a shutdown that fails would otherwise reject unhandled, and the
    // process would die on that instead of exiting cleanly - and print nothing about why.
    const stop = () =>
        void running
            .close()
            .then(() => process.exit(0))
            .catch((e: unknown) => {
                process.stderr.write(`msgrpc: shutdown failed: ${e instanceof Error ? e.message : String(e)}\n`)
                process.exit(1)
            })
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    // Nothing else keeps this process alive; the listener does.
    await new Promise(() => {})
}

const runMcp = async (argv: string[]) => {
    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'mcp', 'mcp')
    const running = await startMcp(network)
    // Nothing is written to stdout here: it carries the protocol. See mcp.ts.
    const stop = () =>
        void running
            .close()
            .then(() => process.exit(0))
            .catch(() => process.exit(1))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    // The client closing the pipe is the ordinary way this ends.
    process.stdin.on('end', stop)
}

const runConsole = async (argv: string[]) => {
    const { signing, ...network } = resolveNetworkFlags(argv, 'console', 'console')
    const host = argument(argv, '--host', '127.0.0.1')

    const running = await startConsole({
        ...network,
        port: Number(argument(argv, '--port', '7300')),
        host
    })
    const watching = [network.broker, network.hub].filter(Boolean).join(' and ')
    process.stdout.write(`msgrpc console on ${running.url}, watching ${watching} as ${network.name}${signing ? ', signing frames' : ''}\n`)
    if (host !== '127.0.0.1' && host !== 'localhost')
        // Anyone who can reach it can invoke anything the console's own credentials permit.
        process.stderr.write(`msgrpc console: bound to ${host}, so it is reachable from the network. It can call any method it is allowed to.\n`)
    // Catching matters most here: a shutdown that fails would otherwise reject unhandled, and the
    // process would die on that instead of exiting cleanly - and print nothing about why.
    const stop = () =>
        void running
            .close()
            .then(() => process.exit(0))
            .catch((e: unknown) => {
                process.stderr.write(`msgrpc: shutdown failed: ${e instanceof Error ? e.message : String(e)}\n`)
                process.exit(1)
            })
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
}

const main = () => {
    const argv = process.argv.slice(2)
    const command = argv[0]
    const project = resolve(argument(argv, '--project', 'tsconfig.json'))

    // Both are long-running and async, so their rejections were unhandled: the process died on the
    // rejection itself, with a stack trace where a sentence belonged.
    const fail = (e: unknown) => {
        process.stderr.write(`msgrpc ${command}: ${e instanceof Error ? e.message : String(e)}\n`)
        process.exit(1)
    }
    if (command === 'broker') {
        void runBroker(argv).catch(fail)
        return
    }
    if (command === 'console') {
        void runConsole(argv).catch(fail)
        return
    }
    if (command === 'mcp') {
        void runMcp(argv).catch(fail)
        return
    }
    if (command === 'peers' || command === 'describe' || command === 'call' || command === 'watch') {
        // These end, and their exit code is the answer, so the process waits for one rather than
        // being kept alive by a listener the way console and broker are.
        void runVerb(command, argv)
            .then((code) => process.exit(code))
            .catch(fail)
        return
    }
    if (command !== 'extract' && command !== 'check') {
        process.stderr.write(usage)
        process.exit(command ? 1 : 0)
    }

    const { schema, diagnostics } = extractSchema(project)
    if (diagnostics.length) {
        // Refused rather than written with holes in it: a schema that degrades to `any` on the
        // parts it could not read still looks like protection while checking nothing.
        process.stderr.write(`msgrpc: ${diagnostics.length} type${diagnostics.length === 1 ? '' : 's'} could not be described\n`)
        reportDiagnostics(diagnostics)
        process.exit(1)
    }

    if (command === 'extract') {
        const out = resolve(argument(argv, '--out', 'msgrpc.types.json'))
        let previous: RpcSchema | undefined
        try {
            previous = readSchema(out)
        } catch {
            previous = undefined
        }
        const written = argv.includes('--keep-history') ? withHistory(schema, previous) : schema
        writeFileSync(out, JSON.stringify(written, null, 2) + '\n')
        const count = Object.keys(schema.namespaces).length
        process.stdout.write(`msgrpc: wrote ${count} namespace${count === 1 ? '' : 's'} to ${out}\n`)
        return
    }

    const against = resolve(argument(argv, '--against', 'msgrpc.types.json'))
    let stored: RpcSchema
    try {
        stored = readSchema(against)
    } catch {
        process.stderr.write(`msgrpc: cannot read ${against}\n`)
        process.exit(1)
        return
    }

    let breaking = 0
    for (const [name, before] of Object.entries(stored.namespaces)) {
        const now = schema.namespaces[name]
        if (!now) {
            process.stderr.write(`  ${name} is no longer served\n`)
            breaking++
            continue
        }
        // The same comparison the server applies to a caller declaring an older version.
        const problems = namespaceProblems(before, now, { ...stored.types, ...schema.types })
        for (const problem of problems) process.stderr.write(`  ${name}.${problem.where} ${problem.reason}\n`)
        breaking += problems.length
    }

    if (breaking) {
        process.stderr.write(`msgrpc: ${breaking} breaking change${breaking === 1 ? '' : 's'} against ${against}\n`)
        process.exit(1)
    }
    process.stdout.write(`msgrpc: no breaking changes against ${against}\n`)
}

main()
