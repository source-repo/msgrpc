#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHmacSigner, createHmacVerifier, namespaceProblems, readableNameFor, type MessageSigner, type MessageVerifier, type RpcSchema } from '@source-repo/msgrpc'
import { Diagnostic, extractSchema } from './extract.js'
import { startConsole } from './console.js'
import { startBroker } from './broker.js'
import { startMcp } from './mcp.js'
import { processOutput, runCall, runDescribe, runPeers, runWatch } from './verbs.js'
import { startFake, type FakeScript } from './fake.js'
import { replaySession, startRecording } from './record.js'
import { checkPeer, diffPeers } from './conform.js'

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

  diff      compare what two live peers expose, when one of them behaves differently
  serve     stand a peer up from a contract: answers every method, refuses what it would refuse
  record    write what the network is carrying to a file, until Ctrl-C
  replay    send a recording's calls at a peer and compare the answers

  peers                             who is on the network right now
  describe  <peer>                  what one peer exposes
  call      <peer> <ns.method> [a…] call it, and exit 1 if it refuses
  watch     <peer> <ns.event>       stream its events as jsonl until Ctrl-C

  extract / check
    --project <tsconfig.json>   default ./tsconfig.json
    --out <file>                default ./msgrpc.types.json   (extract)
    --against <file>            default ./msgrpc.types.json   (check)
    --keep-history              move the previous contract into history before writing
    --peer <name>               (check) ask a live peer what it serves instead of reading source
                                needs --broker or --hub

  diff <peerA> <peerB>
    --broker / --hub / --prefix / --timeout / --name / --sign as above
    --json                      machine-readable output

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

  serve
    --contract <file>           the contract to serve; every namespace in it is exposed
    --script <file>             canned returns, deliberate failures and events on a timer
    --fail <ns.method=Code>     answer with that RPC error code, repeatable
                                Timeout is the special one: the call is never answered at all
    --broker / --hub / --prefix / --timeout / --name / --sign as above

  record
    --out <file>                where to write the recording, as jsonl
    --peer <name>               only frames this peer sent or received
    --namespace <name>          only this namespace
    --no-payloads               leave arguments and results out
    --for <ms>                  stop after this long, instead of waiting for Ctrl-C

  replay <file>
    --against <peer>            send every call here, instead of to its original addressee
    --speed <n>                 higher is faster, default 1; 0 sends with no waiting
    --json                      machine-readable summary
                                exits 1 if any answer differed or any call failed

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
const VALUE_FLAGS = new Set([
    '--broker',
    '--hub',
    '--prefix',
    '--timeout',
    '--wait',
    '--name',
    '--sign',
    '--args',
    '--project',
    '--out',
    '--against',
    '--port',
    '--host',
    '--upstream',
    '--contract',
    '--script',
    '--fail',
    '--out',
    '--peer',
    '--namespace',
    '--for',
    '--against',
    '--speed'
])

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

/**
 * A stand-in built from a contract, so an HMI has something to talk to and a test has a device
 * willing to fail on request - which a real one is not.
 */
const runFake = async (argv: string[]) => {
    const contractPath = argument(argv, '--contract', '')
    if (!contractPath) {
        process.stderr.write('msgrpc serve: give it --contract <file>\n')
        process.exit(1)
    }
    let schema: RpcSchema
    try {
        schema = readSchema(resolve(contractPath))
    } catch (e) {
        process.stderr.write(`msgrpc serve: cannot read ${contractPath}: ${(e as Error).message}\n`)
        process.exit(1)
    }

    const scriptPath = argument(argv, '--script', '')
    let script: FakeScript = {}
    if (scriptPath) {
        try {
            script = JSON.parse(readFileSync(resolve(scriptPath), 'utf8')) as FakeScript
        } catch (e) {
            process.stderr.write(`msgrpc serve: cannot read ${scriptPath}: ${(e as Error).message}\n`)
            process.exit(1)
        }
    }
    // The shorthand for the same thing, since staging one failure is the common case and does not
    // deserve a file.
    for (const pair of argumentList(argv, '--fail')) {
        const equals = pair.indexOf('=')
        if (equals <= 0) {
            process.stderr.write(`msgrpc serve: --fail wants <namespace>.<method>=<Code>, got '${pair}'\n`)
            process.exit(1)
        }
        script = { ...script, fails: { ...script.fails, [pair.slice(0, equals)]: pair.slice(equals + 1) } }
    }

    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'serve', 'fake')
    const running = await startFake({ ...network, schema, ...(Object.keys(script).length ? { script } : {}) })
    process.stdout.write(`msgrpc serve: ${network.name} answering ${running.namespaces.join(', ')} from ${contractPath}\n`)
    // Anything calling this is talking to a stand-in. Worth one line, since a fake that is mistaken
    // for the device is worse than no fake at all.
    process.stderr.write('msgrpc serve: this is a fake. It answers from the contract, not from a device.\n')

    const stop = () =>
        void running
            .close()
            .then(() => process.exit(0))
            .catch(() => process.exit(1))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await new Promise(() => {})
}

/** Writes what the network is carrying to a file, so it can be replayed at something else later. */
const runRecord = async (argv: string[]) => {
    const out = argument(argv, '--out', '')
    if (!out) {
        process.stderr.write('msgrpc record: give it --out <file>\n')
        process.exit(1)
    }
    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'record', 'recorder')
    const peerFilter = argument(argv, '--peer', '')
    const namespaceFilter = argument(argv, '--namespace', '')
    // On by default here, where the tap has them off: a recording without arguments and results
    // cannot be replayed, which is the only reason to make one.
    const payloads = !argv.includes('--no-payloads')
    const running = await startRecording({
        ...network,
        out: resolve(out),
        filter: { payloads, ...(peerFilter ? { peer: peerFilter } : {}), ...(namespaceFilter ? { namespace: namespaceFilter } : {}), ttl: 3600 }
    })
    if (!running.sources.length) {
        process.stderr.write('msgrpc record: nothing here can watch traffic - no broker exposing a bus, and no --broker link.\n')
        await running.close()
        process.exit(1)
    }
    process.stdout.write(`msgrpc record: writing ${out}, watching via ${running.sources.join(', ')}\n`)
    if (payloads) process.stderr.write('msgrpc record: arguments and results are being written to the file. Use --no-payloads to leave them out.\n')

    const stop = () =>
        void running
            .close()
            .then(() => {
                process.stderr.write(`msgrpc record: ${running.frames()} frames\n`)
                process.exit(0)
            })
            .catch(() => process.exit(1))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    const forMs = Number(argument(argv, '--for', '0'))
    if (forMs > 0) setTimeout(stop, forMs)
    await new Promise(() => {})
}

/** Sends a recording's calls at a peer and compares the answers with the ones that were recorded. */
const runReplay = async (argv: string[]) => {
    const file = positionals(argv)[1]
    if (!file) {
        process.stderr.write('msgrpc replay: which recording?\n')
        return 1
    }
    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'replay', 'replayer')
    const json = argv.includes('--json')
    const against = argument(argv, '--against', '')

    let summary
    try {
        summary = await replaySession(
            { ...network, file: resolve(file), speed: Number(argument(argv, '--speed', '1')), ...(against ? { against } : {}) },
            json
                ? undefined
                : (call) => {
                      if (call.outcome === 'matched') return
                      const where = `${call.target} ${call.namespace}.${call.method}`
                      if (call.outcome === 'failed') process.stdout.write(`  ✗ ${where}: ${call.error}\n`)
                      else if (call.outcome === 'sent') process.stdout.write(`  · ${where}: sent, nothing recorded to compare\n`)
                      else process.stdout.write(`  ≠ ${where}: expected ${JSON.stringify(call.expected)}, got ${JSON.stringify(call.got)}\n`)
                  }
        )
    } catch (e) {
        process.stderr.write(`msgrpc replay: ${e instanceof Error ? e.message : String(e)}\n`)
        return 1
    }

    if (json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    else
        process.stdout.write(
            `msgrpc replay: ${summary.calls.length} call${summary.calls.length === 1 ? '' : 's'}, ` +
                `${summary.matched} matched, ${summary.differed} differed, ${summary.failed} failed, ${summary.sent} uncompared\n`
        )
    // An answer that differed is the finding this exists to produce, so it fails the command.
    return summary.differed || summary.failed ? 1 : 0
}

/**
 * The build-time check pointed at a device: is the box on the wall running the contract its callers
 * were built against?
 */
const runCheckPeer = async (argv: string[], peer: string) => {
    const against = resolve(argument(argv, '--against', 'msgrpc.types.json'))
    let stored: RpcSchema
    try {
        stored = readSchema(against)
    } catch {
        process.stderr.write(`msgrpc check: cannot read ${against}\n`)
        return 1
    }
    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'check', 'cli')
    let report
    try {
        report = await checkPeer({ ...network, peer, stored, wait: Number(argument(argv, '--wait', '5000')) })
    } catch (e) {
        process.stderr.write(`msgrpc check: ${e instanceof Error ? e.message : String(e)}\n`)
        return 1
    }

    if (argv.includes('--json')) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
        return report.problems.length || report.missing.length ? 1 : 0
    }
    for (const name of report.missing) process.stderr.write(`  ${name} is not served by ${peer}\n`)
    for (const problem of report.problems) process.stderr.write(`  ${problem.namespace}.${problem.where} ${problem.reason}\n`)
    // Said, and not counted as a pass: a peer running without a schema cannot be checked, and
    // reporting "no breaking changes" about one would be a lie of the most useful-sounding kind.
    for (const name of report.undescribed) process.stderr.write(`  ${name} is served without a contract, so nothing about it was checked\n`)

    const count = report.problems.length + report.missing.length
    if (count) {
        process.stderr.write(`msgrpc: ${count} breaking change${count === 1 ? '' : 's'} between ${against} and ${peer}\n`)
        return 1
    }
    process.stdout.write(`msgrpc: ${peer} serves ${report.checked.length ? report.checked.join(', ') : 'nothing'} compatibly with ${against}\n`)
    return 0
}

/** What two live peers offer differently, for when one cell behaves unlike the next. */
const runDiff = async (argv: string[]) => {
    const [, left, right] = positionals(argv)
    if (!left || !right) {
        process.stderr.write('msgrpc diff: give it two peers\n')
        return 1
    }
    const { signing: _keys, ...network } = resolveNetworkFlags(argv, 'diff', 'cli')
    let report
    try {
        report = await diffPeers({ ...network, left, right, wait: Number(argument(argv, '--wait', '5000')) })
    } catch (e) {
        process.stderr.write(`msgrpc diff: ${e instanceof Error ? e.message : String(e)}\n`)
        return 1
    }
    if (argv.includes('--json')) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
        return report.differences.length ? 1 : 0
    }
    if (!report.differences.length) {
        process.stdout.write(`msgrpc diff: ${left} and ${right} expose the same thing\n`)
        return 0
    }
    process.stdout.write(`${left}  vs  ${right}\n`)
    for (const difference of report.differences) {
        // Dotted for a method, spaced for the rest: `plant.read` is how you would say it, and
        // `plant.contract version` is not.
        const identifier = difference.member && /^[A-Za-z_$][\w$]*$/.test(difference.member)
        const what = difference.member ? `${difference.namespace}${identifier ? '.' : ' '}${difference.member}` : difference.namespace
        process.stdout.write(`\n  ${what}\n    ${left}: ${difference.left ?? '—'}\n    ${right}: ${difference.right ?? '—'}\n`)
    }
    // A difference is the finding, not a failure of the command - but an exit code lets a script
    // assert that two cells match.
    return 1
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
    if (command === 'serve') {
        void runFake(argv).catch(fail)
        return
    }
    if (command === 'diff') {
        void runDiff(argv)
            .then((code) => process.exit(code))
            .catch(fail)
        return
    }
    if (command === 'check' && argument(argv, '--peer', '')) {
        void runCheckPeer(argv, argument(argv, '--peer', ''))
            .then((code) => process.exit(code))
            .catch(fail)
        return
    }
    if (command === 'record') {
        void runRecord(argv).catch(fail)
        return
    }
    if (command === 'replay') {
        void runReplay(argv)
            .then((code) => process.exit(code))
            .catch(fail)
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
