#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHmacSigner, createHmacVerifier, namespaceProblems, type MessageSigner, type MessageVerifier, type RpcSchema } from '@source-repo/msgrpc'
import { Diagnostic, extractSchema } from './extract.js'
import { startConsole } from './console.js'

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

  extract / check
    --project <tsconfig.json>   default ./tsconfig.json
    --out <file>                default ./msgrpc.types.json   (extract)
    --against <file>            default ./msgrpc.types.json   (check)
    --keep-history              move the previous contract into history before writing

  console
    --broker <url>              required, e.g. mqtt://localhost:1883
    --prefix <topic>            topic namespace, default the transport's own
    --port <n>                  default 7300
    --host <address>            default 127.0.0.1 - see the warning it prints before widening this
    --timeout <ms>              call timeout, default 10000
    --name <peer>               how the console identifies itself, default msgrpc-console-<pid>
    --sign <keyfile>            HMAC keys, so the console can talk to a signed network
`

const argument = (argv: string[], flag: string, fallback: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? fallback : (argv[index + 1] ?? fallback)
}

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

const readSigningKeys = (path: string) => {
    let keys: SigningKeys
    try {
        keys = JSON.parse(readFileSync(path, 'utf8')) as SigningKeys
    } catch (e) {
        process.stderr.write(`msgrpc console: cannot read keys from ${path}: ${(e as Error).message}\n`)
        process.exit(1)
    }
    if (typeof keys.secret !== 'string' || !keys.secret) {
        process.stderr.write(`msgrpc console: ${path} has no "secret"\n`)
        process.exit(1)
    }
    try {
        // Worth saying out loud: this file is the console's identity on the network.
        if (statSync(path).mode & 0o077) process.stderr.write(`msgrpc console: ${path} is readable by other users\n`)
    } catch {
        // Not worth failing over if the mode cannot be read.
    }
    const sign: MessageSigner = createHmacSigner(keys.secret)
    const verify: MessageVerifier | undefined = keys.peers ? createHmacVerifier((peer) => keys.peers?.[peer]) : undefined
    return { keys, sign, verify }
}

const runConsole = async (argv: string[]) => {
    const broker = argument(argv, '--broker', '')
    if (!broker) {
        process.stderr.write('msgrpc console: --broker is required\n')
        process.exit(1)
    }
    const host = argument(argv, '--host', '127.0.0.1')
    const prefix = argument(argv, '--prefix', '')
    const keyFile = argument(argv, '--sign', '')
    const signing = keyFile ? readSigningKeys(keyFile) : undefined

    const requestedName = argument(argv, '--name', '')
    // A signed frame is checked against the key held for the name it claims, so a console signing
    // with one peer's key while calling itself another is refused - and refused as a timeout, with
    // nothing to say why. Better to stop here than to let that happen on a plant network.
    if (signing?.keys.name && requestedName && signing.keys.name !== requestedName) {
        process.stderr.write(`msgrpc console: --name ${requestedName} does not match "${signing.keys.name}" in ${keyFile}\n`)
        process.exit(1)
    }
    const name = requestedName || signing?.keys.name || `msgrpc-console-${process.pid}`

    const running = await startConsole({
        broker,
        ...(prefix ? { prefix } : {}),
        port: Number(argument(argv, '--port', '7300')),
        host,
        name,
        callTimeout: Number(argument(argv, '--timeout', '10000')),
        ...(signing ? { sign: signing.sign, ...(signing.verify ? { verify: signing.verify } : {}) } : {})
    })
    process.stdout.write(`msgrpc console on ${running.url}, watching ${broker} as ${name}${signing ? ', signing frames' : ''}\n`)
    if (host !== '127.0.0.1' && host !== 'localhost')
        // Anyone who can reach it can invoke anything the console's own credentials permit.
        process.stderr.write(`msgrpc console: bound to ${host}, so it is reachable from the network. It can call any method it is allowed to.\n`)
    const stop = () => void running.close().then(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
}

const main = () => {
    const argv = process.argv.slice(2)
    const command = argv[0]
    const project = resolve(argument(argv, '--project', 'tsconfig.json'))

    if (command === 'console') {
        void runConsole(argv)
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
