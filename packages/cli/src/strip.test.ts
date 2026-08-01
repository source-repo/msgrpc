import test from 'ava'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcClient, RpcServer } from '@source-repo/rpc'
import { stripSource } from './strip.js'

/**
 * The decorator stripper: the same @rpc marks extraction reads, re-said as runtime calls, so a
 * script written the natural way can be run by a Node that cannot parse a decorator.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const DECORATED = `import { rpc, rpcNamespace, RpcServer, type RpcInvocationHandle } from '@source-repo/rpc'

@rpcNamespace('desk', { version: '1.2.0' })
export class FrontDesk {
    @rpc({ semantics: 'query', injectInvocation: true })
    async say(from: string, text: string, invocation?: RpcInvocationHandle) {
        return { claimed: from, actual: invocation?.context.identity?.name ?? invocation?.context.source, text }
    }

    @rpc
    async ping() {
        return 'pong'
    }

    private helper() {
        return 'never exposed'
    }
}
`

test('stripping removes the decorators, keeps every line number, and appends the runtime marks', (t) => {
    const outcome = stripSource(DECORATED, 'desk.ts')
    t.deepEqual(outcome.problems, [])
    t.is(outcome.stripped, 3)

    t.false(outcome.output.includes('@rpc'), 'no decorator survives')
    t.regex(outcome.output, /__rpcNamespace\(FrontDesk, 'desk', \{ version: '1\.2\.0' \}\)/)
    t.regex(outcome.output, /__rpcMethods\(FrontDesk, \{ say: \{ semantics: 'query', injectInvocation: true \}, ping: \{\} \}\)/)

    // Line numbers must not move: a stack trace from the twin has to read against the source.
    const before = DECORATED.split('\n')
    const after = outcome.output.split('\n')
    t.is(after[before.indexOf('export class FrontDesk {') ?? -1]?.trim(), 'export class FrontDesk {')
    const sayLine = before.findIndex((line) => line.includes('async say('))
    t.true(after[sayLine].includes('async say('), 'the method sits exactly where it did')
})

test('what strip cannot faithfully re-mark is refused, never guessed at', (t) => {
    const foreign = stripSource(`declare const seal: any\nclass X { @seal m() {} }`, 'foreign.ts')
    t.is(foreign.stripped, 0)
    t.regex(foreign.problems[0].reason, /not a decorator this library defines/)

    const anonymous = stripSource(`import { rpcNamespace } from '@source-repo/rpc'\nexport default @rpcNamespace('x') class { }`, 'anon.ts')
    t.true(anonymous.problems.some((problem) => /anonymous class/.test(problem.reason)))

    const nested = stripSource(`import { rpc } from '@source-repo/rpc'\nconst make = () => { class Inner { @rpc async m() {} } return Inner }`, 'nested.ts')
    t.true(nested.problems.some((problem) => /strip cannot re-mark/.test(problem.reason)), JSON.stringify(nested.problems))

    const clean = stripSource(`export const answer = 42\n`, 'clean.ts')
    t.is(clean.stripped, 0)
    t.is(clean.output, `export const answer = 42\n`)
})

test('the stripped twin runs under plain node, and the handle still names the real caller', async (t) => {
    const hub = new RpcServer({ name: peer('hub3859'), transports: [{ port: 3859, host: '127.0.0.1' }] })
    await hub.ready()

    // The twin is written next to dist so its import of @source-repo/rpc resolves through the
    // repository's node_modules, exactly as a scripts directory's would through its own.
    const here = dirname(fileURLToPath(import.meta.url))
    const scratch = mkdtempSync(join(here, 'strip-run-'))
    const script = `${DECORATED}
const server = new RpcServer({ name: '${peer('stripped3859')}', transports: [{ connect: 'http://localhost:3859' }] })
server.exposeClassInstance(new FrontDesk())
await server.ready()
console.log('serving')
`
    const outcome = stripSource(script, 'desk.ts')
    t.deepEqual(outcome.problems, [])
    writeFileSync(join(scratch, 'desk.ts'), outcome.output)

    // Plain node, no flags: this is the exact invocation that died on the '@' before.
    const child = spawn(process.execPath, [join(scratch, 'desk.ts')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const failed: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => failed.push(chunk))
    try {
        await new Promise<void>((resolveStarted, rejectStarted) => {
            child.stdout.setEncoding('utf8')
            child.stdout.on('data', (chunk: string) => chunk.includes('serving') && resolveStarted())
            child.on('exit', () => rejectStarted(new Error(`the twin exited before serving:\n${failed.join('')}`)))
            setTimeout(() => rejectStarted(new Error(`the twin never came up:\n${failed.join('')}`)), 15000).unref()
        })

        const client = new RpcClient('http://localhost:3859', { name: peer('honest3859'), defaultTarget: peer('stripped3859') })
        const desk = await client.proxy<{ say(from: string, text: string): Promise<{ claimed: string; actual?: string }>; ping(): Promise<string> }>('desk')
        const answer = await desk.say('somebody-important', 'still there?')
        t.is(answer.claimed, 'somebody-important')
        t.is(answer.actual, peer('honest3859'), 'injectInvocation survived the strip: the routed caller decides')
        t.is(await desk.ping(), 'pong')
        await client.close()
    } finally {
        child.kill()
        rmSync(scratch, { recursive: true, force: true })
        await hub.close()
    }
})
