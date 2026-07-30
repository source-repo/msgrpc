import test from 'ava'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenAuthenticator, RpcServer } from '@source-repo/rpc'
import { ScriptingService, scriptingAuthorizer } from './scripting.js'

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

    const remote = (await bench.proxy<Scripting>('scripting', node.name)).remote!

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

    const remote = (await stranger.proxy<Scripting>('scripting', node.name)).remote!
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
