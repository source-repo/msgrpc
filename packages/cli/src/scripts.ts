import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { NetworkOptions } from './network.js'
import { ensureManifest } from './packages.js'

/**
 * A directory of peers that are kept rather than typed again.
 *
 * `start_fake` answers calls from a contract, which is the two-minute answer and is gone when the
 * conversation ends. A script is the other thing: a real program using the client package, living in
 * a file, that can drive a sequence, poll a device and log what it sees, bridge two networks, or
 * stand up a simulator far past what a method body can hold. It is written once and started again
 * next week.
 *
 * **Each script is its own process.** That is the whole design decision. It means a script can
 * `import` whatever it likes and be run by hand with `node` as easily as through a tool; it means a
 * script that throws, leaks or wedges cannot take the server down with it; and it means starting and
 * stopping are a spawn and a kill rather than a module cache to reason about.
 *
 * It also means a script is **arbitrary code with the privileges of whoever started this server** -
 * more than the sandboxed handlers in handlers.ts, not less. `--scripts <dir>` is what permits it,
 * absent by default, and the directory says exactly where the writing is allowed to happen.
 *
 * TypeScript is the default, because this library's whole idea is that a class is the contract: a
 * script that says `import type { Pump } from '../plant.js'` gets the same typed proxy the rest of
 * the codebase does, which is most of the reason to write one here rather than curl a socket. Node
 * runs it directly - see `nodeArgvFor` for which versions, and `.mjs` for the ones that cannot.
 */

/** Scripts are named, not pathed. A name that could climb out of the directory is refused. */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** TypeScript first; `.mjs` for a Node too old to run it, or an author who would rather not. */
export const SCRIPT_EXTENSIONS = ['.ts', '.mjs'] as const
export type ScriptLanguage = 'ts' | 'mjs'

/** Recent output per script, so a model can read what one printed without a terminal. Bounded, since a chatty script must not grow without limit. */
const KEPT_LINES = 200

const assertUsable = (name: string) => {
    if (!SAFE_SCRIPT_NAME.test(name)) throw new Error(`'${name}' is not a usable script name`)
}

/** Where a script of this language would be written. Proven to stay inside the directory. */
export const scriptPath = (directory: string, name: string, language: ScriptLanguage = 'ts') => {
    assertUsable(name)
    const file = resolve(join(directory, `${name}.${language}`))
    // Proven to stay inside rather than assumed to, the same way contracts and console assets are.
    if (!file.startsWith(resolve(directory) + sep)) throw new Error(`'${name}' would write outside the scripts directory`)
    return file
}

/** The file a saved script actually occupies, whichever language it was written in. */
export const scriptFile = (directory: string, name: string) => {
    assertUsable(name)
    for (const extension of SCRIPT_EXTENSIONS) {
        const file = scriptPath(directory, name, extension.slice(1) as ScriptLanguage)
        if (existsSync(file)) return file
    }
    throw new Error(`no script called '${name}' in the scripts directory`)
}

export const saveScript = (directory: string, name: string, source: string, language: ScriptLanguage = 'ts') => {
    const file = scriptPath(directory, name, language)
    mkdirSync(resolve(directory), { recursive: true })
    // Written on the way past, because a `.ts` script using `import` inside a CommonJS project makes
    // Node warn on every run, and that warning lands in the script's own output.
    ensureManifest(directory)
    // The other language's file goes, so a script rewritten as TypeScript does not leave a stale
    // .mjs behind for scriptFile to find first.
    for (const other of SCRIPT_EXTENSIONS) {
        const candidate = scriptPath(directory, name, other.slice(1) as ScriptLanguage)
        if (candidate !== file && existsSync(candidate)) rmSync(candidate)
    }
    writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`, 'utf8')
    return file
}

export const readScript = (directory: string, name: string) => readFileSync(scriptFile(directory, name), 'utf8')

export const deleteScript = (directory: string, name: string) => rmSync(scriptFile(directory, name))

export const listScripts = (directory: string) => {
    try {
        return readdirSync(resolve(directory))
            .filter((file) => (SCRIPT_EXTENSIONS as readonly string[]).includes(extname(file)))
            .map((file) => ({ name: file.slice(0, -extname(file).length), language: extname(file).slice(1) as ScriptLanguage }))
            .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
        // Not yet created is not an error: it is an empty directory that costs nothing to report.
        return []
    }
}

/**
 * What this Node needs in order to run that file.
 *
 * Type stripping landed behind `--experimental-strip-types` in 22.6 and became the default in 23.6,
 * so the flag is passed only where it is both needed and understood - passing it to 24 is a warning,
 * and passing it to 22.5 is an error about an unknown option rather than about TypeScript.
 */
export const nodeArgvFor = (file: string, version = process.versions.node) => {
    if (extname(file) !== '.ts') return [file]
    const [major = 0, minor = 0] = version.split('.').map(Number)
    if (major > 23 || (major === 23 && minor >= 6)) return [file]
    if (major > 22 || (major === 22 && minor >= 6)) return ['--experimental-strip-types', file]
    throw new Error(
        `this Node (v${version}) cannot run TypeScript directly - it arrived in 22.6. Save the script as .mjs, or run the server on a newer Node.`
    )
}

/**
 * The network this server is on, handed to a script as environment.
 *
 * So a script does not hardcode a broker url that is right on one machine and wrong on the next -
 * and so a model writing one has something to read rather than a value to invent. The names match
 * the flags they came from.
 *
 * **This deliberately no longer hands over the node's own token.** It used to, and that was wrong
 * twice: a token is pinned to exactly one peer name, so a script could not authenticate under its
 * own name with it anyway, and passing it put the node's credential in the environment of an
 * arbitrary program - which, for a program an AI wrote, is precisely the thing the boundary work
 * exists to prevent. A script that must authenticate is given a credential of its own, minted for
 * it and expiring on its own schedule; see `ScriptRunner`'s `credentialFor`.
 */
export const environmentFor = (options: NetworkOptions): { [key: string]: string } => ({
    ...(options.broker ? { SOURCE_RPC_BROKER: options.broker } : {}),
    ...(options.hub ? { SOURCE_RPC_HUB: options.hub } : {}),
    ...(options.prefix ? { SOURCE_RPC_PREFIX: options.prefix } : {})
})

export interface RunningScript {
    name: string
    pid?: number
    startedAt: number
    /** Set once it has ended, so a stopped script reports why rather than merely being absent. */
    ended?: { code: number | null; signal: string | null; at: number }
    output: string[]
}

/** Starts, stops and remembers the scripts this server is running. */
export class ScriptRunner {
    private running = new Map<string, { child: ChildProcess; record: RunningScript }>()
    private finished = new Map<string, RunningScript>()

    constructor(
        private directory: string,
        private environment: { [key: string]: string } = {},
        /**
         * Mints the credential this script will connect with, when the node can. Called once per
         * start, so each run gets its own short-lived credential rather than sharing one - and a
         * node that cannot mint simply starts the script without one, which is honest: the script
         * then reaches whatever an unauthenticated peer may reach, and nothing more.
         */
        private credentialFor?: (script: string) => Promise<{ name: string; token: string } | undefined>
    ) {}

    isRunning(name: string) {
        return this.running.has(name)
    }

    async start(name: string) {
        if (this.running.has(name)) throw new Error(`'${name}' is already running. Stop it first.`)
        const file = scriptFile(this.directory, name)
        const argv = nodeArgvFor(file)

        // Minted per start, before the process exists, so the credential is never written anywhere
        // the script could have read it from earlier.
        const credential = await this.credentialFor?.(name)

        const record: RunningScript = { name, startedAt: Date.now(), output: [] }
        const child = spawn(process.execPath, argv, {
            // The script's own directory, so a relative import in it means what its author meant and
            // `@source-repo/rpc` resolves from the project the directory sits in.
            cwd: resolve(this.directory),
            env: {
                ...process.env,
                ...this.environment,
                // The name is handed over with the credential, because a derived credential is
                // pinned to one peer name: a script that picks its own would be refused by the bus
                // rather than mysteriously ignored.
                ...(credential ? { SOURCE_RPC_NAME: credential.name, SOURCE_RPC_TOKEN: credential.token } : {})
            },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        record.pid = child.pid ?? undefined

        const keep = (prefix: string) => (line: string) => {
            record.output.push(`${prefix}${line}`)
            if (record.output.length > KEPT_LINES) record.output.splice(0, record.output.length - KEPT_LINES)
        }
        if (child.stdout) createInterface({ input: child.stdout }).on('line', keep(''))
        if (child.stderr) createInterface({ input: child.stderr }).on('line', keep('! '))

        child.on('exit', (code, signal) => {
            record.ended = { code, signal, at: Date.now() }
            this.running.delete(name)
            // Kept rather than dropped: "it stopped, and here is the last thing it said" is the
            // answer somebody wants, and it is gone if the record goes with the process.
            this.finished.set(name, record)
        })
        child.on('error', (e) => keep('! ')(`could not start: ${e.message}`))

        this.running.set(name, { child, record })
        return record
    }

    async stop(name: string) {
        const entry = this.running.get(name)
        if (!entry) throw new Error(`'${name}' is not running here.`)
        entry.child.kill()
        // A script that ignores SIGTERM is not allowed to hold the server open indefinitely.
        const ended = new Promise<void>((done) => entry.child.once('exit', () => done()))
        const forced = new Promise<void>((done) =>
            setTimeout(() => {
                entry.child.kill('SIGKILL')
                done()
            }, 2000).unref()
        )
        await Promise.race([ended, forced])
        this.running.delete(name)
        return entry.record
    }

    status(name: string) {
        return this.running.get(name)?.record ?? this.finished.get(name)
    }

    all(): RunningScript[] {
        return [...[...this.running.values()].map((entry) => entry.record), ...this.finished.values()]
    }

    async stopAll() {
        for (const name of [...this.running.keys()]) await this.stop(name).catch(() => undefined)
    }
}
