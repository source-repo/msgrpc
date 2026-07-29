import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer } from '@source-repo/rpc'
import { startBroker } from './broker.js'

/** Nothing here touches MQTT: the point of a WebSocket bus is to work where there is no broker. */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

class Panel {
    async status() {
        return 'the panel answered'
    }
}

test('a broker relays between the peers that join it', async (t) => {
    const arrivals: string[] = []
    const bus = await startBroker({ port: 8071, name: peer('bus'), onPeer: (name, state) => arrivals.push(`${state === 'online' ? '+' : '-'}${name}`) })

    const panel = new RpcServer({ name: peer('panel'), transports: [{ connect: 'http://localhost:8071' }] })
    panel.exposeClassInstance(new Panel(), 'panel')
    await panel.ready()

    const hmi = new RpcClient('http://localhost:8071', { name: peer('hmi'), callTimeout: 4000 })
    await hmi.ready()
    await waitFor(() => bus.peers().includes(peer('panel')))

    t.is(await (await hmi.proxy<Panel>('panel', peer('panel'))).remote!.status(), 'the panel answered')
    t.deepEqual(bus.peers(), [peer('hmi'), peer('panel')].sort())
    t.true(arrivals.includes(`+${peer('panel')}`))

    await panel.close()
    await waitFor(() => arrivals.includes(`-${peer('panel')}`))

    await hmi.close()
    await bus.close()
})

test('two brokers joined by --upstream are one network', async (t) => {
    const plant = await startBroker({ port: 8072, name: peer('plantBus') })
    const cell = await startBroker({ port: 8073, name: peer('cellBus'), upstream: ['http://localhost:8072'] })

    // The panel joins the cell bus and knows nothing of the plant bus.
    const panel = new RpcServer({ name: peer('panel2'), transports: [{ connect: 'http://localhost:8073' }] })
    panel.exposeClassInstance(new Panel(), 'panel')
    await panel.ready()

    // The HMI joins the plant bus and knows nothing of the cell bus.
    const hmi = new RpcClient('http://localhost:8072', { name: peer('hmi2'), callTimeout: 5000 })
    await hmi.ready()

    await waitFor(() => plant.peers().includes(peer('panel2')))
    t.is(await (await hmi.proxy<Panel>('panel', peer('panel2'))).remote!.status(), 'the panel answered')

    await panel.close()
    // The departure crosses back the other way, so nothing is left listed and unreachable.
    await waitFor(() => !plant.peers().includes(peer('panel2')))
    t.false(plant.peers().includes(peer('panel2')))

    await hmi.close()
    await cell.close()
    await plant.close()
})

test('a broker that cannot bind says so instead of claiming it started', async (t) => {
    const first = await startBroker({ port: 8074, name: peer('first') })
    await t.throwsAsync(startBroker({ port: 8074, name: peer('second') }), { message: /EADDRINUSE/ })
    await first.close()
})
