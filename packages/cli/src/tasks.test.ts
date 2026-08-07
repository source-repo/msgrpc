import test from 'ava'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAsync } from 'mqtt'
import { createHmacSigner, createHmacVerifier, defaultSecureWebPort, defaultWebPort, RpcClient, RpcServer, type RpcSchema } from '@source-repo/rpc'
import { connectNetwork } from './network.js'
import { consolePortFor, parseTaskFile, startTaskFile, taskFileSkeleton, type ConsoleTask, type StartedTask } from './tasks.js'

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

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'
const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}
let haveBroker = false
test.before(async () => {
    haveBroker = await brokerAvailable()
    if (!haveBroker && process.env.SOURCE_RPC_REQUIRE_BROKER)
        throw new Error(`SOURCE_RPC_REQUIRE_BROKER is set, but no MQTT broker answered at ${BROKER_URL} - these tests must not be skipped here`)
})
const skipWithoutBroker = (t: { pass: (m?: string) => void }) => {
    if (!haveBroker) t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
    return !haveBroker
}

/** A GET that trusts exactly this certificate, which is what proves the server really is serving TLS. */
const getOverTls = (url: string, ca: Buffer) =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const call = request(url, { ca }, (response) => {
            let body = ''
            response.on('data', (chunk) => (body += chunk))
            response.on('end', () => resolve({ status: response.statusCode, body }))
        })
        call.on('error', reject)
        call.end()
    })

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

test('credentials a bus checks are refused in a file that only presents them', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({
            version: 1,
            network: { hub: 'http://localhost:7590' },
            tasks: [{ id: 'console', type: 'console', auth: { token: 'presented', tokens: { 'a-token': 'someone' } } }]
        })
    )
    t.regex(failure.message, /auth\."tokens" belongs to the bus/)
})

test('an mqtt block with no account is refused, because it would silently disable the environment', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({ version: 1, network: { broker: 'mqtt://localhost:1883', mqtt: {} }, tasks: [{ id: 'console', type: 'console' }] })
    )
    t.regex(failure.message, /network\.mqtt needs a username, a password, or both/)
})

test('inline keys are validated the same way a key file is', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({
            version: 1,
            network: { broker: 'mqtt://localhost:1883' },
            tasks: [{ id: 'console', type: 'console', sign: { name: 'hostConsole', peers: { controller: 'their-secret' } } }]
        })
    )
    t.regex(failure.message, /tasks\[0\]\.sign has no "secret"/)
})

test('a task that gives its identity two names is refused before it can announce either', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-name-'))
    const file = join(directory, 'mismatch.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7594' },
            tasks: [{ id: 'console', type: 'console', name: 'calledThis', sign: { name: 'butSignsAsThis', secret: 'a-secret' } }]
        })
    )
    const failure = await t.throwsAsync(startTaskFile(file))
    t.regex(failure.message, /name "calledThis" does not match "butSignsAsThis"/)
    rmSync(directory, { recursive: true, force: true })
})

test('two tasks cannot be one peer, whichever way they were named', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-clash-'))
    const file = join(directory, 'clash.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7594' },
            tasks: [
                { id: 'first', type: 'console', name: 'hostPeer' },
                { id: 'second', type: 'node', sign: { name: 'hostPeer', secret: 'a-secret' }, scripts: '.', scriptableBy: ['controller'] }
            ]
        })
    )
    const failure = await t.throwsAsync(startTaskFile(file))
    t.regex(failure.message, /starts more than one peer named "hostPeer"/)
    rmSync(directory, { recursive: true, force: true })
})

test('a task with no bus to join is a startup error rather than a peer that never appears', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-nowhere-'))
    const file = join(directory, 'nowhere.tasks.json')
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 'console', type: 'console' }] }))
    const failure = await t.throwsAsync(startTaskFile(file))
    t.regex(failure.message, /task "console": network needs broker, hub, or both/)
    rmSync(directory, { recursive: true, force: true })
})

/**
 * The mode check has always guarded key files. Moving the secrets into the task file has to move the
 * check with them, or the convenience quietly costs the warning.
 */
test('a task file that carries its own secrets is checked for its mode, and one that points at files is not', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-mode-'))
    const file = join(directory, 'secrets.tasks.json')
    // No network, so preparing the task fails immediately - after the file itself has been read and
    // checked, which is the part under test.
    const write = (sign: unknown) => writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 'console', type: 'console', sign }] }))

    write({ name: 'hostConsole', secret: 'in-this-file' })
    chmodSync(file, 0o644)
    const warnings: string[] = []
    await t.throwsAsync(startTaskFile(file, { warning: (warning) => warnings.push(warning) }))
    t.true(warnings.some((warning) => warning.includes('carries secrets and is readable by other users')))

    write('console-keys.json')
    writeFileSync(join(directory, 'console-keys.json'), JSON.stringify({ name: 'hostConsole', secret: 'in-that-file' }))
    chmodSync(join(directory, 'console-keys.json'), 0o600)
    const second: string[] = []
    await t.throwsAsync(startTaskFile(file, { warning: (warning) => second.push(warning) }))
    t.false(second.some((warning) => warning.includes('carries secrets')))
    rmSync(directory, { recursive: true, force: true })
})

test('the generated task file is one the strict parser accepts, with a secret of its own per role', (t) => {
    const skeleton = taskFileSkeleton({ broker: 'mqtt://bus:1883', controller: 'bench' })
    const parsed = parseTaskFile(JSON.parse(JSON.stringify(skeleton)))
    t.is(parsed.network?.broker, 'mqtt://bus:1883')

    const secrets = parsed.tasks.map((task) => (typeof task.sign === 'object' ? task.sign.secret : undefined))
    t.is(secrets.filter(Boolean).length, parsed.tasks.length)
    t.is(new Set(secrets).size, parsed.tasks.length, 'roles that share a secret are one identity wearing three names')

    const node = parsed.tasks.find((task) => task.type === 'node')
    t.deepEqual(node?.type === 'node' ? node.scriptableBy : [], ['bench'])

    const names = parsed.tasks.map((task) => (typeof task.sign === 'object' ? task.sign.name : undefined))
    for (const task of parsed.tasks) {
        const keys = typeof task.sign === 'object' ? task.sign : undefined
        // Every role knows the controller, or a file generated for a scriptable node produces one
        // that refuses the only peer it exists to serve.
        t.true(!!keys?.peers?.bench, `${keys?.name} does not know bench`)
        // And knows the others by the names they actually announce. A secret filed under a name
        // nobody answers to verifies nothing, and looks exactly like a network that is wired up.
        t.deepEqual(
            Object.keys(keys?.peers ?? {}).sort(),
            [...names.filter((name) => name !== keys?.name), 'bench'].sort(),
            `${keys?.name} knows peers that are not here`
        )
    }
})

test('two generated files share no secrets', (t) => {
    const secretsOf = (skeleton: ReturnType<typeof taskFileSkeleton>) =>
        skeleton.tasks.flatMap((task) => [task.sign.secret, ...Object.values(task.sign.peers)])
    const first = new Set(secretsOf(taskFileSkeleton()))
    t.is(secretsOf(taskFileSkeleton()).filter((secret) => first.has(secret)).length, 0)
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

/**
 * The claim this feature is worth having only if it keeps: three roles in one process are still
 * three peers, each signing with a secret of its own. Written against a broker because MQTT is where
 * a signature is the only evidence of who a caller is - a hub at least knows which socket spoke.
 */
test('a task file joins an MQTT broker with a separate signed identity for every role', async (t) => {
    if (skipWithoutBroker(t)) return
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-mqtt-'))
    const scripts = join(directory, 'scripts')
    mkdirSync(scripts)
    writeFileSync(join(directory, 'host.types.json'), JSON.stringify(schema))
    writeFileSync(join(directory, 'host.script.json'), JSON.stringify({ returns: { 'host.ping': 'pong' } }))

    const secrets = { node: `node-${run}`, serve: `serve-${run}`, controller: `controller-${run}` }
    const knowsController = { [peer('controller')]: secrets.controller }
    const prefix = `msgrpc/tasks-${run}`
    const file = join(directory, 'mqtt.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { broker: BROKER_URL, prefix, timeout: 8000 },
            tasks: [
                {
                    id: 'node',
                    type: 'node',
                    sign: { name: peer('mqttNode'), secret: secrets.node, peers: knowsController },
                    scripts: './scripts',
                    scriptableBy: [peer('controller')]
                },
                {
                    id: 'serve',
                    type: 'serve',
                    sign: { name: peer('mqttServe'), secret: secrets.serve, peers: knowsController },
                    contract: './host.types.json',
                    script: './host.script.json'
                }
            ]
        })
    )

    const warnings: string[] = []
    const tasks = await startTaskFile(file, { warning: (warning) => warnings.push(warning) })
    const theirSecrets: { [name: string]: string } = { [peer('mqttNode')]: secrets.node, [peer('mqttServe')]: secrets.serve }
    const controller = await connectNetwork({
        broker: BROKER_URL,
        prefix,
        name: peer('controller'),
        callTimeout: 8000,
        sign: createHmacSigner(secrets.controller),
        verify: createHmacVerifier((from) => theirSecrets[from])
    })

    try {
        for (const name of [peer('mqttNode'), peer('mqttServe')]) await waitFor(() => controller.network.peers.names().includes(name))
        t.is(await (await controller.network.proxy<{ ping(): Promise<string> }>('host', peer('mqttServe'))).ping(), 'pong')
        const described = await (
            await controller.network.proxy<{ describe(): Promise<{ namespaces: { name: string }[] }> }>('msgrpc', peer('mqttNode'))
        ).describe()
        t.true(described.namespaces.some((namespace) => namespace.name === 'scripting'))
        // Signed, so the unsigned-MQTT warning is not one of the things it said.
        t.false(warnings.some((warning) => warning.includes('unsigned MQTT')))
    } finally {
        await controller.close()
        await tasks.close()
        rmSync(directory, { recursive: true, force: true })
    }
})

/**
 * `derive` without anything to present it to is the shape that looks configured and is not: the node
 * mints credentials, and the bus it hands them to was never told to check any.
 */
test('a node that mints credentials with nothing to present them to says so', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-derive-'))
    const file = join(directory, 'derive.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7594' },
            tasks: [
                { id: 'node', type: 'node', auth: { derive: `mint-${run}` }, scripts: '.', scriptableBy: ['controller'] },
                { id: 'stops-here', type: 'serve', contract: './no-such-contract.json' }
            ]
        })
    )
    const warnings: string[] = []
    // The second task has no contract, so reading the file fails - after the first was prepared,
    // which is where a credential nothing will check is meant to be reported.
    await t.throwsAsync(startTaskFile(file, { warning: (warning) => warnings.push(warning) }))
    t.true(warnings.some((warning) => warning.includes("task \"node\": 'derive' is set but no credential of this peer's own is")))
    rmSync(directory, { recursive: true, force: true })
})

test('a certificate and its key go together, so a console cannot be started that answers nobody', (t) => {
    const failure = t.throws(() =>
        parseTaskFile({
            version: 1,
            network: { hub: 'http://localhost:7590' },
            tasks: [{ id: 'console', type: 'console', cert: './cert.pem' }]
        })
    )
    t.regex(failure.message, /tasks\[0\]\.cert and tasks\[0\]\.key go together; got only cert/)
})

/**
 * Asserted rather than bound. Standing a listener on 8844 to prove the default would make this test
 * fail whenever anything else on the machine holds the well-known port - a console someone left
 * running is enough, which is exactly the thing a default port is for.
 */
test('a certificate moves the default port to the encrypted one, and an explicit port still wins', (t) => {
    const task: ConsoleTask = { id: 'console', type: 'console' }
    t.is(consolePortFor(task, false), defaultWebPort)
    t.is(consolePortFor(task, true), defaultSecureWebPort)
    t.is(consolePortFor({ ...task, port: 9000 }, true), 9000)
})

/**
 * The migration this closes: a host serving a TLS console could not move to a task file without
 * quietly becoming plain HTTP, because a file saying nothing about certificates is a valid file.
 */
test('a console task given a certificate serves https', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-task-tls-'))
    const certPath = join(directory, 'cert.pem')
    const keyPath = join(directory, 'key.pem')
    execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
        // openssl narrates its key generation on stderr, which is a page of dots per test.
        { stdio: 'ignore' }
    )

    const file = join(directory, 'tls.tasks.json')
    writeFileSync(
        file,
        JSON.stringify({
            version: 1,
            network: { hub: 'http://127.0.0.1:7596' },
            tasks: [{ id: 'console', type: 'console', name: peer('tlsTaskConsole'), port: 7597, cert: './cert.pem', key: './key.pem' }]
        })
    )

    const hub = new RpcServer({ name: peer('tlsTaskHub'), transports: [{ port: 7596, host: '127.0.0.1' }] })
    await hub.ready()
    const tasks = await startTaskFile(file)

    try {
        t.is(tasks.tasks[0].url, 'https://127.0.0.1:7597', 'the started line has to print the url that actually works')
        const identity = await getOverTls(`${tasks.tasks[0].url!}/console.json`, readFileSync(certPath))
        t.is(identity.status, 200)
        t.is((JSON.parse(identity.body) as { name: string }).name, peer('tlsTaskConsole'))
    } finally {
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
