import test from 'ava'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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
const mcpClient = (port: number) => {
    const child = spawn(process.execPath, [cli, 'mcp', '--hub', `http://localhost:${port}`, '--name', peer('mcp'), '--timeout', '5000'], {
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
        ['call_method', 'describe_peer', 'list_peers']
    )
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
