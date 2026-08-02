import test from 'ava'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptRunner, deleteScript, environmentFor, listScripts, nodeArgvFor, readScript, saveScript, scriptFile } from './scripts.js'

/**
 * Scripts kept in a directory and run as processes of their own.
 *
 * What is worth testing is the part that would be dangerous or baffling if it were wrong: that a
 * name cannot climb out of the directory, that a stopped script still says why it stopped, and that
 * a script is handed the network rather than left to invent one.
 */

const directory = () => mkdtempSync(join(tmpdir(), 'source-rpc-scripts-'))

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

test('a name that would climb out of the directory is refused', (t) => {
    const dir = directory()
    for (const name of ['../escape', 'a/b', '..', '.hidden', '']) {
        t.throws(() => saveScript(dir, name, 'console.log(1)'), undefined, name)
    }
})

test('a script is TypeScript unless it asks not to be, and rewriting it changes the file', (t) => {
    const dir = directory()

    t.true(saveScript(dir, 'pump', 'const bar: number = 1\nconsole.log(bar)').endsWith('pump.ts'))
    t.deepEqual(listScripts(dir), [{ name: 'pump', language: 'ts' }])

    // Saved again as plain JavaScript: the old file goes, or scriptFile would keep finding the .ts.
    t.true(saveScript(dir, 'pump', 'console.log(1)', 'mjs').endsWith('pump.mjs'))
    t.deepEqual(listScripts(dir), [{ name: 'pump', language: 'mjs' }])
    t.true(scriptFile(dir, 'pump').endsWith('pump.mjs'))
    t.false(existsSync(join(dir, 'pump.ts')))
})

test('a saved script can be read back and deleted', (t) => {
    const dir = directory()
    saveScript(dir, 'watcher', 'console.log("hello")')
    t.is(readScript(dir, 'watcher').trim(), 'console.log("hello")')
    deleteScript(dir, 'watcher')
    t.deepEqual(listScripts(dir), [])
    t.throws(() => readScript(dir, 'watcher'), { message: /no script called 'watcher'/ })
})

test('an empty or missing directory lists nothing rather than failing', (t) => {
    t.deepEqual(listScripts(join(tmpdir(), 'source-rpc-does-not-exist-' + Date.now())), [])
})

test('TypeScript gets the flag only on the versions that need it', (t) => {
    // Type stripping arrived in 22.6 behind a flag and became the default in 23.6. Passing the flag
    // to a newer Node is a warning; passing it to an older one is an error about an unknown option.
    t.deepEqual(nodeArgvFor('/s/a.ts', '24.0.0'), ['/s/a.ts'])
    t.deepEqual(nodeArgvFor('/s/a.ts', '23.6.0'), ['/s/a.ts'])
    t.deepEqual(nodeArgvFor('/s/a.ts', '23.5.0'), ['--experimental-strip-types', '/s/a.ts'])
    t.deepEqual(nodeArgvFor('/s/a.ts', '22.6.0'), ['--experimental-strip-types', '/s/a.ts'])
    t.throws(() => nodeArgvFor('/s/a.ts', '22.5.0'), { message: /cannot run TypeScript directly/ })
    // Plain JavaScript never needs either.
    t.deepEqual(nodeArgvFor('/s/a.mjs', '20.0.0'), ['/s/a.mjs'])
})

test('the network is handed over as environment, and the node keeps its own credential', (t) => {
    const environment = environmentFor({
        broker: 'mqtt://plant:1883',
        hub: 'http://bus:7843',
        prefix: 'cell/v2',
        name: 'x',
        callTimeout: 1000,
        hubCredentials: { token: 's3cret' }
    })

    t.deepEqual(environment, { SOURCE_RPC_BROKER: 'mqtt://plant:1883', SOURCE_RPC_HUB: 'http://bus:7843', SOURCE_RPC_PREFIX: 'cell/v2' })
    // The property, stated as an assertion rather than left to the deepEqual above: the node's own
    // token never reaches a script's environment. It used to, and a token is pinned to one peer
    // name - so it was useless to the script and a leak of the node's identity at the same time.
    t.false('SOURCE_RPC_TOKEN' in environment)
    t.false(JSON.stringify(environment).includes('s3cret'))

    // Nothing invented for a network that named nothing.
    t.deepEqual(environmentFor({ name: 'x', callTimeout: 1000 }), {})
})

test('a script is started with a credential of its own, minted per run', async (t) => {
    const dir = directory()
    saveScript(dir, 'whoami', 'console.log(`${process.env.SOURCE_RPC_NAME} ${process.env.SOURCE_RPC_TOKEN}`)', 'mjs')

    const minted: string[] = []
    const runner = new ScriptRunner(dir, {}, async (script) => {
        minted.push(script)
        return { name: `${script}-peer`, token: `token-for-${script}-${minted.length}` }
    })

    await runner.start('whoami')
    await waitFor(() => !!runner.status('whoami')?.ended)
    t.deepEqual(runner.status('whoami')?.output, ['whoami-peer token-for-whoami-1'], 'the script sees the name it must use and the credential for it')

    // Minted per start rather than once per node: a second run gets a second credential, which is
    // what makes a short lifetime and revocation-by-not-renewing mean anything.
    await runner.start('whoami')
    await waitFor(() => runner.status('whoami')?.output?.[0] === 'whoami-peer token-for-whoami-2')
    t.deepEqual(minted, ['whoami', 'whoami'])

    await runner.stopAll()
})

test('a node that cannot mint starts the script without a credential rather than lending its own', async (t) => {
    const dir = directory()
    saveScript(dir, 'bare', 'console.log(`name=${process.env.SOURCE_RPC_NAME ?? "none"} token=${process.env.SOURCE_RPC_TOKEN ?? "none"}`)', 'mjs')
    const runner = new ScriptRunner(dir, { SOURCE_RPC_HUB: 'http://bus:7843' })

    await runner.start('bare')
    await waitFor(() => !!runner.status('bare')?.ended)
    t.deepEqual(runner.status('bare')?.output, ['name=none token=none'], 'no credential is honest; borrowing the node\'s would not be')
})

test('a script runs as its own process, reads the environment, and its output is kept', async (t) => {
    const dir = directory()
    saveScript(dir, 'greet', 'console.log("hub is " + process.env.SOURCE_RPC_HUB)\nconsole.error("to stderr")', 'mjs')
    const runner = new ScriptRunner(dir, { SOURCE_RPC_HUB: 'http://bus:7843' })

    const started = await runner.start('greet')
    t.truthy(started.pid)
    await waitFor(() => !!runner.status('greet')?.ended)

    const record = runner.status('greet')!
    t.true(record.output.includes('hub is http://bus:7843'))
    // stderr is marked, so a model reading the output can tell a complaint from a result.
    t.true(record.output.includes('! to stderr'))
    t.is(record.ended?.code, 0)

    await runner.stopAll()
})

test('a TypeScript script runs directly, with no build step', async (t) => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 6)) {
        t.pass(`node ${process.versions.node} cannot strip types - skipped`)
        return
    }
    const dir = directory()
    // The reason TypeScript is the default here: a script gets the same types as the rest of the repo.
    saveScript(dir, 'typed', 'const bar: number = 42\nconsole.log(`bar is ${bar}`)')
    const runner = new ScriptRunner(dir)

    await runner.start('typed')
    await waitFor(() => !!runner.status('typed')?.ended)

    t.is(runner.status('typed')?.ended?.code, 0)
    t.true(runner.status('typed')!.output.includes('bar is 42'))

    await runner.stopAll()
})

test('a script that keeps running is stopped, and says that it was', async (t) => {
    const dir = directory()
    saveScript(dir, 'forever', 'setInterval(() => {}, 1000)\nconsole.log("up")', 'mjs')
    const runner = new ScriptRunner(dir)

    await runner.start('forever')
    await waitFor(() => (runner.status('forever')?.output.length ?? 0) > 0)
    t.true(runner.isRunning('forever'))

    await runner.stop('forever')
    t.false(runner.isRunning('forever'))
    // Remembered rather than forgotten: "it stopped, and here is the last thing it said" is the
    // answer somebody wants after the process is gone.
    t.truthy(runner.status('forever')?.ended)
    t.true(runner.status('forever')!.output.includes('up'))
})

test('a script that exits badly reports its code and its complaint', async (t) => {
    const dir = directory()
    saveScript(dir, 'broken', 'console.error("no broker configured")\nprocess.exit(3)', 'mjs')
    const runner = new ScriptRunner(dir)

    await runner.start('broken')
    await waitFor(() => !!runner.status('broken')?.ended)

    t.is(runner.status('broken')?.ended?.code, 3)
    t.true(runner.status('broken')!.output.includes('! no broker configured'))
})

test('starting one twice is refused rather than quietly running two', async (t) => {
    const dir = directory()
    saveScript(dir, 'twice', 'setInterval(() => {}, 1000)', 'mjs')
    const runner = new ScriptRunner(dir)

    await runner.start('twice')
    // Two processes under one peer name would displace each other on the network, and the second
    // start would look like it worked.
    await t.throwsAsync(runner.start('twice'), { message: /already running/ })

    await runner.stopAll()
    t.false(runner.isRunning('twice'))
})

test('starting one that is not there says so', async (t) => {
    const runner = new ScriptRunner(directory())
    await t.throwsAsync(runner.start('absent'), { message: /no script called 'absent'/ })
})

test('a script the runner writes is a file you can also run by hand', (t) => {
    const dir = directory()
    const file = saveScript(dir, 'byhand', 'console.log(1)', 'mjs')
    // Nothing clever in the file: the point of a process per script is that it is an ordinary program.
    t.is(readFileSync(file, 'utf8'), 'console.log(1)\n')
})
