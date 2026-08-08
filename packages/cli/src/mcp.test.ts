import test from 'ava'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import EventEmitter from 'node:events'
import { defineRpcContext, HOST_ROOT, rpc, rpcNamespace, RpcComponent, RpcServer, type RpcSchema } from '@source-repo/rpc'
import { failureText } from './mcp.js'

/**
 * Driven as a client would drive it: a real child process, real newline-delimited JSON-RPC over its
 * stdio, and a real peer on a real hub at the other end. Calling startMcp in-process would prove
 * the handlers work while leaving the part that actually breaks - stdout carrying anything but
 * protocol - untested.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, 'index.js')
const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

/** An emitter for the watch tests: wail() fires whether or not anyone is listening. */
class Siren extends EventEmitter {
    @rpc({ semantics: 'query' })
    async ping() {
        return 'ok'
    }
    wail(level: number) {
        this.emit('wail', level)
    }
}

/** An observable component for read_state, and a node for read_context to resolve at. */
type KilnProps = { unit: string; maximum: number }
type KilnState = { celsius: number; mode: string; zones: { top: { setpoint: number } }; tags: { [tag: string]: number } }

@rpcNamespace('kiln')
class Kiln extends RpcComponent<KilnProps, KilnState> {
    constructor() {
        super({ unit: '°C', maximum: 300 }, { celsius: 20, mode: 'idle', zones: { top: { setpoint: 20 } }, tags: { a: 1 } })
    }

    @rpc({ semantics: 'idempotent-command', sets: 'mode' })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }

    @rpc({ semantics: 'idempotent-command', sets: 'zones.top.setpoint' })
    async setTopSetpoint(celsius: number) {
        this.setState((previous) => ({ zones: { top: { ...previous.zones.top, setpoint: celsius } } }))
        return celsius
    }

    /** `celsius` is measured: no per-field method commands it, and the generic one refuses it. */
    @rpc({ semantics: 'query' })
    async readCelsius() {
        return this.state.celsius
    }

    /** The generic form, for the tags. Which paths it takes is decided here, as always. */
    @rpc({ semantics: 'idempotent-command', sets: '*' })
    async set(path: string[], value: unknown) {
        const [root, tag] = path
        if (root !== 'tags' || path.length !== 2 || typeof value !== 'number') throw new Error(`${path.join('.')} is not writable`)
        this.setState((previous) => ({ tags: { ...previous.tags, [tag]: value } }))
        return value
    }
}

/**
 * The other shape: per-field claims and no generic setter, which is what a plant looks like. Only
 * here can "nothing claims that path" be an answer - a component declaring `sets: '*'` claims every
 * path by construction, and its refusals come from its own body instead.
 */
@rpcNamespace('vent')
class Vent extends RpcComponent<{ label: string }, { open: boolean; pressure: number }> {
    constructor() {
        super({ label: 'v' }, { open: false, pressure: 1 })
    }

    @rpc({ semantics: 'idempotent-command', sets: 'open' })
    async setOpen(open: boolean) {
        this.setState({ open })
        return open
    }
}

const SiteToken = defineRpcContext<{ site: string; timezone: string }>({ id: 'acme.site', schemaVersion: '1', axis: 'physical' })

/**
 * Hand-written rather than extracted, because what set_state needs from a contract is only the
 * component's state shape - that is where the type at a path comes from, and therefore where a
 * wrong value is refused before it travels. Validation is off so the methods need not be described.
 */
const kilnSchema: RpcSchema = {
    schema: 1,
    namespaces: {
        kiln: {
            version: '1',
            methods: {},
            component: {
                snapshot: 1,
                props: { kind: 'object', fields: { unit: { type: { kind: 'string' } }, maximum: { type: { kind: 'number' } } } },
                state: {
                    kind: 'object',
                    fields: {
                        celsius: { type: { kind: 'number' } },
                        mode: { type: { kind: 'string' } },
                        zones: {
                            type: { kind: 'object', fields: { top: { type: { kind: 'object', fields: { setpoint: { type: { kind: 'number' } } } } } } }
                        },
                        tags: { type: { kind: 'record', values: { kind: 'number' } } }
                    }
                }
            }
        }
    }
}

@rpcNamespace('boiler')
class Boiler {
    private celsius = 20
    @rpc
    async setTemperature(celsius: number) {
        this.celsius = celsius
        return this.celsius
    }
    @rpc
    async status() {
        return { celsius: this.celsius, firing: this.celsius > 50 }
    }
    async notExposed() {
        return 'hidden'
    }
}

/** A client for the server under test: writes a request, waits for the reply with that id. */
const mcpClient = (port: number, extra: string[] = [], env: { [name: string]: string } = {}) => {
    const child = spawn(process.execPath, [cli, 'mcp', '--hub', `http://localhost:${port}`, '--name', peer(`mcp${port}`), '--timeout', '5000', ...extra], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env }
    })
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    const stray: string[] = []
    let buffered = ''
    let id = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            newline = buffered.indexOf('\n')
            if (!line) continue
            try {
                const message = JSON.parse(line) as { id?: number }
                if (typeof message.id === 'number' && pending.has(message.id)) {
                    pending.get(message.id)!(message as Record<string, unknown>)
                    pending.delete(message.id)
                } else stray.push(line)
            } catch {
                // The failure this whole design is about: anything on stdout that is not protocol.
                stray.push(`NOT JSON: ${line}`)
            }
        }
    })
    const send = (method: string, params?: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
            const mine = ++id
            const timer = setTimeout(() => rejectPromise(new Error(`no reply to ${method} within 15s`)), 15000)
            pending.set(mine, (value) => {
                clearTimeout(timer)
                resolvePromise(value)
            })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, ...(params ? { params } : {}) }) + '\n')
        })
    const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
    const ready = new Promise<void>((resolvePromise) => {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
            if (chunk.includes('source-rpc mcp:')) resolvePromise()
        })
    })
    return { child, send, notify, ready, stray, close: () => child.kill() }
}

const toolText = (response: Record<string, unknown>) => {
    const result = response.result as { content?: { text?: string }[]; isError?: boolean } | undefined
    return { text: result?.content?.[0]?.text ?? '', isError: !!result?.isError }
}

test('an MCP client can list, describe and call the peers on a Source RPC network', async (t) => {
    const hub = new RpcServer({ name: peer('hub'), transports: [{ port: 3995 }] })
    await hub.ready()
    const plant = new RpcServer({ name: peer('plant'), transports: [{ connect: 'http://localhost:3995' }], exposeIntrospection: true })
    plant.exposeClassInstance(new Boiler())
    await plant.ready()

    const client = mcpClient(3995)
    await client.ready

    const initialized = await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const initResult = initialized.result as { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } }
    t.is(initResult.protocolVersion, '2025-06-18', 'the client version should be echoed back')
    t.truthy(initResult.capabilities.tools, 'tools have to be advertised or no client will call them')
    t.is(initResult.serverInfo.name, 'source-rpc')
    client.notify('notifications/initialized')

    const listed = await client.send('tools/list')
    const tools = (listed.result as { tools: { name: string; inputSchema: unknown }[] }).tools
    t.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [
            'call_method',
            'check_peer',
            'describe_peer',
            'diff_peers',
            'find_capability',
            'list_fakes',
            'list_peers',
            'read_context',
            'read_state',
            'set_state',
            'start_fake',
            'stop_fake',
            'watch_events',
            'watch_traffic'
        ]
    )
    // The contract tools are absent without a directory to write to: a server that cannot write
    // files must not advertise tools claiming it can.
    t.false(tools.some((tool) => tool.name === 'save_contract'), 'save_contract should need --contracts')
    t.truthy(tools.every((tool) => tool.inputSchema), 'every tool needs a schema for its arguments')

    // The peer has to be discovered over the hub before it can be listed.
    let peers: string[] = []
    const deadline = Date.now() + 10000
    while (!peers.includes(peer('plant')) && Date.now() < deadline) {
        const response = await client.send('tools/call', { name: 'list_peers', arguments: {} })
        peers = (JSON.parse(toolText(response).text) as { peers: string[] }).peers
    }
    t.true(peers.includes(peer('plant')), `expected the plant among ${JSON.stringify(peers)}`)

    const described = await client.send('tools/call', { name: 'describe_peer', arguments: { peer: peer('plant') } })
    const description = JSON.parse(toolText(described).text) as { namespaces: { name: string; methods: { name: string }[] }[] }
    const boiler = description.namespaces.find((namespace) => namespace.name === 'boiler')
    t.deepEqual(boiler?.methods.map((method) => method.name).sort(), ['setTemperature', 'status'], 'unmarked methods must not be offered to a model')

    const called = await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('plant'), namespace: 'boiler', method: 'setTemperature', args: [90] } })
    t.is(toolText(called).text, '90')
    const status = await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('plant'), namespace: 'boiler', method: 'status' } })
    t.deepEqual(JSON.parse(toolText(status).text), { celsius: 90, firing: true }, 'a method taking no arguments should work with args omitted')

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')

    client.close()
    await plant.close()
    await hub.close()
})

test('a refused call is reported as an answer, not as a broken tool', async (t) => {
    const hub = new RpcServer({ name: peer('hub2'), transports: [{ port: 3996 }] })
    await hub.ready()
    const client = mcpClient(3996)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    // A model should read the reason and change what it does, rather than see the transport fail.
    const missing = await client.send('tools/call', { name: 'call_method', arguments: { peer: 'nobody-here', namespace: 'boiler', method: 'status' } })
    t.true(toolText(missing).isError)
    t.regex(toolText(missing).text, /nobody-here/)
    t.falsy(missing.error, 'a peer that will not answer is not a JSON-RPC level failure')

    const unknown = await client.send('tools/call', { name: 'no_such_tool', arguments: {} })
    t.true(toolText(unknown).isError)

    const bad = await client.send('nonsense/method')
    t.is((bad.error as { code: number }).code, -32601)

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')

    client.close()
    await hub.close()
})

/** The contract a model would write to describe a device it wants to try something against. */
const plantContract = {
    schema: 1,
    namespaces: {
        plant: {
            version: '1',
            methods: {
                read: { params: [], returns: { kind: 'object', fields: { celsius: { type: { kind: 'number', min: 0, max: 100 } } } } },
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], paramNames: ['value'], returns: { kind: 'boolean' } }
            },
            events: { alarm: { params: [{ kind: 'string' }] } }
        }
    }
}

test('a model can stand a peer up from a contract and then call it, without a shell', async (t) => {
    const hub = new RpcServer({ name: peer('hub3'), transports: [{ port: 3997 }] })
    await hub.ready()
    const client = mcpClient(3997)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    // No file anywhere: the contract is handed over inline, which is the whole point.
    const started = await client.send('tools/call', {
        name: 'start_fake',
        arguments: { name: peer('fakePlant'), schema: plantContract, script: { returns: { 'plant.read': { celsius: 84 } } } }
    })
    t.false(toolText(started).isError, toolText(started).text)
    t.regex(toolText(started).text, /is a fake/, 'a stand-in mistaken for a device is worse than none')

    // It is a peer of the real network, so the ordinary verbs reach it.
    let peers: string[] = []
    const deadline = Date.now() + 10000
    while (!peers.includes(peer('fakePlant')) && Date.now() < deadline) {
        peers = (JSON.parse(toolText(await client.send('tools/call', { name: 'list_peers', arguments: {} })).text) as { peers: string[] }).peers
    }
    t.true(peers.includes(peer('fakePlant')), `expected the fake among ${JSON.stringify(peers)}`)

    const read = await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('fakePlant'), namespace: 'plant', method: 'read' } })
    t.deepEqual(JSON.parse(toolText(read).text), { celsius: 84 })

    // It refuses what the contract refuses, which is what makes it worth calling at all.
    const refused = await client.send('tools/call', {
        name: 'call_method',
        arguments: { peer: peer('fakePlant'), namespace: 'plant', method: 'writeSetpoint', args: [3000] }
    })
    t.true(toolText(refused).isError)
    t.regex(toolText(refused).text, /2000/)

    const listed = JSON.parse(toolText(await client.send('tools/call', { name: 'list_fakes', arguments: {} })).text) as { fakes: { peer: string }[] }
    t.deepEqual(listed.fakes.map((fake) => fake.peer), [peer('fakePlant')])

    const stopped = await client.send('tools/call', { name: 'stop_fake', arguments: { name: peer('fakePlant') } })
    t.false(stopped.error ? true : toolText(stopped).isError)
    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')

    client.close()
    await hub.close()
})

test('a fake will not take the name of a peer that is already there', async (t) => {
    const hub = new RpcServer({ name: peer('hub4'), transports: [{ port: 3998 }] })
    await hub.ready()
    const real = new RpcServer({ name: peer('realPlant'), transports: [{ connect: 'http://localhost:3998' }], exposeIntrospection: true })
    real.exposeClassInstance(new Boiler())
    await real.ready()

    const client = mcpClient(3998)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    let peers: string[] = []
    const deadline = Date.now() + 10000
    while (!peers.includes(peer('realPlant')) && Date.now() < deadline) {
        peers = (JSON.parse(toolText(await client.send('tools/call', { name: 'list_peers', arguments: {} })).text) as { peers: string[] }).peers
    }

    // The guard that matters: a fake under a live device's name would displace it, and calls meant
    // for the plant would reach a stand-in that agrees with everything.
    const refused = await client.send('tools/call', { name: 'start_fake', arguments: { name: peer('realPlant'), schema: plantContract } })
    t.true(toolText(refused).isError)
    t.regex(toolText(refused).text, /already a peer/)

    // And the real device is untouched.
    const status = await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('realPlant'), namespace: 'boiler', method: 'status' } })
    t.deepEqual(JSON.parse(toolText(status).text), { celsius: 20, firing: false })

    client.close()
    await real.close()
    await hub.close()
})

test('with a contracts directory it can save one, list it, and serve it back', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'msgrpc-contracts-'))
    const hub = new RpcServer({ name: peer('hub5'), transports: [{ port: 3999 }] })
    await hub.ready()
    const client = mcpClient(3999, ['--contracts', directory])
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    const tools = ((await client.send('tools/list')).result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    t.true(tools.includes('save_contract'))
    t.true(tools.includes('list_contracts'))

    const saved = await client.send('tools/call', { name: 'save_contract', arguments: { name: 'plant', schema: plantContract } })
    t.false(toolText(saved).isError, toolText(saved).text)
    t.regex(toolText(saved).text, /plant\.types\.json/)
    // Written where the CLI can pick it up, which is the point of writing it at all.
    t.deepEqual(JSON.parse(readFileSync(join(directory, 'plant.types.json'), 'utf8')), plantContract)

    const listed = JSON.parse(toolText(await client.send('tools/call', { name: 'list_contracts', arguments: {} })).text) as {
        contracts: { contract: string; namespaces: string[] }[]
    }
    t.deepEqual(listed.contracts, [{ contract: 'plant', namespaces: ['plant'] }])

    // Served back by name rather than by handing the whole schema over again.
    const started = await client.send('tools/call', { name: 'start_fake', arguments: { name: peer('fromFile'), contract: 'plant' } })
    t.false(toolText(started).isError, toolText(started).text)

    // A name that would climb out of the directory is refused rather than resolved.
    const escape = await client.send('tools/call', { name: 'save_contract', arguments: { name: '../escaped', schema: plantContract } })
    t.true(toolText(escape).isError)
    t.regex(toolText(escape).text, /not a usable contract name/)

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')
    client.close()
    await hub.close()
    rmSync(directory, { recursive: true, force: true })
})

test('a contracts directory that does not exist yet is an empty one, and the first save makes it', async (t) => {
    const parent = mkdtempSync(join(tmpdir(), 'msgrpc-contracts-'))
    // Deliberately not created: `--contracts ./contracts` says where contracts are to go, not
    // somewhere that already has to be there. Both tools used to fail on it - one with a raw ENOENT
    // that reads as a broken server rather than as a directory nobody has made yet.
    const directory = join(parent, 'contracts')
    const hub = new RpcServer({ name: peer('hub6'), transports: [{ port: 3994 }] })
    await hub.ready()
    const client = mcpClient(3994, ['--contracts', directory])
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })

    const empty = await client.send('tools/call', { name: 'list_contracts', arguments: {} })
    t.false(toolText(empty).isError, toolText(empty).text)
    t.deepEqual((JSON.parse(toolText(empty).text) as { contracts: unknown[] }).contracts, [], 'nothing saved yet is an empty list, not a failure')

    const saved = await client.send('tools/call', { name: 'save_contract', arguments: { name: 'plant', schema: plantContract } })
    t.false(toolText(saved).isError, toolText(saved).text)
    t.deepEqual(JSON.parse(readFileSync(join(directory, 'plant.types.json'), 'utf8')), plantContract, 'the directory should have been made on the way past')

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')
    client.close()
    await hub.close()
    rmSync(parent, { recursive: true, force: true })
})

/**
 * A `node:fs` error already opens with its own code, and prefixing it again said `ENOENT: ENOENT:`
 * - the same thing appearing to have gone wrong twice. An RPC error keeps its code apart from its
 * message, which is the case the prefix exists for.
 */
test('a failure carrying a code is not made to repeat it', (t) => {
    t.is(failureText(Object.assign(new Error('ENOENT: no such file or directory, scandir /x'), { code: 'ENOENT' })), 'ENOENT: no such file or directory, scandir /x')
    t.is(failureText(Object.assign(new Error('not permitted to relay'), { code: 'Forbidden' })), 'Forbidden: not permitted to relay')
    t.is(failureText(new Error('no code at all')), 'no code at all')
    t.is(failureText('a string'), 'a string')
})

test('find_capability discovers by contract, and a wrong-shaped call fails before it travels', async (t) => {
    const hub = new RpcServer({ name: peer('hub3993'), transports: [{ port: 3993 }] })
    await hub.ready()
    const capable: RpcSchema = {
        schema: 1,
        namespaces: {
            boiler: {
                methods: { setTemperature: { params: [{ kind: 'number', max: 120 }], paramNames: ['celsius'], returns: { kind: 'number' } } },
                capabilities: ['@fixture/contracts/AdvancedRenderer', '@fixture/contracts/Renderer']
            }
        }
    }
    const plant = new RpcServer({ name: peer('capable3993'), transports: [{ connect: 'http://localhost:3993' }], schema: capable, exposeIntrospection: true })
    plant.exposeClassInstance(new Boiler())
    await plant.ready()

    const client = mcpClient(3993)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized')

    try {
        // Wait until discovery has seen the peer, then search for the parent interface: the
        // extract-time closure means the child's implementor answers a search for the parent.
        let found: { matches: { peer: string; namespace: string }[] } = { matches: [] }
        for (let attempt = 0; attempt < 40 && !found.matches.length; attempt++) {
            found = JSON.parse(toolText(await client.send('tools/call', { name: 'find_capability', arguments: { capability: '@fixture/contracts/Renderer' } })).text) as typeof found
            if (!found.matches.length) await new Promise((resolve) => setTimeout(resolve, 250))
        }
        t.is(found.matches[0]?.peer, peer('capable3993'))
        t.is(found.matches[0]?.namespace, 'boiler')

        // A hallucinated capability is an empty list, not an error - empty is what absent looks like.
        const nothing = toolText(await client.send('tools/call', { name: 'find_capability', arguments: { capability: '@imagined/contracts/Telepathy' } }))
        t.false(nothing.isError)
        t.deepEqual((JSON.parse(nothing.text) as { matches: unknown[] }).matches, [])

        // The hallucinated wiring: a string into a number-typed parameter. The description was
        // cached by the search above, so the refusal is local - InvalidParams before any hop.
        const refused = toolText(
            await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('capable3993'), namespace: 'boiler', method: 'setTemperature', args: ['warm'] } })
        )
        t.true(refused.isError)
        t.regex(refused.text, /InvalidParams, before sending/)

        // And the right shape still travels and answers.
        const answered = toolText(
            await client.send('tools/call', { name: 'call_method', arguments: { peer: peer('capable3993'), namespace: 'boiler', method: 'setTemperature', args: [65] } })
        )
        t.false(answered.isError, answered.text)
    } finally {
        client.close()
        await plant.close()
        await hub.close()
    }
})

test('watch_events says whether anything was missed between windows, and when it cannot know', async (t) => {
    const hub = new RpcServer({ name: peer('hub-watch'), transports: [{ port: 3992, host: '127.0.0.1' }] })
    await hub.ready()

    const sirenSchema = {
        schema: 1,
        namespaces: { siren: { version: '1.0.0', methods: { ping: { params: [], paramNames: [] } }, events: { wail: { params: [{ kind: 'number' }] } } } }
    } as unknown as RpcSchema

    const sirenPeer = () => {
        const siren = new Siren()
        const server = new RpcServer({
            name: peer('siren'),
            transports: [{ connect: 'http://localhost:3992' }],
            exposeIntrospection: true,
            schema: sirenSchema
        })
        server.exposeClassInstance(siren, 'siren')
        return { siren, server }
    }
    let running = sirenPeer()
    await running.server.ready()

    const client = mcpClient(3992)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized')

    const awaitPeerListed = async () => {
        const deadline = Date.now() + 10000
        for (;;) {
            const listed = await client.send('tools/call', { name: 'list_peers', arguments: {} })
            if ((JSON.parse(toolText(listed).text) as { peers: string[] }).peers.includes(peer('siren'))) return
            if (Date.now() > deadline) throw new Error('siren never appeared on the hub')
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    await awaitPeerListed()

    const watch = async () => {
        const answer = await client.send('tools/call', { name: 'watch_events', arguments: { peer: peer('siren'), namespace: 'siren', event: 'wail', seconds: 1 } })
        return JSON.parse(toolText(answer).text) as { heard: unknown[]; loss: string; cursor?: { epoch: string; seq: number } }
    }

    // The first window has nothing to compare against, and says so.
    const first = await watch()
    t.regex(first.loss, /first watch/)

    // A quiet stream, watched twice: this is the sentence the issue exists for.
    const quiet = await watch()
    t.regex(quiet.loss, /gapless/, `saw nothing must mean missed nothing here, got: ${quiet.loss}`)
    t.is(quiet.heard.length, 0)

    // An event between windows: the next watch hears nothing and reports the miss, not silence.
    running.siren.wail(1)
    const missed = await watch()
    t.is(missed.heard.length, 0, 'the event fired while nobody watched')
    t.regex(missed.loss, /missed 1/, `a fallen event must be reported as a gap, got: ${missed.loss}`)

    // A restart between windows: a fresh incarnation cannot say what an old one dropped.
    await running.server.close()
    running = sirenPeer()
    await running.server.ready()
    await awaitPeerListed()
    const unknowable = await watch()
    t.regex(unknowable.loss, /unknowable|restarted/, `a restart must be reported as unanswerable, got: ${unknowable.loss}`)

    // And the epoch has turned over, so the very next quiet window is gapless again.
    const recovered = await watch()
    t.regex(recovered.loss, /gapless/)

    await client.close()
    await running.server.close()
    await hub.close()
})

test('a model can read what a component publishes, and what its node inherits', async (t) => {
    const hub = new RpcServer({ name: peer('hub-state'), transports: [{ port: 3974, host: '127.0.0.1' }] })
    await hub.ready()

    const plantName = peer('statePlant')
    const plant = new RpcServer({
        name: plantName,
        transports: [{ connect: 'http://localhost:3974' }],
        // Providers at HOST_ROOT hang off the host's own place, so the chain has somewhere to end.
        topology: { place: ['site-7', 'bakery'] },
        exposeIntrospection: true,
        schema: kilnSchema,
        validation: 'off',
        allowStatePathWrites: true
    })
    plant.exposeClassInstance(new Kiln(), 'kiln')
    await plant.ready()
    await plant.topology.declare('kiln', { parent: { peer: plantName, instance: HOST_ROOT }, label: 'Deck oven' })
    plant.provideContext(HOST_ROOT, SiteToken, { site: 'site-7', timezone: 'Europe/Stockholm' })

    const client = mcpClient(3974)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized')

    // Presence has to have settled, or the first read finds an empty network - the same race the
    // recorder and the verbs both had.
    const deadline = Date.now() + 10000
    let peers: string[] = []
    while (!peers.includes(plantName) && Date.now() < deadline) {
        const response = await client.send('tools/call', { name: 'list_peers', arguments: {} })
        peers = (JSON.parse(toolText(response).text) as { peers: string[] }).peers
    }
    t.true(peers.includes(plantName), `expected the plant among ${JSON.stringify(peers)}`)

    const read = await client.send('tools/call', { name: 'read_state', arguments: { peer: plantName, namespace: 'kiln' } })
    t.false(toolText(read).isError, toolText(read).text)
    const view = JSON.parse(toolText(read).text) as { status: string; revision: number; props: { maximum: number }; state: KilnState }
    t.is(view.status, 'live')
    t.is(view.props.maximum, 300, "props are the host's inputs and come back beside state, not instead of it")
    t.deepEqual(view.state, { celsius: 20, mode: 'idle', zones: { top: { setpoint: 20 } }, tags: { a: 1 } })

    // A command through the ordinary verb, then the value it moved read back through this one -
    // which is the loop the tool exists for.
    await client.send('tools/call', { name: 'call_method', arguments: { peer: plantName, namespace: 'kiln', method: 'setMode', args: ['heating'] } })
    const after = await client.send('tools/call', { name: 'read_state', arguments: { peer: plantName, namespace: 'kiln' } })
    const moved = JSON.parse(toolText(after).text) as { revision: number; state: { mode: string } }
    t.is(moved.state.mode, 'heating')
    t.true(moved.revision > view.revision, 'a committed snapshot moves the revision forward')

    // Nothing left observing it: a look must not leave this server subscribed for the rest of its life.
    const described = await client.send('tools/call', { name: 'describe_peer', arguments: { peer: plantName } })
    const description = JSON.parse(toolText(described).text) as { namespaces: { name: string; component?: { subscribers: number } }[] }
    t.is(description.namespaces.find((namespace) => namespace.name === 'kiln')?.component?.subscribers, 0, 'read_state must drop the subscription again')

    // A namespace that is not a component is an answer about the peer, not a broken tool.
    const notAComponent = await client.send('tools/call', { name: 'read_state', arguments: { peer: plantName, namespace: 'msgrpc' } })
    t.true(toolText(notAComponent).isError)

    const context = await client.send('tools/call', { name: 'read_context', arguments: { peer: plantName, node: 'kiln', token: 'acme.site', axis: 'physical' } })
    const resolved = JSON.parse(toolText(context).text) as { status: string; entries: { provider: string; value: { site: string } }[] }
    t.is(resolved.status, 'live')
    t.is(resolved.entries.length, 1, 'the whole chain comes back, and here the chain is one provider long')
    t.is(resolved.entries[0].value.site, 'site-7')
    t.is(resolved.entries[0].provider, `${plantName}/${HOST_ROOT}`, 'an entry names where it was provided, not where it was asked for')

    // The wrong axis does not fall back to the other one, and nobody providing it is `missing`
    // rather than an error - which is the same shape a value the provider keeps local has.
    const wrongAxis = await client.send('tools/call', { name: 'read_context', arguments: { peer: plantName, node: 'kiln', token: 'acme.site', axis: 'logical' } })
    t.is((JSON.parse(toolText(wrongAxis).text) as { status: string }).status, 'missing')
    t.false(toolText(wrongAxis).isError, 'nothing providing a token is a fact about the plant, not a failed call')

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')

    client.close()
    await plant.close()
    await hub.close()
})

test('set_state finds the method that claims a path, and refuses one nothing claims', async (t) => {
    const hub = new RpcServer({ name: peer('hub-set'), transports: [{ port: 3987, host: '127.0.0.1' }] })
    await hub.ready()

    const plantName = peer('setPlant')
    const plant = new RpcServer({
        name: plantName,
        transports: [{ connect: 'http://localhost:3987' }],
        exposeIntrospection: true,
        schema: kilnSchema,
        validation: 'off',
        allowStatePathWrites: true
    })
    plant.exposeClassInstance(new Kiln(), 'kiln')
    plant.exposeClassInstance(new Vent(), 'vent')
    await plant.ready()

    const client = mcpClient(3987)
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized')

    const deadline = Date.now() + 10000
    let peers: string[] = []
    while (!peers.includes(plantName) && Date.now() < deadline) {
        const response = await client.send('tools/call', { name: 'list_peers', arguments: {} })
        peers = (JSON.parse(toolText(response).text) as { peers: string[] }).peers
    }
    t.true(peers.includes(plantName), `expected the plant among ${JSON.stringify(peers)}`)

    const set = (path: string, value: unknown) => client.send('tools/call', { name: 'set_state', arguments: { peer: plantName, namespace: 'kiln', path, value } })

    // A per-field claim: the model names the path, not the method.
    const mode = await set('mode', 'heating')
    t.false(toolText(mode).isError, toolText(mode).text)
    t.is((JSON.parse(toolText(mode).text) as { called: string }).called, 'kiln.setMode')

    // The nested path, resolved through the state shape rather than guessed.
    const nested = await set('zones.top.setpoint', 180)
    t.is((JSON.parse(toolText(nested).text) as { called: string }).called, 'kiln.setTopSetpoint')

    // A record key falls to the generic setter, which is exactly the case it exists for.
    const tag = await set('tags.a', 7)
    t.is((JSON.parse(toolText(tag).text) as { called: string }).called, 'kiln.set')

    const after = await client.send('tools/call', { name: 'read_state', arguments: { peer: plantName, namespace: 'kiln' } })
    const state = (JSON.parse(toolText(after).text) as { state: { mode: string; zones: { top: { setpoint: number } }; tags: { a: number } } }).state
    t.is(state.mode, 'heating')
    t.is(state.zones.top.setpoint, 180)
    t.is(state.tags.a, 7, 'the generic setter wrote where it was told')

    // A component declaring `sets: '*'` claims every path by construction, so `celsius` reaches the
    // generic setter - and is refused by its body, which is where the decision belongs. The refusal
    // is the component's own words, not a guess made here.
    const measured = await set('celsius', 99)
    t.true(toolText(measured).isError)
    t.regex(toolText(measured).text, /celsius is not writable/)

    // Where there is no generic setter, an unclaimed path is refused before anything travels, and
    // the refusal says what the component does set - "no" being more useful with the alternatives
    // beside it, and a measured value having no setter being a decision rather than a gap.
    const unclaimed = await client.send('tools/call', { name: 'set_state', arguments: { peer: plantName, namespace: 'vent', path: 'pressure', value: 3 } })
    t.true(toolText(unclaimed).isError)
    t.regex(toolText(unclaimed).text, /declares that it sets 'pressure'/)
    t.regex(toolText(unclaimed).text, /open \(setOpen\)/, 'the refusal should say what it does set')

    // Refused locally, against the published state type, before anything travels.
    const wrongType = await set('zones.top.setpoint', 'hot')
    t.true(toolText(wrongType).isError)
    t.regex(toolText(wrongType).text, /before sending/)

    // The generic setter's own body still decides: a path it will not take is its refusal to make.
    const refused = await set('tags.a', 'warm')
    t.true(toolText(refused).isError, 'a string is not a tag value')

    t.deepEqual(client.stray, [], 'stdout must carry protocol and nothing else')

    client.close()
    await plant.close()
    await hub.close()
})

/** Speak the streamable HTTP door the way a second client would: one POST, one JSON answer. */
const doorPost = async (port: number, message: Record<string, unknown>, token?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...message })
    })

test('the HTTP door shares one node: what stdio stood up, a second client sees', async (t) => {
    const hub = new RpcServer({ name: peer('hub-door'), transports: [{ port: 3975, host: '127.0.0.1' }] })
    await hub.ready()

    const client = mcpClient(3975, ['--port', '8675'])
    await client.ready
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-side', version: '1' } })
    client.notify('notifications/initialized')

    // The first door stands a fake up...
    const contract = { schema: 1, namespaces: { plant: { version: '1.0.0', methods: { read: { params: [], paramNames: [] } } } } }
    const started = await client.send('tools/call', {
        name: 'start_fake',
        arguments: { name: peer('doorFake'), schema: contract, script: { returns: { 'plant.read': { celsius: 84 } } } }
    })
    t.false(toolText(started).isError, toolText(started).text)

    // ...and the second door, a plain HTTP client, initializes and finds it: one process, one set
    // of fakes, which is the whole reason the door exists.
    const initialized = await doorPost(8675, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-side', version: '1' } } })
    t.is(initialized.status, 200)
    const initBody = (await initialized.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
    t.is(initBody.result.serverInfo.name, 'source-rpc')

    const noted = await doorPost(8675, { method: 'notifications/initialized' })
    t.is(noted.status, 202, 'a notification is taken and not answered, which over HTTP is 202')

    const listed = await doorPost(8675, { id: 2, method: 'tools/call', params: { name: 'list_fakes', arguments: {} } })
    const listBody = (await listed.json()) as { result: { content: { text: string }[] } }
    t.true(listBody.result.content[0].text.includes(peer('doorFake')), `the stdio side's fake must be visible here, got: ${listBody.result.content[0].text}`)

    // GET has nothing to offer - this server initiates no messages - and says so with 405.
    const got = await fetch('http://127.0.0.1:8675/mcp')
    t.is(got.status, 405)

    client.close()
    await hub.close()
})

test('the door with a token refuses bare requests, and a wide bind without one refuses to start', async (t) => {
    const hub = new RpcServer({ name: peer('hub-door2'), transports: [{ port: 3976, host: '127.0.0.1' }] })
    await hub.ready()

    const client = mcpClient(3976, ['--port', '8676'], { SOURCE_RPC_MCP_TOKEN: 'door-secret' })
    await client.ready

    const bare = await doorPost(8676, { id: 1, method: 'tools/list' })
    t.is(bare.status, 401, 'no token, no entry')
    const keyed = await doorPost(8676, { id: 2, method: 'tools/list' }, 'door-secret')
    t.is(keyed.status, 200)
    const tools = (await keyed.json()) as { result: { tools: { name: string }[] } }
    t.true(tools.result.tools.some((tool) => tool.name === 'list_peers'))
    client.close()

    // Fail closed before the port opens: a wide door with no lock is refused, not warned about.
    const wide = mcpClient(3976, ['--port', '8677', '--host', '0.0.0.0'])
    const exit = await new Promise<number | null>((resolveExit) => wide.child.on('exit', (code) => resolveExit(code)))
    t.is(exit, 1, 'a wide bind without a token must not start')

    await hub.close()
})
