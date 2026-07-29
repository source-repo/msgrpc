import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcServer, rpc, rpcNamespace, type RpcSchema } from '@source-repo/msgrpc'
import { startFake } from './fake.js'
import { bench } from './bench.js'

/** One method over and over, and what it cost. Socket.io only, so it runs anywhere. */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '1',
            methods: { read: { params: [], returns: { kind: 'object', fields: { celsius: { type: { kind: 'number' } } } } }, halt: { params: [] } },
            events: {}
        }
    }
}

let port = 8170

test('it reports percentiles and the rate it actually achieved', async (t) => {
    const hubPort = port++
    const hub = `http://localhost:${hubPort}`
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    const device = peer(`plant${hubPort}`)
    const fake = await startFake({ hub, name: device, callTimeout: 5000, schema })

    const report = await bench({
        hub,
        name: peer(`bench${hubPort}`),
        callTimeout: 5000,
        peer: device,
        namespace: 'plant',
        method: 'read',
        args: [],
        rate: 40,
        forMs: 1500,
        concurrency: 50
    })

    t.true(report.calls > 10, `only ${report.calls} calls`)
    t.is(report.failed, 0)
    t.is(report.ok, report.calls)
    // Percentiles are ordered by construction, and an average would hide the tail this exists for.
    t.true(report.ms.p50 <= report.ms.p95)
    t.true(report.ms.p95 <= report.ms.max)
    t.true(report.ms.min <= report.ms.p50)
    t.is(report.rate.asked, 40)
    t.true(report.rate.achieved > 0)
    t.true(report.ranForMs >= 1400, `ran for ${report.ranForMs} ms`)
    t.is(report.method, 'plant.read')

    await fake.close()
    await bus.close()
})

test('failures are counted by code rather than lumped together', async (t) => {
    const hubPort = port++
    const hub = `http://localhost:${hubPort}`
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    const device = peer(`plant${hubPort}`)
    const fake = await startFake({ hub, name: device, callTimeout: 5000, schema, script: { fails: { 'plant.halt': 'Unauthorized' } } })

    const report = await bench({
        hub,
        name: peer(`bench${hubPort}`),
        callTimeout: 5000,
        peer: device,
        namespace: 'plant',
        method: 'halt',
        args: [],
        rate: 20,
        forMs: 800,
        concurrency: 50
    })

    t.is(report.ok, 0)
    t.true(report.failed > 0)
    // A device refusing arguments and a device that stopped answering are different findings.
    t.is(report.codes.Unauthorized, report.failed)

    await fake.close()
    await bus.close()
})

@rpcNamespace('slow')
class Slow {
    @rpc
    async crawl() {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return true
    }
}

test('a device that cannot keep up shows as fallen behind, not as good latency', async (t) => {
    const hubPort = port++
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    const device = peer(`slow${hubPort}`)
    const server = new RpcServer({ name: device, transports: [{ connect: `http://localhost:${hubPort}` }], exposeIntrospection: true })
    server.exposeClassInstance(new Slow())
    await server.ready()

    // 50 a second at a method that takes 300 ms, with only 3 allowed outstanding: most of the calls
    // cannot be sent. Piling them on would measure the queue rather than the device.
    const report = await bench({
        hub: `http://localhost:${hubPort}`,
        name: peer(`bench${hubPort}`),
        callTimeout: 8000,
        peer: device,
        namespace: 'slow',
        method: 'crawl',
        args: [],
        rate: 50,
        forMs: 1500,
        concurrency: 3
    })

    t.true(report.behind > 0, 'a device that cannot keep up should be reported as such')
    t.true(report.calls <= 3 + Math.ceil(1500 / 300) * 3, `sent ${report.calls} with 3 allowed outstanding`)
    t.true(report.ms.p50 >= 250, `p50 was ${report.ms.p50}, which is not the 300 ms the method takes`)

    await server.close()
    await bus.close()
})

test('a peer that is not there is a sentence, not a run of timeouts', async (t) => {
    const hubPort = port++
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    await t.throwsAsync(
        bench({
            hub: `http://localhost:${hubPort}`,
            name: peer(`bench${hubPort}`),
            callTimeout: 2000,
            peer: 'no-such-device',
            namespace: 'plant',
            method: 'read',
            args: [],
            rate: 10,
            forMs: 500,
            concurrency: 10,
            wait: 300
        }),
        { message: /did not appear within 300 ms/ }
    )
    await bus.close()
})
