import test from 'ava'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { connectAsync } from 'mqtt'
import { writeFileSync } from 'node:fs'
import { createDerivedAuthenticator, createHmacSigner, createHmacVerifier, createTokenAuthenticator, mintDerivedCredential, MqttTransport, RpcServer } from '@source-repo/rpc'
import { ScriptingService, scriptingAuthorizer } from './scripting.js'
import { ScriptRunner, saveScript } from './scripts.js'

const waitForCondition = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitForCondition timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

/**
 * Scripting one node from another.
 *
 * The happy path is the smaller half of this. What is worth testing is the rule: a call over RPC is
 * refused unless the caller is authenticated *and* named, so that forgetting the guard, or running
 * on a transport that cannot prove a name, fails closed rather than open.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const scriptsDir = () => mkdtempSync(join(tmpdir(), 'source-rpc-scripting-'))

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

const waitFor = async (condition: () => boolean | Promise<boolean>, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

/** A node offering scripting to the peers it names, the way a bench machine would be set up. */
const nodeOffering = async (port: number, allow: string[], tokens: { [token: string]: string }) => {
    const directory = scriptsDir()
    const scripting = new ScriptingService({ directory, allow })
    const server = new RpcServer({
        name: peer(`node${port}`),
        transports: [{ port }],
        authenticate: createTokenAuthenticator(tokens),
        authorize: scriptingAuthorizer({ directory, allow })
    })
    server.exposeClassInstance(scripting)
    await server.ready()
    return {
        name: peer(`node${port}`),
        directory,
        close: async () => {
            await scripting.close()
            await server.close()
            rmSync(directory, { recursive: true, force: true })
        }
    }
}

interface Scripting {
    save: (name: string, source: string, language?: string) => Promise<string>
    list: () => Promise<{ name: string; running: boolean }[]>
    start: (name: string) => Promise<{ pid: number | null }>
    output: (name: string) => Promise<{ output: string[] }>
    read: (name: string) => Promise<string>
}

test('a named peer scripts the node across the hall, and sees what it printed', async (t) => {
    const node = await nodeOffering(7561, [peer('bench')], { 'bench-key': peer('bench') })

    const bench = new RpcServer({
        name: peer('bench'),
        transports: [{ connect: 'http://localhost:7561', credentials: { token: 'bench-key' } }],
        readyTimeout: 10000
    })
    await bench.ready()
    t.true(await bench.awaitPeer(node.name, 8000), 'the node never became addressable')

    const remote = (await bench.proxy<Scripting>('scripting', node.name))

    // Written from here, onto the other machine's disk - which is the whole point of it.
    await remote.save('hello', "console.log('from the other node')\n", 'mjs')
    t.deepEqual(
        (await remote.list()).map((entry) => entry.name),
        ['hello']
    )
    t.regex(await remote.read('hello'), /from the other node/)

    await remote.start('hello')
    // Its output comes back over the same link, since a script has no other channel home.
    let printed: string[] = []
    await waitFor(async () => {
        printed = (await remote.output('hello')).output
        return printed.length > 0
    })
    t.true(printed.join('\n').includes('from the other node'), `got: ${JSON.stringify(printed)}`)

    await bench.close()
    await node.close()
})

test('a peer this node has not named is refused, however well it authenticated', async (t) => {
    // A token proves who you are. It does not say you may write programs onto somebody else's
    // machine, and those are deliberately two decisions rather than one.
    const node = await nodeOffering(7562, [peer('bench')], { 'bench-key': peer('bench'), 'other-key': peer('stranger') })

    const stranger = new RpcServer({
        name: peer('stranger'),
        transports: [{ connect: 'http://localhost:7562', credentials: { token: 'other-key' } }],
        readyTimeout: 10000
    })
    await stranger.ready()
    t.true(await stranger.awaitPeer(node.name, 8000))

    const remote = (await stranger.proxy<Scripting>('scripting', node.name))
    const failure = await t.throwsAsync(remote.save('intruder', 'console.log(1)\n', 'mjs'))
    t.regex(String(failure?.message), /Forbidden/)
    t.deepEqual(await remote.list().catch(() => 'refused'), 'refused', 'even reading the list is not on offer')

    await stranger.close()
    await node.close()
})

test('a caller the transport cannot vouch for is refused, which is what an unsigned bus is', async (t) => {
    // The rule that matters on MQTT: no connection to authenticate means no identity, and a peer
    // name off the wire is a claim. The guard cannot tell a plant controller from anybody else on
    // such a network, so it refuses everyone rather than trusting the claim.
    const guard = scriptingAuthorizer({ directory: '/tmp/unused', allow: ['plantBench'] })

    t.false(
        await guard({ source: 'plantBench', instanceName: 'scripting', method: 'save', params: [], subscription: false }),
        'an unauthenticated caller must be refused even when the name matches'
    )
    t.true(
        await guard({
            identity: { name: 'plantBench' },
            source: 'plantBench',
            instanceName: 'scripting',
            method: 'save',
            params: [],
            subscription: false
        })
    )
})

test('the guard leaves every other namespace alone', async (t) => {
    // It is composed onto whatever a node already does, so it has to be a rule about `scripting` and
    // silent about the rest - otherwise adding it turns a working peer into a refusing one.
    const guard = scriptingAuthorizer({ directory: '/tmp/unused', allow: [] })
    t.true(await guard({ source: 'anyone', instanceName: 'plant', method: 'read', params: [], subscription: false }))

    let asked = false
    const composed = scriptingAuthorizer({ directory: '/tmp/unused', allow: [] }, async () => {
        asked = true
        return false
    })
    t.false(await composed({ source: 'anyone', instanceName: 'plant', method: 'read', params: [], subscription: false }))
    t.true(asked, 'the policy that was already there should still decide its own namespaces')
})

test('nobody is named by default, so exposing it locally does not open it to the bus', async (t) => {
    const guard = scriptingAuthorizer({ directory: '/tmp/unused' })
    t.false(
        await guard({ identity: { name: 'anyone' }, source: 'anyone', instanceName: 'scripting', method: 'list', params: [], subscription: false })
    )
})

// ---------------------------------------------------------------- driven the way a model drives it

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, 'index.js')

/** The MCP server as a child process, spoken to over its stdio the way a client would. */
const mcpClient = (argv: string[], token?: string) => {
    const child = spawn(process.execPath, [cli, 'mcp', ...argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The hub authenticates, and a secret reaches the CLI through the environment rather than a
        // flag - `ps` being readable by everyone on the box.
        env: { ...process.env, ...(token ? { SOURCE_RPC_TOKEN: token } : {}) }
    })
    let buffer = ''
    const waiting = new Map<number, (value: Record<string, unknown>) => void>()
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
            const line = buffer.slice(0, cut).trim()
            buffer = buffer.slice(cut + 1)
            if (!line) continue
            const message = JSON.parse(line) as { id?: number }
            if (message.id !== undefined) waiting.get(message.id)?.(message as Record<string, unknown>)
        }
    })
    let id = 0
    return {
        child,
        send: (method: string, params?: unknown) =>
            new Promise<Record<string, unknown>>((resolve) => {
                const mine = ++id
                waiting.set(mine, resolve)
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, ...(params ? { params } : {}) })}\n`)
            }),
        close: () => child.kill()
    }
}

const textOf = (response: Record<string, unknown>) =>
    ((response.result as { content?: { text?: string }[] } | undefined)?.content ?? []).map((part) => part.text ?? '').join('')

test('a model reaches the node across the hall through the same tool, by naming it', async (t) => {
    // The whole point of the exercise: one tool, one method name, and the only difference between
    // this machine and the next one is an argument.
    const node = await nodeOffering(7563, [peer('mcp-bench')], { 'mcp-key': peer('mcp-bench') })
    const localDirectory = scriptsDir()

    const client = mcpClient([
        '--hub',
        'http://localhost:7563',
        '--name',
        peer('mcp-bench'),
        '--scripts',
        localDirectory
    ], 'mcp-key')
    await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    // Every script tool now advertises where it can be aimed.
    const tools = (await client.send('tools/list')).result as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }
    const save = tools.tools.find((tool) => tool.name === 'save_script')!
    t.truthy(save.inputSchema.properties?.node, 'save_script should say it can be aimed at a node')
    const peers = tools.tools.find((tool) => tool.name === 'list_peers')!
    t.falsy(peers.inputSchema.properties?.node, 'a tool that is not about scripts should not have grown one')

    // Local still works, and is the default when no node is named.
    const savedHere = await client.send('tools/call', { name: 'save_script', arguments: { name: 'here', source: "console.log('local')\n", language: 'mjs' } })
    t.regex(textOf(savedHere), /Saved/)
    const listed = JSON.parse(textOf(await client.send('tools/call', { name: 'list_scripts', arguments: {} }))) as { directory: string; scripts: { name: string }[] }
    t.deepEqual(
        listed.scripts.map((script) => script.name),
        ['here']
    )
    // Said with the list, because an empty list from the directory you meant and an empty list from
    // one you mistyped are the same two characters.
    t.is(listed.directory, localDirectory)

    client.close()
    await node.close()
    rmSync(localDirectory, { recursive: true, force: true })
})

test('through a bus, the grant rests on signed frames rather than the connection', async (t) => {
    // The finding that made this worth prototyping. A peer authenticates to the *bus*, and the node
    // being scripted is connected to the bus too - so the node has no connection to the caller and
    // no way to know who it is. Identity is per-connection and does not survive a relay.
    //
    // On MQTT it does, because the signature is on the frame: it is checked by whoever ends up
    // reading it, whatever the broker did in between. So a relayed test hall has to sign, and this
    // is the arrangement that works rather than the one that reads as though it should.
    if (skipWithoutBroker(t)) return
    const prefix = `msgrpc/scripting-${run}`
    const nodeKeys = join(mkdtempSync(join(tmpdir(), 'source-rpc-keys-')), 'node.json')
    const benchKeys = join(dirname(nodeKeys), 'bench.json')
    writeFileSync(nodeKeys, JSON.stringify({ name: peer('signNode'), secret: 'node-secret', peers: { [peer('signBench')]: 'bench-secret' } }))
    writeFileSync(benchKeys, JSON.stringify({ name: peer('signBench'), secret: 'bench-secret', peers: { [peer('signNode')]: 'node-secret' } }))

    const nodeDirectory = scriptsDir()
    const offered = mcpClient([
        '--broker',
        BROKER_URL,
        '--prefix',
        prefix,
        '--sign',
        nodeKeys,
        '--scripts',
        nodeDirectory,
        '--scriptable-by',
        peer('signBench')
    ])
    await offered.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    const bench = new RpcServer({
        name: peer('signBench'),
        transports: [
            new MqttTransport(peer('signBench'), BROKER_URL, {
                prefix,
                sessionExpirySeconds: 10,
                sign: createHmacSigner('bench-secret'),
                verify: createHmacVerifier((who) => (who === peer('signNode') ? 'node-secret' : undefined))
            })
        ],
        readyTimeout: 15000
    })
    await bench.ready()
    t.true(await bench.awaitPeer(peer('signNode'), 12000), 'the offering node never appeared on the broker')

    const remote = (await bench.proxy<Scripting>('scripting', peer('signNode')))
    await remote.save('signed', "console.log('written across a broker')\n", 'mjs')
    t.deepEqual(
        (await remote.list()).map((entry) => entry.name),
        ['signed'],
        'a signed and named peer should be able to write onto that node through the broker'
    )

    offered.close()
    await bench.close()
    rmSync(dirname(nodeKeys), { recursive: true, force: true })
    rmSync(nodeDirectory, { recursive: true, force: true })
})

test('a node that names nobody offers no scripting namespace at all', async (t) => {
    const bus = new RpcServer({
        name: peer('quietBus'),
        transports: [{ port: 7565 }],
        authenticate: createTokenAuthenticator({ 'node-key': peer('quietNode'), 'bench-key': peer('quietBench') })
    })
    await bus.ready()

    const nodeDirectory = scriptsDir()
    // --scripts but no --scriptable-by: it can script itself and nothing else can.
    const closed = mcpClient(['--hub', 'http://localhost:7565', '--name', peer('quietNode'), '--scripts', nodeDirectory], 'node-key')
    await closed.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    const bench = new RpcServer({
        name: peer('quietBench'),
        transports: [{ connect: 'http://localhost:7565', credentials: { token: 'bench-key' } }],
        readyTimeout: 10000,
        callTimeout: 4000
    })
    await bench.ready()
    t.true(await bench.awaitPeer(peer('quietNode'), 10000))

    const remote = (await bench.proxy<Scripting>('scripting', peer('quietNode')))
    const failure = await t.throwsAsync(remote.list())
    // ClassNotFound rather than Forbidden: there is nothing there to refuse, which is a stronger
    // statement than a refusal - the capability was never published.
    t.regex(String(failure?.message), /ClassNotFound|Forbidden/)

    closed.close()
    await bench.close()
    await bus.close()
    rmSync(nodeDirectory, { recursive: true, force: true })
})

test('a node command is scriptable and nothing else, and says so when it cannot be', async (t) => {
    if (skipWithoutBroker(t)) return
    // The shape for a machine with no model attached: no stdio protocol, no tools, just a peer that
    // can be scripted by whoever it names.
    const prefix = `msgrpc/node-cmd-${run}`
    const keyDirectory = mkdtempSync(join(tmpdir(), 'source-rpc-keys-'))
    const nodeKeys = join(keyDirectory, 'node.json')
    // The node signs as itself and knows the bench's key, which is what lets it put a name to the
    // caller. That secret is the thing that travels out of band.
    writeFileSync(nodeKeys, JSON.stringify({ name: peer('plc'), secret: 'plc-secret', peers: { [peer('hall')]: 'hall-secret' } }))
    const scripts = scriptsDir()

    const child = spawn(process.execPath, [cli, 'node', '--broker', BROKER_URL, '--prefix', prefix, '--sign', nodeKeys, '--scripts', scripts, '--scriptable-by', peer('hall')])
    const said: string[] = []
    child.stdout.on('data', (chunk: Buffer) => said.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => said.push(chunk.toString()))

    const bench = new RpcServer({
        name: peer('hall'),
        transports: [
            new MqttTransport(peer('hall'), BROKER_URL, {
                prefix,
                sessionExpirySeconds: 10,
                sign: createHmacSigner('hall-secret'),
                verify: createHmacVerifier((who) => (who === peer('plc') ? 'plc-secret' : undefined))
            })
        ],
        readyTimeout: 15000
    })
    await bench.ready()
    t.true(await bench.awaitPeer(peer('plc'), 15000), `the node never appeared: ${said.join('')}`)

    const remote = (await bench.proxy<Scripting>('scripting', peer('plc')))
    await remote.save('on-the-plc', "console.log('ran on the plc')\n", 'mjs')
    t.deepEqual(
        (await remote.list()).map((entry) => entry.name),
        ['on-the-plc']
    )

    child.kill()
    await bench.close()
    rmSync(keyDirectory, { recursive: true, force: true })
    rmSync(scripts, { recursive: true, force: true })
})

test('a script started by a node connects to an authenticating bus as itself', async (t) => {
    // The whole of DEV-361 in one test: the node holds a secret, the bus trusts that node as an
    // issuer, and the script - which the bus has never heard of - authenticates under its own name.
    const secret = `derive-${randomUUID().slice(0, 8)}`
    const nodeName = peer('node7574')
    const bus = new RpcServer({
        name: peer('bus7574'),
        transports: [{ port: 7574, host: '127.0.0.1' }],
        authenticate: createDerivedAuthenticator({ issuers: { [nodeName]: secret } })
    })
    await bus.ready()

    // Beside the package rather than in /tmp, so the script's `import '@source-repo/rpc'` resolves
    // through the repository's node_modules exactly as a real scripts directory's would.
    const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'derived-run-'))
    saveScript(
        directory,
        'joiner',
        [
            "import { RpcServer } from '@source-repo/rpc'",
            "const peer = new RpcServer({ name: process.env.SOURCE_RPC_NAME, transports: [{ connect: process.env.SOURCE_RPC_HUB, credentials: { token: process.env.SOURCE_RPC_TOKEN } }] })",
            'await peer.ready()',
            "console.log('joined as ' + process.env.SOURCE_RPC_NAME)",
            'await new Promise((resume) => setTimeout(resume, 3000))',
            'await peer.close()'
        ].join('\n'),
        'mjs'
    )

    const runner = new ScriptRunner(directory, { SOURCE_RPC_HUB: 'http://127.0.0.1:7574' }, async (script) => {
        const issuedAt = Date.now()
        const name = `${script}@${nodeName}`
        return {
            name,
            token: await mintDerivedCredential(
                { credentialId: script, subject: name, roles: ['ai-program'], issuer: nodeName, generation: 2, issuedAt, expiresAt: issuedAt + 60_000 },
                secret
            )
        }
    })

    await runner.start('joiner')
    const expected = `joiner@${nodeName}`
    await waitForCondition(() => bus.peers.names().includes(expected), 8000)

    t.true(bus.peers.names().includes(expected), 'the script is on the bus under its own name, not the node\'s')
    t.false(bus.peers.names().includes(nodeName), 'and the node itself never connected - only its child did')

    await runner.stopAll()
    rmSync(directory, { recursive: true, force: true })
    await bus.close()
})
