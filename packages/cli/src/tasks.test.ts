import test from 'ava'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcClient, RpcServer, type RpcSchema } from '@source-repo/rpc'
import { parseTaskFile, startTaskFile, type StartedTask } from './tasks.js'

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 10000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        host: {
            methods: { ping: { params: [], returns: { kind: 'string' } } },
            events: {}
        }
    }
}

test('task files reject misspelled fields instead of ignoring intent', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({
            version: 1,
            network: { broker: 'mqtt://localhost:1883' },
            tasks: [{ id: 'node', type: 'node', scripts: './scripts', scriptableBy: ['controller'], scritpableBy: ['typo'] }]
        })
    )
    t.regex(failure.message, /tasks\[0\].*unknown field "scritpableBy"/)
})

test('task ids are unique because they name startup and failure reports', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({
            version: 1,
            network: { hub: 'http://localhost:7590' },
            tasks: [
                { id: 'host', type: 'console' },
                { id: 'host', type: 'serve', contract: 'host.types.json' }
            ]
        })
    )
    t.regex(failure.message, /duplicate task id "host"/)
})

test('one task file starts console, node and serve roles with paths relative to itself', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-tasks-'))
    const scripts = join(directory, 'scripts')
    mkdirSync(scripts)
    writeFileSync(join(directory, 'host.types.json'), JSON.stringify(schema))
    writeFileSync(join(directory, 'host.script.json'), JSON.stringify({ returns: { 'host.ping': 'pong' } }))
    const file = join(directory, 'host.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7590', timeout: 4000 },
            tasks: [
                { id: 'console', type: 'console', name: peer('taskConsole'), port: 7591 },
                { id: 'node', type: 'node', name: peer('taskNode'), scripts: './scripts', scriptableBy: [peer('controller')] },
                { id: 'serve', type: 'serve', name: peer('taskServe'), contract: './host.types.json', script: './host.script.json' }
            ]
        })
    )

    const hub = new RpcServer({ name: peer('taskHub'), transports: [{ port: 7590, host: '127.0.0.1' }] })
    await hub.ready()
    const started: StartedTask[] = []
    const warnings: string[] = []
    const tasks = await startTaskFile(file, { started: (task) => started.push(task), warning: (warning) => warnings.push(warning) })
    const caller = new RpcClient('http://127.0.0.1:7590', { name: peer('controller'), callTimeout: 4000, readyTimeout: 10000 })
    await caller.ready()

    try {
        for (const name of [peer('taskConsole'), peer('taskNode'), peer('taskServe')]) {
            await waitFor(() => caller.peers.names().includes(name))
            t.pass(`${name} appeared`)
        }

        t.deepEqual(
            started.map(({ id, type }) => ({ id, type })),
            [
                { id: 'console', type: 'console' },
                { id: 'node', type: 'node' },
                { id: 'serve', type: 'serve' }
            ]
        )
        t.deepEqual(tasks.tasks, started)
        t.true(warnings.some((warning) => warning.includes('serve is a fake')))

        const described = await (await caller.proxy<{ describe(): Promise<{ namespaces: { name: string }[] }> }>('msgrpc', peer('taskNode'))).describe()
        t.true(described.namespaces.some((namespace) => namespace.name === 'scripting'))
        t.is(await (await caller.proxy<{ ping(): Promise<string> }>('host', peer('taskServe'))).ping(), 'pong')
        t.is((await fetch('http://127.0.0.1:7591')).status, 200)
    } finally {
        await caller.close()
        await tasks.close()
        await hub.close()
        rmSync(directory, { recursive: true, force: true })
    }
})

test('a later startup failure closes roles that already started', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-rollback-'))
    const file = join(directory, 'rollback.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7592' },
            tasks: [
                { id: 'first', type: 'console', name: peer('firstConsole'), port: 7593 },
                { id: 'second', type: 'console', name: peer('secondConsole'), port: 7593 }
            ]
        })
    )
    const hub = new RpcServer({ name: peer('rollbackHub'), transports: [{ port: 7592, host: '127.0.0.1' }] })
    await hub.ready()

    const failure = await t.throwsAsync(startTaskFile(file))
    t.regex(failure.message, /task "second" failed to start.*EADDRINUSE/)

    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(7593, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await hub.close()
    rmSync(directory, { recursive: true, force: true })
})
