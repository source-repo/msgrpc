import anyTest, { TestFn } from 'ava'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { connectAsync } from 'mqtt'
import { MqttTransport, RpcClient, RpcServer, SocketIoClientTransport, TransportEvent } from './index.js'

/**
 * Discovery and routing over socket.io.
 *
 * MQTT has had both for free: retained presence says who is there, and a peer subscribes to its own
 * topic so nothing else can receive its frames. socket.io had neither - a server learned a peer only
 * from a frame it sent, so a peer that merely listened was invisible and unaddressable, and a frame
 * for someone else was executed by whoever it happened to reach.
 */

const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

/**
 * Test peers get a short session expiry. Names are unique per run, so the broker's hour-long default
 * would leave a fresh session behind on every run until it refused new connections.
 */
const TEST_SESSION_EXPIRY = 10

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

/** See Mqtt.test.ts: a peer name is the broker's client id, so it cannot be shared across runs. */
const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const prefixFor = (name: string) => `msgrpc/${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

class Boiler extends EventEmitter {
    constructor(public label = 'the addressee') {
        super()
    }
    async whoAnswered() {
        return this.label
    }
    async setTemperature(celsius: number) {
        this.emit('changed', celsius)
        return celsius
    }
}

interface Context {
    skipped: boolean
}
const test = anyTest as TestFn<Context>

test.before(async (t) => {
    t.context = { skipped: !(await brokerAvailable()) }
})

// ---------------------------------------------------------------- socket.io only

test.serial('a peer that only listens is discovered, and can be called through the hub', async (t) => {
    const hub = new RpcServer({ name: peer('hub1'), transports: [{ port: 3971 }] })
    await hub.ready()

    // A browser cannot listen. Dialling out is the only way it can host an RpcServer at all.
    const dialled = new RpcServer({ name: peer('browserServer1'), transports: [{ connect: 'http://localhost:3971' }] })
    dialled.exposeClassInstance(new Boiler(), 'boiler')
    await dialled.ready()

    const caller = new RpcClient('http://localhost:3971', { name: peer('caller1'), defaultTarget: peer('browserServer1'), callTimeout: 4000 })
    const discovered: string[] = []
    caller.options.transport!.on(TransportEvent.peerOnline, (found: string) => discovered.push(found))
    await caller.ready()

    // It has never spoken to the caller, and the caller has never been told it exists.
    await waitFor(() => discovered.includes(peer('browserServer1')))
    t.true(discovered.includes(peer('browserServer1')), `discovered: ${JSON.stringify(discovered)}`)
    t.is(await (await caller.proxy<Boiler>('boiler')).remote!.whoAnswered(), 'the addressee')

    const departed: string[] = []
    caller.options.transport!.on(TransportEvent.peerGone, (gone: string) => departed.push(gone))
    await dialled.close()
    await waitFor(() => departed.includes(peer('browserServer1')))
    t.deepEqual(departed, [peer('browserServer1')])

    await caller.close()
    await hub.close()
})

test.serial('a call addressed to another peer is not executed by the server it passes through', async (t) => {
    // The hub exposes the same namespace, which is what makes the misdelivery visible rather than
    // merely wrong: before this, the caller got the hub's answer and had no way to tell.
    const hub = new RpcServer({ name: peer('hub2'), transports: [{ port: 3972 }] })
    hub.exposeClassInstance(new Boiler('the hub'), 'boiler')
    await hub.ready()

    const other = new RpcServer({ name: peer('otherPeer2'), transports: [{ connect: 'http://localhost:3972' }] })
    other.exposeClassInstance(new Boiler('the addressee'), 'boiler')
    await other.ready()

    const caller = new RpcClient('http://localhost:3972', { name: peer('caller2'), callTimeout: 4000 })
    await caller.ready()
    await waitFor(() => (hub.transports[0] as unknown as { peerSockets: Map<string, unknown> }).peerSockets.has(peer('otherPeer2')))

    t.is(await (await caller.proxy<Boiler>('boiler', peer('otherPeer2'))).remote!.whoAnswered(), 'the addressee')
    // Addressed to the hub it is still the hub that answers, which is the ordinary case.
    t.is(await (await caller.proxy<Boiler>('boiler', peer('hub2'))).remote!.whoAnswered(), 'the hub')

    await caller.close()
    await other.close()
    await hub.close()
})

test.serial('a relay rule decides per connection, and covers the reply', async (t) => {
    const refused: unknown[] = []
    const hub = new RpcServer({
        name: peer('hub3'),
        transports: [{ port: 3973 }],
        // Written the way anyone would write it: about the caller, saying nothing about replies.
        relay: ({ source }) => source === peer('allowed3')
    })
    hub.exposeClassInstance(new Boiler('the hub'), 'boiler')
    await hub.ready()
    hub.transports[0].on(TransportEvent.unroutable, (info: unknown) => refused.push(info))

    const backend = new RpcServer({ name: peer('backend3'), transports: [{ connect: 'http://localhost:3973' }] })
    backend.exposeClassInstance(new Boiler('the addressee'), 'boiler')
    await backend.ready()
    await waitFor(() => (hub.transports[0] as unknown as { peerSockets: Map<string, unknown> }).peerSockets.has(peer('backend3')))

    const allowed = new RpcClient('http://localhost:3973', { name: peer('allowed3'), defaultTarget: peer('backend3'), callTimeout: 4000 })
    await allowed.ready()
    // The answer travels the other way, so a rule tested per frame would strand it.
    t.is(await (await allowed.proxy<Boiler>('boiler')).remote!.whoAnswered(), 'the addressee')

    const denied = new RpcClient('http://localhost:3973', { name: peer('denied3'), defaultTarget: peer('backend3'), callTimeout: 700 })
    await denied.ready()
    const error = await t.throwsAsync(async () => (await denied.proxy<Boiler>('boiler')).remote!.whoAnswered())
    // Refused, not quietly served by the hub's own instance - that would be the misdelivery again,
    // handed to a caller who was specifically not allowed to reach the peer it asked for.
    t.is((error as { code?: string }).code, 'Timeout')
    t.true(refused.length >= 1, 'a refused relay should be reported as unroutable')

    await allowed.close()
    await denied.close()
    await backend.close()
    await hub.close()
})

test.serial('relay false forwards nothing', async (t) => {
    const hub = new RpcServer({ name: peer('hub4'), transports: [{ port: 3974 }], relay: false })
    await hub.ready()
    const hidden = new RpcServer({ name: peer('hidden4'), transports: [{ connect: 'http://localhost:3974' }] })
    hidden.exposeClassInstance(new Boiler(), 'boiler')
    await hidden.ready()

    const caller = new RpcClient('http://localhost:3974', { name: peer('caller4'), defaultTarget: peer('hidden4'), callTimeout: 700 })
    await caller.ready()
    // Still discovered - presence is not routing, and knowing who is there is not the same as
    // being allowed to reach them.
    await waitFor(() => (caller.options.transport as SocketIoClientTransport).knownPeers.has(peer('hidden4')))
    const error = await t.throwsAsync(async () => (await caller.proxy<Boiler>('boiler')).remote!.whoAnswered())
    t.is((error as { code?: string }).code, 'Timeout')

    await caller.close()
    await hidden.close()
    await hub.close()
})

test.serial('an announced name has to match the identity the connection authenticated as', async (t) => {
    const rejected: { source?: string; reason?: string }[] = []
    const hub = new RpcServer({
        name: peer('hub5'),
        transports: [{ port: 3975 }],
        authenticate: async (credentials) => {
            const token = (credentials as { token?: string })?.token
            return token ? { name: token } : undefined
        }
    })
    await hub.ready()
    hub.transports[0].on(TransportEvent.rejected, (info: { source?: string; reason?: string }) => rejected.push(info))

    // Authenticates as one peer and announces itself as another, which would otherwise put it in
    // everyone's peer list under a name it has no claim to, and make it addressable there.
    const impostor = new SocketIoClientTransport(peer('someoneElse5'), 'http://localhost:3975', [], { auth: { token: peer('honest5') } })
    await impostor.open()
    await waitFor(() => rejected.length > 0)
    t.regex(String(rejected[0].reason), /announced name does not match/)

    await impostor.close()
    await hub.close()
})

test.serial('a server calls out over its own connection, under its own name', async (t) => {
    // A peer on a bus is rarely only a server. Doing this with a separate RpcClient means a second
    // name and a second connection, which over MQTT is a second broker session.
    const hub = new RpcServer({ name: peer('hub6'), transports: [{ port: 3977 }] })
    await hub.ready()

    const cell = new RpcServer({ name: peer('cell6'), transports: [{ connect: 'http://localhost:3977' }], callTimeout: 4000 })
    cell.exposeClassInstance(new Boiler('the cell'), 'boiler')
    await cell.ready()
    const oven = new RpcServer({ name: peer('oven6'), transports: [{ connect: 'http://localhost:3977' }], callTimeout: 4000 })
    oven.exposeClassInstance(new Boiler('the oven'), 'boiler')
    await oven.ready()
    await waitFor(() => (hub.transports[0] as unknown as { peerSockets: Map<string, unknown> }).peerSockets.has(peer('oven6')))

    t.is(await (await cell.proxy<Boiler>('boiler', peer('oven6'))).remote!.whoAnswered(), 'the oven')
    t.is(await (await oven.proxy<Boiler>('boiler', peer('cell6'))).remote!.whoAnswered(), 'the cell')

    // Events too, so a server can watch its peers rather than poll them.
    const heard: number[] = []
    const watched = await cell.proxy<Boiler>('boiler', peer('oven6'))
    await watched.remote!.on('changed', (value: number) => heard.push(value))
    await watched.remote!.setTemperature(70)
    await waitFor(() => heard.length === 1)
    t.deepEqual(heard, [70])

    await oven.close()
    await cell.close()
    await hub.close()
})

test.serial('a peer two hops away is discovered, called and watched', async (t) => {
    const bus = new RpcServer({ name: peer('bus7'), transports: [{ port: 3978 }] })
    await bus.ready()
    // A cell controller: a hub for its own panels, and a member of the bus.
    const cell = new RpcServer({ name: peer('cellCtl7'), transports: [{ port: 3979 }, { connect: 'http://localhost:3978' }] })
    await cell.ready()

    const hmi = new RpcClient('http://localhost:3978', { name: peer('hmi7'), callTimeout: 4000 })
    const seen: string[] = []
    hmi.options.transport!.on(TransportEvent.peerOnline, (found: string) => seen.push(found))
    hmi.options.transport!.on(TransportEvent.peerGone, (gone: string) => seen.push(`-${gone}`))
    await hmi.ready()

    // The panel knows only its cell controller, and the HMI only the bus.
    const panel = new RpcServer({ name: peer('panel7'), transports: [{ connect: 'http://localhost:3979' }] })
    const boiler = new Boiler('the panel')
    panel.exposeClassInstance(boiler, 'boiler')
    await panel.ready()

    await waitFor(() => seen.includes(peer('panel7')), 8000)
    const proxy = await hmi.proxy<Boiler>('boiler', peer('panel7'))
    t.is(await proxy.remote!.whoAnswered(), 'the panel')

    const heard: number[] = []
    await proxy.remote!.on('changed', (value: number) => heard.push(value))
    await proxy.remote!.setTemperature(91)
    await waitFor(() => heard.length === 1)
    t.deepEqual(heard, [91])

    // Departure travels the same way, so nothing is left listed and unreachable.
    await panel.close()
    await waitFor(() => seen.includes(`-${peer('panel7')}`), 8000)
    t.true(seen.includes(`-${peer('panel7')}`))

    await hmi.close()
    await cell.close()
    await bus.close()
})

test.serial('two hubs dialling each other do not storm or loop', async (t) => {
    const hubA = new RpcServer({ name: peer('hubA8'), transports: [{ port: 3981 }] })
    await hubA.ready()
    const hubB = new RpcServer({ name: peer('hubB8'), transports: [{ port: 3982 }, { connect: 'http://localhost:3981' }] })
    await hubB.ready()
    // Closes the cycle: now each hub is reachable from the other in both directions.
    const backLink = new RpcServer({ name: peer('backLink8'), transports: [{ connect: 'http://localhost:3982' }] })
    await backLink.ready()

    const service = new RpcServer({ name: peer('service8'), transports: [{ connect: 'http://localhost:3981' }] })
    service.exposeClassInstance(new Boiler('across the cycle'), 'boiler')
    await service.ready()

    const client = new RpcClient('http://localhost:3982', { name: peer('client8'), callTimeout: 4000 })
    const events: string[] = []
    client.options.transport!.on(TransportEvent.peerOnline, (found: string) => events.push(found))
    client.options.transport!.on(TransportEvent.peerGone, (gone: string) => events.push(`-${gone}`))
    await client.ready()

    await waitFor(() => events.includes(peer('service8')), 8000)
    t.is(await (await client.proxy<Boiler>('boiler', peer('service8'))).remote!.whoAnswered(), 'across the cycle')

    // Split horizon is what keeps this finite: without it the two hubs advertise each other's peers
    // back and forth and the presence traffic never settles.
    const settled = events.length
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.is(events.length, settled, `presence kept churning: ${JSON.stringify(events)}`)

    await client.close()
    await service.close()
    await backLink.close()
    await hubB.close()
    await hubA.close()
})

// ---------------------------------------------------------------- mixed with a broker

const skipWithoutBroker = (t: { context: Context; pass: (m?: string) => void }) => {
    if (t.context.skipped) t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
    return t.context.skipped
}

test.serial('a socket.io peer discovers and calls a peer that only exists on the broker', async (t) => {
    if (skipWithoutBroker(t)) return
    const prefix = prefixFor('bridge')
    const plant = new RpcServer({ name: peer('plantSrv'), transports: [{ brokerurl: BROKER_URL, sessionExpirySeconds: TEST_SESSION_EXPIRY, prefix }] })
    const boiler = new Boiler()
    plant.exposeClassInstance(boiler, 'boiler')
    await plant.ready()

    // One server holding both links is the whole of the bridge: a socket.io listener for browsers
    // and a broker connection for the plant. Neither side knows the other's transport exists.
    const bridge = new RpcServer({
        name: peer('bridge'),
        transports: [{ port: 3976 }, new MqttTransport(peer('bridge'), BROKER_URL, { prefix, sessionExpirySeconds: TEST_SESSION_EXPIRY })]
    })
    await bridge.ready()

    const browser = new RpcClient('http://localhost:3976', { name: peer('browserPeer'), defaultTarget: peer('plantSrv'), callTimeout: 6000 })
    await browser.ready()
    await waitFor(() => (browser.options.transport as SocketIoClientTransport).knownPeers.has(peer('plantSrv')), 8000)

    const proxy = await browser.proxy<Boiler>('boiler')
    t.is(await proxy.remote!.whoAnswered(), 'the addressee')

    // Events come back the same way, and the far server sees the browser peer as the subscriber
    // rather than the bridge, so its per-peer bookkeeping still means something.
    const received: number[] = []
    await proxy.remote!.on('changed', (value: number) => received.push(value))
    await proxy.remote!.setTemperature(85)
    await waitFor(() => received.length === 1)
    t.deepEqual(received, [85])
    t.is(plant.rpc.eventProxies.size, 1)

    // And when it leaves, the subscription goes with it. A peer on the far side of a bridge has no
    // presence of its own, so the bridge publishes it - without that the listener leaked forever.
    await browser.close()
    await waitFor(() => plant.rpc.eventProxies.size === 0, 8000)
    t.is(boiler.listenerCount('changed'), 0, 'the exposed instance kept a listener for a peer that left')

    await bridge.close()
    await plant.close()
})


test('a second peer announcing a live name takes the address, and says so', async (t) => {
    // Deliberate rather than refused: a peer reconnecting after a blip announces itself while the
    // server may still hold the dead socket, and refusing it would lock a peer out of its own name.
    // Silent is the part that hurts - two peers really sharing a name send each other's replies
    // into the wrong socket, which reads as calls timing out for no reason at all.
    const hub = new RpcServer({ name: peer('hub9'), transports: [{ port: 3983 }] })
    await hub.ready()
    const displaced: string[] = []
    hub.transports[0].on(TransportEvent.peerDisplaced, (name: string) => displaced.push(name))

    const first = new RpcClient('http://localhost:3983', { name: peer('twin'), defaultTarget: peer('hub9'), callTimeout: 4000 })
    await first.ready()
    await waitFor(() => hub.peers.names().includes(peer('twin')))
    t.deepEqual(displaced, [], 'the first arrival displaces nobody')

    const second = new RpcClient('http://localhost:3983', { name: peer('twin'), defaultTarget: peer('hub9'), callTimeout: 4000 })
    await second.ready()
    await waitFor(() => displaced.length > 0)
    t.deepEqual(displaced, [peer('twin')], 'the collision should be reported, not swallowed')
    t.true(hub.peers.names().includes(peer('twin')), 'the name stays routable, now to the newcomer')

    await second.close()
    await first.close()
    await hub.close()
})
