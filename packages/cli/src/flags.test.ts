import test from 'ava'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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

const attempt = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise) => {
        const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
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
