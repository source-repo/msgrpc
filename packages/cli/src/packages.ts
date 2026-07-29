import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The dependencies a script directory is allowed to import.
 *
 * A script is an ordinary Node program, so sooner or later one wants something off the registry -
 * a date library, a CSV parser, a driver for the thing on the other end of the serial port. Without
 * this the only answer is "leave the conversation and run npm yourself", which is the wrong shape
 * for a directory a model is otherwise managing end to end.
 *
 * **This is not a new grant.** `--scripts` already permits arbitrary Node processes, and a script
 * could `child_process.exec('npm i …')` on its own. Putting it behind a second flag would be theatre;
 * what a tool buys is that the model *declares* what it wants, where it can be seen in the tool log
 * and in a committed package.json, rather than doing it sideways.
 *
 * What is worth defending against is different: **installing a package runs code from the registry
 * that nobody reviewed.** So installs pass `--ignore-scripts` by default, which is the setting that
 * stops a postinstall hook from being the attack. A package that genuinely needs one - anything with
 * a native build - has to ask, and the asking is visible.
 */

/** How long an install may take before it is abandoned. A cold cache on a slow link is the case to allow for. */
const INSTALL_BUDGET_MS = 180_000

/**
 * The manifest a script directory needs anyway.
 *
 * `type: module` is the load-bearing field: a `.ts` script uses `import`, and Node decides whether
 * that is legal from the nearest package.json. Inside a CommonJS project there is one, it does not
 * say module, and every run then prints a reparse warning that lands in the script's own output.
 * `private` because this is a directory of programs, not something anybody publishes.
 */
export const ensureManifest = (directory: string) => {
    const file = join(resolve(directory), 'package.json')
    if (existsSync(file)) return file
    writeFileSync(file, `${JSON.stringify({ name: 'source-rpc-scripts', private: true, type: 'module' }, null, 2)}\n`, 'utf8')
    return file
}

const manifest = (directory: string): { dependencies?: { [name: string]: string } } => {
    const file = join(resolve(directory), 'package.json')
    if (!existsSync(file)) return {}
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: { [name: string]: string } }
    } catch {
        return {}
    }
}

/** What is declared, and what is actually on disk - which differ when an install failed halfway. */
export const listPackages = (directory: string) =>
    Object.entries(manifest(directory).dependencies ?? {})
        .map(([name, range]) => {
            const installed = join(resolve(directory), 'node_modules', name, 'package.json')
            let version: string | undefined
            try {
                version = (JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }).version
            } catch {
                version = undefined
            }
            return { name, range, ...(version ? { installed: version } : { installed: null }) }
        })
        .sort((a, b) => a.name.localeCompare(b.name))

/**
 * A package name a shell would not reinterpret.
 *
 * The spec reaches npm as one argv element rather than through a shell, so this is not quoting - it
 * is refusing the shapes that are not package specs at all: a flag that would change what npm does,
 * or a path that would install something off disk.
 */
const SAFE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~*><=|\s-]+)?$/i

/**
 * npm's own JavaScript entry point, run by the Node already running this - not the `npm` shim.
 *
 * On Windows the shim is `npm.cmd`, and since the fix for CVE-2024-27980 Node refuses to spawn a
 * `.cmd` without `shell: true`. Turning the shell on would be worse than the problem: a version
 * range is a legitimate part of a package spec and `>`, `<`, `|` and `^` are all permitted in one,
 * which is ordinary text to `execFile` and metacharacters to `cmd.exe`. Reaching past the shim to
 * the script it would have run keeps arguments as argv on every platform, which is the only version
 * of this that is safe by construction rather than by quoting.
 *
 * Exported for the test, which checks both layouts without needing the other operating system.
 */
export const npmEntryPoint = (execPath = process.execPath, platform: NodeJS.Platform = process.platform) => {
    const here = dirname(execPath)
    // Windows keeps npm beside node; the POSIX layout puts it under ../lib. Both are the standard
    // install, and nvm, Volta and the Alpine image all follow whichever one their platform uses.
    const candidates =
        platform === 'win32'
            ? [join(here, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
            : [join(here, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(here, '..', 'npm', 'bin', 'npm-cli.js')]
    return candidates.find((candidate) => existsSync(candidate))
}

const npm = (directory: string, args: string[]) =>
    new Promise<{ ok: boolean; output: string }>((done) => {
        const entry = npmEntryPoint()
        if (!entry)
            return done({
                ok: false,
                output: 'npm could not be found next to this Node, so packages cannot be managed from here. Install one alongside the other, or add the dependency by hand.'
            })
        execFile(
            process.execPath,
            [entry, ...args],
            { cwd: resolve(directory), timeout: INSTALL_BUDGET_MS, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const output = `${stdout}${stderr}`.trim()
                if (!error) return done({ ok: true, output })
                done({ ok: false, output: output || error.message })
            }
        )
    })

export const addPackage = async (directory: string, spec: string, allowInstallScripts = false) => {
    if (!SAFE_SPEC.test(spec)) throw new Error(`'${spec}' is not a package name. Give it \`lodash\` or \`@scope/name@^2\`, not a flag or a path.`)
    ensureManifest(directory)
    // --ignore-scripts unless asked: an install hook is code from the registry running here, and it
    // is the part of `npm install` that is not about files at all.
    return await npm(directory, ['install', '--save', ...(allowInstallScripts ? [] : ['--ignore-scripts']), spec])
}

export const removePackage = async (directory: string, name: string) => {
    if (!SAFE_SPEC.test(name)) throw new Error(`'${name}' is not a package name.`)
    return await npm(directory, ['uninstall', '--save', name])
}
