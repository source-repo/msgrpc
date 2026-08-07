import test from 'ava'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/**
 * A flag given no value.
 *
 * `source-rpc mcp --hub http://localhost:7843 --scripts --contracts` is two flags and no directory
 * between them, and it used to start: `--scripts` took the literal string `--contracts` as its
 * directory, and `--contracts`, now the last word on the line, found nothing after it and fell back
 * to its default, which switched it off. The server then offered script tools writing to a
 * directory named `--contracts`, offered no contract tools at all, and said nothing about either.
 *
 * The real cost was not the wrong directory - it was that every symptom pointed somewhere else, and
 * three restarts went by before the command line itself was suspected. So this is checked through
 * the built binary rather than against the parser: what has to hold is that the process refuses to
 * start, which is the only part a user sees.
 */

const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'index.js')

const attempt = (args: string[], cwd?: string) =>
    new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise) => {
        const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
        let stderr = ''
        let stdout = ''
        child.stderr.setEncoding('utf8')
        child.stdout.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => (stderr += chunk))
        child.stdout.on('data', (chunk: string) => (stdout += chunk))
        child.on('close', (code) => resolvePromise({ code, stderr, stdout }))
        // Nothing here should reach a network, but a regression that starts the server anyway would
        // otherwise hang the suite rather than fail it.
        setTimeout(() => child.kill(), 10000).unref()
    })

test('a flag whose value is the next flag is refused, naming both', async (t) => {
    const { code, stderr } = await attempt(['mcp', '--hub', 'http://localhost:7843', '--scripts', '--contracts', './contracts'])
    t.is(code, 1)
    t.regex(stderr, /--scripts needs a value/)
    t.regex(stderr, /'--contracts' is another flag/)
})

test('a flag at the end of the line with nothing after it is refused', async (t) => {
    const { code, stderr } = await attempt(['peers', '--hub'])
    t.is(code, 1)
    t.regex(stderr, /--hub needs a value, and nothing follows it/)
})

test('a repeatable flag is held to the same rule', async (t) => {
    const { code, stderr } = await attempt(['node', '--scripts', './scripts', '--scriptable-by', '--broker', 'mqtt://localhost:1883'])
    t.is(code, 1)
    t.regex(stderr, /--scriptable-by needs a value/)
})

/**
 * The refusal is a sentence. These flags are read before any promise exists - `--project` before
 * the command is even dispatched - so without a catch at the entry point the same mistake arrived
 * as an unhandled exception and a stack trace.
 */
test('the refusal is a line of text rather than a stack trace', async (t) => {
    const { stderr, stdout } = await attempt(['peers', '--hub'])
    t.false(stderr.includes('at '), stderr)
    t.false(stderr.includes('Error:'), stderr)
    t.is(stdout, '', 'nothing about a usage error belongs on stdout')
})

/**
 * The default task file, and the line it is deliberately *not* allowed to cross.
 *
 * Defaulting the filename removes the part that varies. Defaulting the command would mean the bare
 * word `source-rpc` - what someone types to read the help - joining a bus under whatever identities
 * happen to be in this directory. So the empty command still prints usage, and mentions the file
 * instead of running it.
 */
test('run with no file uses the default, and says what to do when there is none', async (t) => {
    const empty = mkdtempSync(join(tmpdir(), 'source-rpc-default-'))
    try {
        const missing = await attempt(['run'], empty)
        t.is(missing.code, 1)
        t.regex(missing.stderr, /no source-rpc\.tasks\.json here, and no task file named/)
        t.regex(missing.stderr, /--init/, 'the refusal has to name the thing to do next')

        // --init with no filename writes the same default, so the pair needs no argument at all.
        const written = await attempt(['run', '--init'], empty)
        t.is(written.code, 0)
        t.true(existsSync(join(empty, 'source-rpc.tasks.json')))

        // And now `run` finds it. It fails on the broker rather than the file, which is the proof:
        // it got as far as trying to join a network the skeleton points at and nothing is serving.
        const found = await attempt(['run'], empty)
        t.is(found.code, 1)
        t.notRegex(found.stderr, /no source-rpc\.tasks\.json here/)
    } finally {
        rmSync(empty, { recursive: true, force: true })
    }
})

test('the bare command prints usage and points at a task file rather than starting it', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-bare-'))
    try {
        writeFileSync(join(directory, 'source-rpc.tasks.json'), '{}')
        const { code, stderr } = await attempt([], directory)
        t.is(code, 0)
        t.regex(stderr, /source-rpc <command>/, 'the bare command still answers with the usage')
        t.regex(stderr, /there is a source-rpc\.tasks\.json here: 'source-rpc run' starts it/)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('--version answers with both versions, before anything else is parsed', async (t) => {
    for (const flag of ['--version', '-v', 'version']) {
        const { code, stdout } = await attempt([flag])
        t.is(code, 0)
        t.regex(stdout, /^source-rpc \d+\.\d+\.\d+ \(@source-repo\/rpc \d+\.\d+\.\d+\)\n$/, `for ${flag}`)
    }
})
