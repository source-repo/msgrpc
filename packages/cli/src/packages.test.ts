import test from 'ava'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPackage, ensureManifest, listPackages, npmEntryPoint, removePackage, versionSkewLine } from './packages.js'
import { saveScript } from './scripts.js'

/**
 * Dependencies for a script directory.
 *
 * The install tests reach the network, so they are skipped without one - the rest is the part that
 * has to hold regardless: what is refused, and what the manifest says.
 */

const directory = () => mkdtempSync(join(tmpdir(), 'source-rpc-packages-'))

const online = async () => {
    try {
        const response = await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(4000) })
        return response.ok
    } catch {
        return false
    }
}

test('the manifest says type module, because a .ts script uses import', (t) => {
    const dir = directory()
    const file = ensureManifest(dir)
    const written = JSON.parse(readFileSync(file, 'utf8')) as { type?: string; private?: boolean }

    // Without this, Node inside a CommonJS project warns on every run and the warning lands in the
    // script's own output.
    t.is(written.type, 'module')
    t.true(written.private)
})

test('an existing manifest is left alone', (t) => {
    const dir = directory()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mine', type: 'module', dependencies: { zod: '^3' } }))
    ensureManifest(dir)

    const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies: object }
    t.is(written.name, 'mine')
    t.deepEqual(written.dependencies, { zod: '^3' })
})

test('saving a script creates the manifest on the way past', (t) => {
    const dir = directory()
    saveScript(dir, 'first', 'console.log(1)')
    t.true(existsSync(join(dir, 'package.json')))
})

test("npm is reached through its own script, so Windows never spawns a .cmd", (t) => {
    // Node refuses to spawn a .cmd without a shell since the fix for CVE-2024-27980, and turning the
    // shell on would be worse: `>`, `<`, `|` and `^` are all legal in a version range and all
    // metacharacters to cmd.exe. Running npm-cli.js with this Node keeps every argument as argv.
    //
    // Both layouts are built under a temp directory, so this tests the lookup rather than whatever
    // is installed on the machine running it. The first version of this asserted that a made-up
    // `C:\Program Files\nodejs` path found nothing - which is true on Linux and false on a Windows
    // runner, where that directory is exactly where Node lives.
    const root = mkdtempSync(join(tmpdir(), 'source-rpc-npm-'))

    // Windows keeps npm beside node.exe.
    const windowsCli = join(root, 'win', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(join(root, 'win', 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(windowsCli, '')
    t.is(npmEntryPoint(join(root, 'win', 'node.exe'), 'win32'), windowsCli)

    // The POSIX layout puts it under ../lib from the bin directory.
    const posixCli = join(root, 'posix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(join(root, 'posix', 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
    mkdirSync(join(root, 'posix', 'bin'), { recursive: true })
    writeFileSync(posixCli, '')
    t.is(npmEntryPoint(join(root, 'posix', 'bin', 'node'), 'linux'), posixCli)

    // Nothing there is nothing found, rather than a path that does not exist.
    t.is(npmEntryPoint(join(root, 'nowhere', 'node.exe'), 'win32'), undefined)

    // And on this machine it resolves to a script rather than a shell wrapper.
    const found = npmEntryPoint()
    t.truthy(found, 'npm should be resolvable next to the node running these tests')
    t.regex(String(found), /npm-cli\.js$/)
    t.notRegex(String(found), /\.cmd$/)

    rmSync(root, { recursive: true, force: true })
})

test('anything that is not a package name is refused', async (t) => {
    const dir = directory()
    // Not quoting - the spec reaches npm as one argv element. These are refused because they are not
    // package specs at all: a flag would change what npm does, a path would install off disk.
    for (const spec of ['--global', '-g', '../evil', '/etc/passwd', 'file:../thing', 'https://example.com/x.tgz', '']) {
        await t.throwsAsync(addPackage(dir, spec), { message: /is not a package name/ }, spec)
    }
    await t.throwsAsync(removePackage(dir, '--save-dev'), { message: /is not a package name/ })
})

test('ordinary package specs are accepted by the guard', async (t) => {
    const dir = directory()
    // Refused for reaching npm, not for their shape - which is what this asserts, since npm is not
    // called when the guard throws.
    for (const spec of ['zod', 'date-fns@^3', '@scope/name', '@scope/name@1.2.3']) {
        const failure = await addPackage(dir, spec).then(
            () => undefined,
            (e: Error) => e
        )
        t.true(failure === undefined || !/is not a package name/.test(failure.message), spec)
    }
})

test('nothing declared is nothing listed', (t) => {
    t.deepEqual(listPackages(directory()), [])
})

test('a declared package is listed with what is actually on disk', (t) => {
    const dir = directory()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { absent: '^1' } }))

    // Declared but not installed is the state a half-finished install leaves, and it is worth being
    // able to see rather than guess at.
    t.deepEqual(listPackages(dir), [{ name: 'absent', range: '^1', installed: null }])
})

test('a package is installed, listed and removed', async (t) => {
    // A real install over the network, which ava's ten-second inactivity timeout is not written for:
    // a slow registry stalls the whole run rather than this one test. Given its own budget instead.
    t.timeout(120_000)
    if (!(await online())) {
        t.pass('no registry reachable - skipped')
        return
    }
    const dir = directory()

    const added = await addPackage(dir, 'is-odd@3.0.1')
    t.true(added.ok, added.output)
    const listed = listPackages(dir)
    t.is(listed.length, 1)
    t.is(listed[0].name, 'is-odd')
    t.is(listed[0].installed, '3.0.1')

    const removed = await removePackage(dir, 'is-odd')
    t.true(removed.ok, removed.output)
    t.deepEqual(listPackages(dir), [])
})

test('a script can import what was installed for it', async (t) => {
    // A real install over the network, which ava's ten-second inactivity timeout is not written for:
    // a slow registry stalls the whole run rather than this one test. Given its own budget instead.
    t.timeout(120_000)
    if (!(await online())) {
        t.pass('no registry reachable - skipped')
        return
    }
    const dir = directory()
    await addPackage(dir, 'is-odd@3.0.1')
    saveScript(dir, 'uses-it', 'import isOdd from "is-odd"\nconsole.log("odd?", isOdd(3))', 'mjs')

    const { ScriptRunner } = await import('./scripts.js')
    const runner = new ScriptRunner(dir)
    await runner.start('uses-it')
    const deadline = Date.now() + 15000
    while (!runner.status('uses-it')?.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))

    // The whole point of the directory having its own manifest: cwd is the scripts directory, so
    // node resolves the dependency from the node_modules sitting next to the script.
    t.true(runner.status('uses-it')!.output.includes('odd? true'), runner.status('uses-it')!.output.join('\n'))
    await runner.stopAll()
})

test('versionSkewLine names both majors, prefers what is installed, and stays quiet on a match', (t) => {
    const scripts = directory()

    // Nothing there yet: nothing to compare, nothing to say.
    t.is(versionSkewLine(scripts, 'mcp'), undefined)

    // Declared old, nothing installed: the declaration is the only evidence, and it is enough.
    writeFileSync(join(scripts, 'package.json'), JSON.stringify({ private: true, dependencies: { '@source-repo/rpc': '^3.4.1' } }))
    const declared = versionSkewLine(scripts, 'mcp')
    t.truthy(declared)
    t.regex(declared!, /\^3\.4\.1/)
    t.regex(declared!, /3\.x API/)
    t.regex(declared!, /^source-rpc mcp:/)

    // Installed outranks declared: the manifest still says ^3, but what the scripts actually import
    // is the current major, so there is nothing to warn about. Read the same source the helper
    // compares against - the library's manifest, not the CLI's - so this holds even if the
    // versions-together rule ever bends.
    const ours = (createRequire(import.meta.url)('@source-repo/rpc/package.json') as { version: string }).version
    mkdirSync(join(scripts, 'node_modules', '@source-repo', 'rpc'), { recursive: true })
    writeFileSync(join(scripts, 'node_modules', '@source-repo', 'rpc', 'package.json'), JSON.stringify({ name: '@source-repo/rpc', version: ours }))
    t.is(versionSkewLine(scripts, 'mcp'), undefined)

    // And the other way round: an old install under a freshly edited manifest still skews.
    writeFileSync(join(scripts, 'node_modules', '@source-repo', 'rpc', 'package.json'), JSON.stringify({ name: '@source-repo/rpc', version: '3.4.1' }))
    writeFileSync(join(scripts, 'package.json'), JSON.stringify({ private: true, dependencies: { '@source-repo/rpc': `^${ours}` } }))
    const installed = versionSkewLine(scripts, 'node')
    t.truthy(installed)
    t.regex(installed!, /3\.4\.1/)
    t.regex(installed!, /^source-rpc node:/)

    rmSync(scripts, { recursive: true, force: true })
})
