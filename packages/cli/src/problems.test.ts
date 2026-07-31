import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer } from '@source-repo/rpc'
import { consoleIdentityPath, startConsole, type NetworkProblem } from './console.js'

/**
 * The four things transports have always reported and nothing ever listened to.
 *
 * Nothing here touches MQTT: a socket.io hub provokes the same reports and runs everywhere.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

interface ConsolePeer {
    peers(): Promise<{ peers: string[]; links: { [peer: string]: string } }>
    problems(): Promise<{ problems: NetworkProblem[] }>
    on(event: string, handler: (...args: unknown[]) => void): Promise<unknown>
}

const pageOn = async (url: string, as?: string) => {
    const { name } = (await (await fetch(`${url}${consoleIdentityPath}`)).json()) as { name: string }
    const client = new RpcClient(url, { defaultTarget: name, callTimeout: 8000, readyTimeout: 8000, ...(as ? { name: as } : {}) })
    return { client, remote: (await client.proxy<ConsolePeer>('console')).remote }
}

test('a frame with nowhere to go is reported, streamed and kept', async (t) => {
    const hub = new RpcServer({ name: peer('hub'), transports: [{ port: 3971 }] })
    await hub.ready()
    const running = await startConsole({ hub: 'http://localhost:3971', port: 7398, host: '127.0.0.1', name: peer('console-problems'), callTimeout: 2000 })
    const { client, remote } = await pageOn(running.url)

    const streamed: NetworkProblem[] = []
    await remote.on('problem', (problem: unknown) => void streamed.push(problem as NetworkProblem))

    // A page is a peer of the console, so addressing a name nothing answers to makes the console's
    // own transport report a frame it cannot deliver - the ordinary shape of "the call just timed
    // out", now with a reason attached.
    const nowhere = await client.proxy<{ read(): Promise<unknown> }>('plant', 'no-such-device')
    await t.throwsAsync(nowhere.remote.read())

    await waitFor(() => streamed.some((problem) => problem.kind === 'unroutable'))
    const reported = streamed.find((problem) => problem.kind === 'unroutable')!
    t.is(reported.target, 'no-such-device')
    t.truthy(reported.reason, 'a problem with no reason is no better than a timeout')
    t.truthy(reported.link)
    t.is(typeof reported.at, 'number')

    // Kept as well as streamed: a page opened after the fact still sees it, which is the usual way
    // round - nobody opens the console until something is already wrong.
    const { problems: history } = await remote.problems()
    t.true(history.some((problem) => problem.kind === 'unroutable' && problem.target === 'no-such-device'))
    // Newest first, so the page renders them in the order it receives them.
    t.true(history[0].at >= history[history.length - 1].at)

    await client.close()
    await running.close()
    await hub.close()
})

test('the console reports which link each peer arrived on', async (t) => {
    const hub = new RpcServer({ name: peer('hub-links'), transports: [{ port: 3972 }] })
    await hub.ready()
    const device = peer('kiln')
    const server = new RpcServer({ name: device, transports: [{ connect: 'http://localhost:3972' }] })
    await server.ready()

    const running = await startConsole({ hub: 'http://localhost:3972', port: 7399, host: '127.0.0.1', name: peer('console-links'), callTimeout: 2000 })
    // Named, so the assertion below is about the page and not about whichever other peer - the hub
    // is one too - happened to sort first.
    const page = peer('page-links')
    const { client, remote } = await pageOn(running.url, page)

    const state = await (async () => {
        const deadline = Date.now() + 8000
        for (;;) {
            const seen = await remote.peers()
            if (seen.peers.includes(device) || Date.now() > deadline) return seen
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
    })()

    t.true(state.peers.includes(device), `peers: ${JSON.stringify(state.peers)}`)
    // The device came over the hub; the page came over the link the console serves itself.
    t.is(state.links[device], 'http://localhost:3972')
    t.is(state.links[page], 'this console', `links: ${JSON.stringify(state.links)}`)

    await client.close()
    await running.close()
    await server.close()
    await hub.close()
})

test('a name two peers claim is reported rather than left to look like a flapping link', async (t) => {
    const hub = new RpcServer({ name: peer('hub-displaced'), transports: [{ port: 3973 }] })
    await hub.ready()
    const running = await startConsole({ hub: 'http://localhost:3973', port: 7400, host: '127.0.0.1', name: peer('console-displaced'), callTimeout: 2000 })
    const { client, remote } = await pageOn(running.url)

    const streamed: NetworkProblem[] = []
    await remote.on('problem', (problem: unknown) => void streamed.push(problem as NetworkProblem))

    // Two connections announcing one name to the console's own server: the second takes the route
    // over, and calls to that name reach whichever arrived last.
    const twin = peer('twin')
    const first = new RpcClient(running.url, { name: twin, callTimeout: 2000, readyTimeout: 4000 })
    await first.ready()
    const second = new RpcClient(running.url, { name: twin, callTimeout: 2000, readyTimeout: 4000 })
    await second.ready()

    await waitFor(() => streamed.some((problem) => problem.kind === 'peerDisplaced' && problem.peer === twin))
    const reported = streamed.find((problem) => problem.kind === 'peerDisplaced')!
    t.is(reported.peer, twin)
    t.regex(String(reported.reason), /claimed this name/)

    await first.close()
    await second.close()
    await client.close()
    await running.close()
    await hub.close()
})
