import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcServer } from '@source-repo/rpc'
import { normaliseBasePath, startConsole } from './console.js'

/**
 * Publishing the console under a path, for a reverse proxy that forwards the prefix rather than
 * stripping it.
 *
 * Nothing here touches MQTT: it is all the console's own HTTP surface, plus one peer connecting the
 * way the page does, which is the part that would silently fall back to long polling if socket.io
 * had not moved with the rest of the app.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const BASE = '/tools/console'

/** A console and the hub it watches, each on its own ports so the tests can run alongside each other. */
const consoleAt = async (port: number, basePath?: string) => {
    const hubPort = port + 100
    const hub = new RpcServer({ name: peer(`hub${port}`), transports: [{ port: hubPort }] })
    await hub.ready()
    const name = peer(`console${port}`)
    const running = await startConsole({
        hub: `http://localhost:${hubPort}`,
        port,
        host: '127.0.0.1',
        name,
        callTimeout: 5000,
        ...(basePath ? { basePath } : {})
    })
    return {
        name,
        origin: `http://127.0.0.1:${port}`,
        url: running.url,
        close: async () => {
            await running.close()
            await hub.close()
        }
    }
}

test('a mount point is one leading and one trailing slash, or nothing at all', (t) => {
    t.is(normaliseBasePath(), '/')
    t.is(normaliseBasePath(''), '/')
    t.is(normaliseBasePath('/'), '/')
    t.is(normaliseBasePath('tools/console'), '/tools/console/')
    t.is(normaliseBasePath('/tools/console'), '/tools/console/')
    t.is(normaliseBasePath('/tools/console/'), '/tools/console/')
    t.is(normaliseBasePath('///tools/console///'), '/tools/console/')
    t.is(normaliseBasePath('  /tools/console  '), '/tools/console/')
})

test('the console serves its page, its identity and its socket under the base path', async (t) => {
    const { origin, url, name, close } = await consoleAt(7411, BASE)

    // The url it reports is where the app actually is, so a startup line can be pasted.
    t.is(url, `${origin}${BASE}/`)

    const page = await fetch(`${origin}${BASE}/`)
    t.is(page.status, 200)
    // Relative, so they resolve against the mount rather than the origin.
    t.true((await page.text()).includes('./app.js'))

    const identity = await fetch(`${origin}${BASE}/console.json`)
    t.is(identity.status, 200)
    t.is(((await identity.json()) as { name: string }).name, name)

    const handshake = await fetch(`${origin}${BASE}/socket.io/?EIO=4&transport=polling`)
    t.is(handshake.status, 200)

    await close()
})

test('the mount point without its trailing slash redirects to the one with it', async (t) => {
    const { origin, close } = await consoleAt(7412, BASE)

    // Everything the page asks for afterwards is relative. Served here instead of redirected, the
    // app would resolve `./app.js` against `/tools/` and fetch nothing that exists.
    const response = await fetch(`${origin}${BASE}`, { redirect: 'manual' })
    t.is(response.status, 301)
    t.is(response.headers.get('location'), `${BASE}/`)

    await close()
})

test('nothing of the console answers outside its base path', async (t) => {
    const { origin, close } = await consoleAt(7413, BASE)

    // The single-page fallback must not reach past the mount: the rest of this origin belongs to
    // whatever else the proxy publishes there, and answering for it would claim the lot.
    for (const path of ['/', '/console.json', '/app.js', '/socket.io/?EIO=4&transport=polling', '/somewhere/else']) {
        t.is((await fetch(`${origin}${path}`)).status, 404, path)
    }

    await close()
})

test('a peer connects the way the page does, through the base path', async (t) => {
    const { origin, name, close } = await consoleAt(7414, BASE)

    // Exactly what App.tsx builds: origin in the url, mount point in the path. socket.io reads a
    // path in the url as a namespace instead, which is why these are two separate options.
    const page = new RpcServer({
        name: peer('page'),
        transports: [{ connect: origin, path: `${BASE}/socket.io` }],
        readyTimeout: 8000
    })
    await page.ready()
    // ready() is this peer's own links, not anybody else's presence over them. Under load the
    // console's announcement lands after the first call would have gone out, and a call with no
    // route is refused rather than queued - so the wait is the test's job, as it is any caller's.
    t.true(await page.awaitPeer(name), `the console never became addressable: ${JSON.stringify(page.peers.names())}`)

    const proxy = await page.proxy<{ peers: () => Promise<{ peers: string[] }> }>('console', name)
    const { peers } = await proxy.remote!.peers()
    t.true(peers.includes(peer('page')), `console saw: ${JSON.stringify(peers)}`)

    await page.close()
    await close()
})

test('without a base path the console is unchanged at the root', async (t) => {
    const { origin, url, close } = await consoleAt(7415)

    t.is(url, origin)
    t.is((await fetch(`${origin}/`)).status, 200)
    t.is((await fetch(`${origin}/console.json`)).status, 200)
    t.is((await fetch(`${origin}/socket.io/?EIO=4&transport=polling`)).status, 200)
    // An unknown path is still a client-side route rather than a missing file.
    t.is((await fetch(`${origin}/somewhere/else`)).status, 200)

    await close()
})
