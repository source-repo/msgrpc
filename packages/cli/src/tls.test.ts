import test from 'ava'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'crypto'
import {
    defaultSecureWebPort,
    defaultSecureWebSocketPort,
    defaultWebPort,
    defaultWebSocketPort,
    RpcServer,
    SocketIoClientTransport
} from '@source-repo/rpc'
import { startConsole } from './console.js'
import { startBroker } from './broker.js'

/**
 * Serving with a certificate, and the port convention that goes with it: 7843/7844 in the clear,
 * 8843/8844 encrypted. The numbers are a convention and nothing enforces them - what is enforced is
 * that a server handed a certificate moves to its encrypted port by itself, so nobody has to
 * remember which one it was.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

/** A throwaway certificate for 127.0.0.1. Generated rather than committed: a key in a repository is a published key. */
const selfSigned = () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-rpc-tls-'))
    const keyPath = join(directory, 'key.pem')
    const certPath = join(directory, 'cert.pem')
    execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1'
        // openssl narrates its key generation on stderr, which is a page of dots per test.
    ], { stdio: 'ignore' })
    return { directory, tls: { key: readFileSync(keyPath), cert: readFileSync(certPath) } }
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

test('the encrypted ports are a thousand above the plain ones, not next to them', (t) => {
    t.is(defaultWebSocketPort, 7843)
    t.is(defaultWebPort, 7844)
    t.is(defaultSecureWebSocketPort, 8843)
    t.is(defaultSecureWebPort, 8844)

    // The gap is the point: no range covers a plain port and an encrypted one, so `allow 7843:7846`
    // cannot open the clear-text bus by fencepost while meaning to publish only the encrypted one.
    t.true(defaultSecureWebSocketPort - defaultWebSocketPort > 4)
    // And the last two digits still match, which is what makes the pair one thing to remember.
    t.is(defaultSecureWebSocketPort % 100, defaultWebSocketPort % 100)
    t.is(defaultSecureWebPort % 100, defaultWebPort % 100)
})

test('a console given a certificate serves https, and reports the url that works', async (t) => {
    const { directory, tls } = selfSigned()
    const hub = new RpcServer({ name: peer('tlsHub'), transports: [{ port: 7521 }] })
    await hub.ready()

    const running = await startConsole({
        hub: 'http://localhost:7521',
        port: 7522,
        host: '127.0.0.1',
        name: peer('tlsConsole'),
        callTimeout: 5000,
        tls
    })

    t.is(running.url, 'https://127.0.0.1:7522', 'a startup line has to print the url that actually works')

    const identity = await getOverTls(`${running.url}/console.json`, tls.cert)
    t.is(identity.status, 200)
    t.is((JSON.parse(identity.body) as { name: string }).name, peer('tlsConsole'))

    await running.close()
    await hub.close()
    rmSync(directory, { recursive: true, force: true })
})

test('a broker given a certificate serves wss, and a peer that trusts it gets through', async (t) => {
    const { directory, tls } = selfSigned()
    const running = await startBroker({ port: 7523, name: peer('tlsBus'), tls })

    // The transport is built here rather than with `{ connect }`, because a private certificate
    // authority has nowhere to go in ConnectServerOptions - `allowInsecureTls` would prove only
    // that something answered, which is the opposite of what this test is for.
    const trusted = new SocketIoClientTransport(peer('tlsPeer'), 'https://127.0.0.1:7523', [], { ca: tls.cert } as never)
    const client = new RpcServer({ name: peer('tlsPeer'), transports: [trusted], readyTimeout: 10000 })
    await client.ready()

    t.true(await client.awaitPeer(peer('tlsBus'), 8000), 'the bus never became addressable over TLS')

    await client.close()
    await running.close()
    rmSync(directory, { recursive: true, force: true })
})
