import test from 'ava'
import { randomUUID } from 'crypto'
import { RpcClient, RpcServer, type RpcSchema } from '@source-repo/rpc'
import { sampleFor, startFake } from './fake.js'

/** Nothing here touches MQTT: a socket.io hub is enough to stand a peer up and call it. */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const waitFor = async (condition: () => boolean, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '3',
            methods: {
                writeSetpoint: {
                    params: [
                        { kind: 'number', min: 0, max: 2000 },
                        { kind: 'union', options: [{ kind: 'literal', value: 'auto' }, { kind: 'literal', value: 'manual' }, { kind: 'literal', value: null }] }
                    ],
                    paramNames: ['value', 'mode'],
                    returns: { kind: 'boolean' }
                },
                read: {
                    params: [],
                    returns: { kind: 'object', fields: { celsius: { type: { kind: 'number', min: 0, max: 100 } }, tag: { type: { kind: 'string' } }, note: { type: { kind: 'string' }, optional: true } } }
                },
                halt: { params: [] }
            },
            events: { alarm: { params: [{ kind: 'string' }, { kind: 'number', min: 1, max: 3 }] } }
        }
    }
}

let port = 8130
const withFake = async (script: Parameters<typeof startFake>[0]['script'], body: (caller: RpcClient, device: string) => Promise<void>) => {
    const hubPort = port++
    const hub = new RpcServer({ name: peer(`hub${hubPort}`), transports: [{ port: hubPort }] })
    await hub.ready()
    const device = peer(`fakePlant${hubPort}`)
    const fake = await startFake({
        hub: `http://localhost:${hubPort}`,
        name: device,
        callTimeout: 5000,
        schema,
        ...(script ? { script } : {})
    })
    const caller = new RpcClient(`http://localhost:${hubPort}`, { name: peer(`hmi${hubPort}`), callTimeout: 3000, readyTimeout: 5000 })
    await caller.ready()
    await waitFor(() => caller.peers.names().includes(device))
    try {
        await body(caller, device)
    } finally {
        await caller.close()
        await fake.close()
        await hub.close()
    }
}

test('a peer stood up from a contract answers in the declared shape', async (t) => {
    await withFake(undefined, async (caller, device) => {
        const plant = (await caller.proxy<{ writeSetpoint(v: number, m?: string): Promise<boolean>; read(): Promise<{ celsius: number; tag: string; note?: string }> }>('plant', device))

        t.is(await plant.writeSetpoint(1200, 'auto'), true)

        const reading = await plant.read()
        // In the declared range, not merely of the declared type: a fake that answers outside its
        // own contract would be refused by the validator it exists to exercise.
        t.is(reading.celsius, 50)
        t.is(reading.tag, 'sample')
        // Optional fields are left out, the way the console's argument forms leave them out.
        t.false('note' in reading)
    })
})

test('it refuses what the real peer would refuse', async (t) => {
    await withFake(undefined, async (caller, device) => {
        const plant = (await caller.proxy<{ writeSetpoint(v: number): Promise<boolean> }>('plant', device))
        // The contract says 0..2000, and the fake is given the same schema the device would have.
        const refused = await t.throwsAsync(plant.writeSetpoint(3000))
        t.is((refused as unknown as { code?: string }).code, 'InvalidParams')
        t.regex(String(refused?.message), /2000/)
    })
})

test('a scripted return replaces the generated one, and a scripted failure is a real failure', async (t) => {
    await withFake({ returns: { 'plant.read': { celsius: 84, tag: 'boiler-3' } }, fails: { 'plant.halt': 'Unauthorized' } }, async (caller, device) => {
        const plant = (await caller.proxy<{ read(): Promise<unknown>; halt(): Promise<unknown> }>('plant', device))
        t.deepEqual(await plant.read(), { celsius: 84, tag: 'boiler-3' })

        const refused = await t.throwsAsync(plant.halt())
        t.is((refused as unknown as { code?: string }).code, 'Unauthorized')
    })
})

test('a method set to Timeout never answers, which is the failure a real device will not stage', async (t) => {
    await withFake({ fails: { 'plant.read': 'Timeout' } }, async (caller, device) => {
        const plant = (await caller.proxy<{ read(): Promise<unknown>; writeSetpoint(v: number): Promise<boolean> }>('plant', device))
        const started = Date.now()
        const failure = await t.throwsAsync(plant.read())
        t.regex(String(failure?.message), /[Tt]imeout/)
        // The caller's own timeout is what fires, rather than an error arriving promptly - which is
        // the whole difference between this and `fails: { 'plant.read': 'Timeout' }` being an answer.
        t.true(Date.now() - started >= 2500, `gave up after ${Date.now() - started} ms`)

        // The rest of the peer still works, so a test can stage one bad method and not a dead device.
        t.is(await plant.writeSetpoint(10), true)
    })
})

test('declared events are emitted on a timer, with parameters of the declared shape', async (t) => {
    await withFake({ emits: [{ event: 'plant.alarm', every: 60 }] }, async (caller, device) => {
        const heard: unknown[][] = []
        const plant = (await caller.proxy<{ on(e: string, h: (...a: unknown[]) => void): Promise<unknown> }>('plant', device))
        await plant.on('alarm', (...args: unknown[]) => void heard.push(args))
        await waitFor(() => heard.length >= 2)
        t.deepEqual(heard[0], ['sample', 2])
    })
})

test('the fake describes itself, so a console can drive it like any peer', async (t) => {
    await withFake(undefined, async (caller, device) => {
        const introspection = await caller.proxy<{ describe(): Promise<{ namespaces: { name: string; methods: { name: string; paramNames?: string[] }[] }[] }> }>('msgrpc', device)
        const description = await introspection.describe()
        const plant = description.namespaces.find((namespace) => namespace.name === 'plant')
        t.truthy(plant, `namespaces: ${JSON.stringify(description.namespaces.map((n) => n.name))}`)
        t.deepEqual(plant!.methods.find((method) => method.name === 'writeSetpoint')?.paramNames, ['value', 'mode'])
    })
})

test('a generated value honours what the type language carries', (t) => {
    t.is(sampleFor({ kind: 'number', min: 10, max: 20 }, undefined), 15)
    t.is(sampleFor({ kind: 'number', min: 10, max: 21, integer: true }, undefined), 16)
    t.is(sampleFor({ kind: 'string', minLength: 8 }, undefined), 'samplexx')
    t.is(sampleFor({ kind: 'string', maxLength: 3 }, undefined), 'sam')
    t.deepEqual(sampleFor({ kind: 'bytes', maxBytes: 2 }, undefined), Uint8Array.from([0, 1]))
    t.deepEqual(sampleFor({ kind: 'array', items: { kind: 'boolean' } }, undefined), [true])
    t.deepEqual(sampleFor({ kind: 'array', items: { kind: 'boolean' }, maxItems: 0 }, undefined), [])
    // The null half of an optional is not the answer a caller wants back.
    t.is(sampleFor({ kind: 'union', options: [{ kind: 'literal', value: null }, { kind: 'literal', value: 'auto' }] }, undefined), 'auto')
    t.deepEqual(sampleFor({ kind: 'record', values: { kind: 'boolean' } }, undefined), { sample: true })
    // A key pattern cannot be satisfied in general, and an empty dictionary is a valid one.
    t.deepEqual(sampleFor({ kind: 'record', values: { kind: 'boolean' }, keyPattern: '^\\d+$' }, undefined), {})

    // A type that contains itself has no finite sample, so the cycle is broken rather than followed.
    const types = { Node: { kind: 'object' as const, fields: { name: { type: { kind: 'string' as const } }, child: { type: { kind: 'ref' as const, name: 'Node' } } } } }
    t.deepEqual(sampleFor({ kind: 'ref', name: 'Node' }, types), { name: 'sample', child: null })
})
