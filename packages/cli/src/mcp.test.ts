import test from 'ava'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rpc, rpcNamespace, RpcServer } from '@source-repo/msgrpc'

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
const mcpClient = (port: number, extra: string[] = []) => {
    const child = spawn(process.execPath, [cli, 'mcp', '--hub', `http://localhost:${port}`, '--name', peer(`mcp${port}`), '--timeout', '5000', ...extra], {
        stdio: ['pipe', 'pipe', 'pipe']
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
            if (chunk.includes('msgrpc mcp:')) resolvePromise()
        })
    })
    return { child, send, notify, ready, stray, close: () => child.kill() }
}

const toolText = (response: Record<string, unknown>) => {
    const result = response.result as { content?: { text?: string }[]; isError?: boolean } | undefined
    return { text: result?.content?.[0]?.text ?? '', isError: !!result?.isError }
}

test('an MCP client can list, describe and call the peers on an msgrpc network', async (t) => {
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
    t.is(initResult.serverInfo.name, 'msgrpc')
    client.notify('notifications/initialized')

    const listed = await client.send('tools/list')
    const tools = (listed.result as { tools: { name: string; inputSchema: unknown }[] }).tools
    t.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['call_method', 'check_peer', 'describe_peer', 'diff_peers', 'list_fakes', 'list_peers', 'start_fake', 'stop_fake', 'watch_events', 'watch_traffic']
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
