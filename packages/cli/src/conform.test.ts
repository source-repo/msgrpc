import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcServer, type RpcSchema } from '@source-repo/rpc'
import { startFake } from './fake.js'
import { checkPeer, diffPeers, schemaFromDescription } from './conform.js'

/**
 * Checking the box on the wall rather than the branch. Nothing here touches MQTT: a socket.io hub
 * carries the same describe() call.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

/** What callers were built against. */
const contract: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '3',
            methods: {
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], paramNames: ['value'], returns: { kind: 'boolean' } },
                read: { params: [], returns: { kind: 'object', fields: { celsius: { type: { kind: 'number' } } } } }
            },
            events: { alarm: { params: [{ kind: 'string' }] } }
        }
    }
}

let port = 8160
const withDevice = async (schema: RpcSchema, body: (context: { hub: string; device: string }) => Promise<void>, second?: RpcSchema) => {
    const hubPort = port++
    const hub = `http://localhost:${hubPort}`
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    const device = peer(`device${hubPort}`)
    const fake = await startFake({ hub, name: device, callTimeout: 5000, schema })
    const other = second ? await startFake({ hub, name: peer(`other${hubPort}`), callTimeout: 5000, schema: second }) : undefined
    try {
        await body({ hub, device })
    } finally {
        await other?.close()
        await fake.close()
        await bus.close()
    }
}

test('a device serving the contract it was built against is reported as such', async (t) => {
    await withDevice(contract, async ({ hub, device }) => {
        const report = await checkPeer({ hub, name: peer('checker-a'), callTimeout: 5000, peer: device, stored: contract })
        t.deepEqual(report.problems, [])
        t.deepEqual(report.missing, [])
        t.deepEqual(report.undescribed, [])
        t.deepEqual(report.checked, ['plant'])
    })
})

test('a device behind its own contract is reported in the words a stale caller would have got', async (t) => {
    // The firmware on the wall narrowed an argument and dropped a method: exactly what `check`
    // catches in CI, now caught on the device that actually shipped.
    const narrowed: RpcSchema = {
        schema: 1,
        namespaces: {
            plant: {
                version: '4',
                methods: { writeSetpoint: { params: [{ kind: 'number', min: 0, max: 500 }], paramNames: ['value'], returns: { kind: 'boolean' } } },
                events: {}
            }
        }
    }
    await withDevice(narrowed, async ({ hub, device }) => {
        const report = await checkPeer({ hub, name: peer('checker-b'), callTimeout: 5000, peer: device, stored: contract })
        t.true(report.problems.some((problem) => problem.where === 'writeSetpoint argument 0' && /narrowed/.test(problem.reason)))
        t.true(report.problems.some((problem) => problem.where === 'read' && /no longer exists/.test(problem.reason)))
        // An event the caller subscribes to and the device no longer emits is a silent failure, so
        // it is named rather than passed over.
        t.true(report.problems.some((problem) => /event alarm/.test(problem.where)))
    })
})

test('a namespace the device does not serve at all is reported apart from a changed one', async (t) => {
    const elsewhere: RpcSchema = { schema: 1, namespaces: { boiler: { version: '1', methods: { read: { params: [] } }, events: {} } } }
    await withDevice(elsewhere, async ({ hub, device }) => {
        const report = await checkPeer({ hub, name: peer('checker-c'), callTimeout: 5000, peer: device, stored: contract })
        t.deepEqual(report.missing, ['plant'])
        t.deepEqual(report.problems, [])
    })
})

test('a peer running without a contract is said to be unchecked, not passed', async (t) => {
    const hubPort = port++
    const hub = `http://localhost:${hubPort}`
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    // Exposed with no schema at all, which is what a device built before any of this looks like.
    const device = peer(`bare${hubPort}`)
    const bare = new RpcServer({ name: device, transports: [{ connect: hub }], exposeIntrospection: true })
    bare.exposeObject({ writeSetpoint: async () => true, read: async () => ({ celsius: 1 }) }, 'plant')
    await bare.ready()

    const report = await checkPeer({ hub, name: peer('checker-d'), callTimeout: 5000, peer: device, stored: contract })
    // Reporting "no breaking changes" here would be the most useful-sounding lie available.
    t.deepEqual(report.undescribed, ['plant'])
    t.deepEqual(report.problems, [])
    t.deepEqual(report.checked, [])

    await bare.close()
    await bus.close()
})

test('a peer that is not there is a sentence, not a timeout', async (t) => {
    const hubPort = port++
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    await t.throwsAsync(
        checkPeer({ hub: `http://localhost:${hubPort}`, name: peer('checker-e'), callTimeout: 2000, peer: 'no-such-device', stored: contract, wait: 300 }),
        { message: /did not appear within 300 ms/ }
    )
    await bus.close()
})

test('two cells running different firmware are compared side by side', async (t) => {
    const older: RpcSchema = {
        schema: 1,
        namespaces: {
            plant: {
                version: '2',
                methods: { writeSetpoint: { params: [{ kind: 'number' }], paramNames: ['value'], returns: { kind: 'boolean' } } },
                events: { alarm: { params: [{ kind: 'string' }] } }
            }
        }
    }
    const hubPort = port++
    const hub = `http://localhost:${hubPort}`
    const bus = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await bus.ready()
    const cell2 = peer('cell2')
    const cell3 = peer('cell3')
    const a = await startFake({ hub, name: cell2, callTimeout: 5000, schema: contract })
    const b = await startFake({ hub, name: cell3, callTimeout: 5000, schema: older })

    const { differences } = await diffPeers({ hub, name: peer('differ'), callTimeout: 5000, left: cell2, right: cell3 })

    // The usual answer: one of them is running last season's firmware.
    t.true(differences.some((difference) => difference.member === 'contract version' && difference.left === '3' && difference.right === '2'))
    // A method one has and the other does not, shown as present on one side only.
    const read = differences.find((difference) => difference.member === 'read')
    t.truthy(read, `differences: ${JSON.stringify(differences)}`)
    t.truthy(read!.left)
    t.is(read!.right, undefined)
    // And a signature that changed, rendered the way a person reads it.
    const setpoint = differences.find((difference) => difference.member === 'writeSetpoint')
    t.regex(String(setpoint!.left), /value: number\(0\.\.2000\)/)
    t.regex(String(setpoint!.right), /value: number/)

    await a.close()
    await b.close()
    await bus.close()
})

test('two peers running the same thing differ in nothing', async (t) => {
    await withDevice(
        contract,
        async ({ hub, device }) => {
            const other = peer(`other${port - 1}`)
            const { differences } = await diffPeers({ hub, name: peer('differ-same'), callTimeout: 5000, left: device, right: other })
            t.deepEqual(differences, [])
        },
        contract
    )
})

test('a description becomes the schema the comparison reads', (t) => {
    const schema = schemaFromDescription({
        name: 'plantServer',
        validating: true,
        namespaces: [
            {
                name: 'plant',
                version: '3',
                created: false,
                emitter: true,
                methods: [{ name: 'writeSetpoint', params: [{ kind: 'number', max: 2000 }], paramNames: ['value'], returns: { kind: 'boolean' } }],
                events: [{ name: 'alarm', params: [{ kind: 'string' }], subscribers: 0 }]
            }
        ],
        types: { Reading: { kind: 'number' } }
    })
    // Lists on the wire because a console renders them in order; dictionaries here because dispatch
    // and the compatibility check look members up by name.
    t.is(schema.namespaces.plant.version, '3')
    t.deepEqual(schema.namespaces.plant.methods.writeSetpoint.params, [{ kind: 'number', max: 2000 }])
    t.deepEqual(schema.namespaces.plant.methods.writeSetpoint.paramNames, ['value'])
    t.deepEqual(schema.namespaces.plant.events?.alarm.params, [{ kind: 'string' }])
    t.deepEqual(schema.types?.Reading, { kind: 'number' })
})
