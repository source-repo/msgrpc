import test from 'ava'
import { randomUUID } from 'crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcClient, type RpcSchema } from '@source-repo/msgrpc'
import { startBroker } from './broker.js'
import { startFake } from './fake.js'
import { decodeValue, encodeValue, readRecording, replaySession, startRecording } from './record.js'

/**
 * A session written down and played back at something else - the question a plant asks constantly:
 * this new device is supposed to behave like the old one, does it?
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`
const scratch = () => join(tmpdir(), `msgrpc-recording-${randomUUID().slice(0, 8)}.jsonl`)

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
            version: '1',
            methods: {
                read: { params: [], returns: { kind: 'object', fields: { celsius: { type: { kind: 'number', min: 0, max: 100 } } } } },
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], paramNames: ['value'], returns: { kind: 'boolean' } },
                halt: { params: [] }
            },
            events: {}
        }
    }
}

let port = 8150

/** A bus, a device on it, and a caller - the shape every recording is made from. */
const withPlant = async (
    deviceScript: Parameters<typeof startFake>[0]['script'],
    body: (context: { hub: string; device: string; caller: RpcClient }) => Promise<void>
) => {
    const busPort = port++
    const hub = `http://localhost:${busPort}`
    const broker = await startBroker({ port: busPort, name: peer(`bus${busPort}`) })
    const device = peer(`plantServer${busPort}`)
    const fake = await startFake({ hub, name: device, callTimeout: 5000, schema, ...(deviceScript ? { script: deviceScript } : {}) })
    const caller = new RpcClient(hub, { name: peer(`hmi${busPort}`), callTimeout: 4000, readyTimeout: 5000 })
    await caller.ready()
    await waitFor(() => caller.peers.names().includes(device))
    try {
        await body({ hub, device, caller })
    } finally {
        await caller.close()
        await fake.close()
        await broker.close()
    }
}

test('a session is written down and plays back against a device that agrees', async (t) => {
    const file = scratch()
    await withPlant({ returns: { 'plant.read': { celsius: 84 } } }, async ({ hub, device, caller }) => {
        const recording = await startRecording({ hub, name: peer('recorder-a'), callTimeout: 5000, out: file, filter: { payloads: true } })
        t.deepEqual(recording.sources.length > 0, true, `nothing to watch: ${JSON.stringify(recording.sources)}`)

        const plant = (await caller.proxy<{ read(): Promise<unknown>; writeSetpoint(v: number): Promise<boolean> }>('plant', device)).remote!
        t.deepEqual(await plant.read(), { celsius: 84 })
        t.is(await plant.writeSetpoint(1200), true)
        await waitFor(() => recording.frames() >= 4)
        await recording.close()

        // A header first, so a file that is not a recording is refused rather than half-read.
        const { header, frames } = readRecording(file)
        t.is(header.msgrpc, 'recording')
        t.is(header.version, 1)
        t.true(frames.some((frame) => frame.kind === 'POST' && frame.method === 'read'))
        t.true(frames.some((frame) => frame.kind === 'SUCCESS'))
        // jsonl, so the ordinary tools work on it.
        t.true(readFileSync(file, 'utf8').trim().split('\n').length >= 5)

        const summary = await replaySession({ hub, name: peer('replayer-a'), callTimeout: 5000, file, speed: 0 })
        t.is(summary.differed, 0, `differed: ${JSON.stringify(summary.calls.filter((call) => call.outcome !== 'matched'))}`)
        t.is(summary.failed, 0)
        t.is(summary.matched, 2)
    })
    rmSync(file, { force: true })
})

test('a device that answers differently is what replay is for', async (t) => {
    const file = scratch()
    // Recorded against a plant that reads 84.
    await withPlant({ returns: { 'plant.read': { celsius: 84 } } }, async ({ hub, device, caller }) => {
        const recording = await startRecording({ hub, name: peer('recorder-b'), callTimeout: 5000, out: file, filter: { payloads: true } })
        const plant = (await caller.proxy<{ read(): Promise<unknown> }>('plant', device)).remote!
        await plant.read()
        await waitFor(() => recording.frames() >= 2)
        await recording.close()
    })

    // Replayed at a replacement that reads 12, and pointed at it by name.
    await withPlant({ returns: { 'plant.read': { celsius: 12 } } }, async ({ hub, device }) => {
        const summary = await replaySession({ hub, name: peer('replayer-b'), callTimeout: 5000, file, speed: 0, against: device })
        t.is(summary.differed, 1)
        t.is(summary.matched, 0)
        const differed = summary.calls.find((call) => call.outcome === 'differed')!
        t.deepEqual(differed.expected, { celsius: 84 })
        t.deepEqual(differed.got, { celsius: 12 })
    })
    rmSync(file, { force: true })
})

test('a call that failed the same way it failed when recorded is a match', async (t) => {
    const file = scratch()
    await withPlant({ fails: { 'plant.halt': 'Unauthorized' } }, async ({ hub, device, caller }) => {
        const recording = await startRecording({ hub, name: peer('recorder-c'), callTimeout: 5000, out: file, filter: { payloads: true } })
        const plant = (await caller.proxy<{ halt(): Promise<unknown> }>('plant', device)).remote!
        await t.throwsAsync(plant.halt())
        await waitFor(() => recording.frames() >= 2)
        await recording.close()
    })

    // The replacement refuses it the same way, which is the old device's behaviour and so a pass.
    await withPlant({ fails: { 'plant.halt': 'Unauthorized' } }, async ({ hub, device }) => {
        const summary = await replaySession({ hub, name: peer('replayer-c'), callTimeout: 5000, file, speed: 0, against: device })
        t.is(summary.matched, 1)
        t.is(summary.failed, 0)
    })

    // One that answers where the old one refused has changed behaviour, and is not a pass.
    await withPlant(undefined, async ({ hub, device }) => {
        const summary = await replaySession({ hub, name: peer('replayer-d'), callTimeout: 5000, file, speed: 0, against: device })
        t.is(summary.matched, 0)
        t.is(summary.differed + summary.failed, 1)
    })
    rmSync(file, { force: true })
})

test('a recording made without payloads says so rather than replaying empty calls', async (t) => {
    const file = scratch()
    await withPlant({ returns: { 'plant.read': { celsius: 84 } } }, async ({ hub, device, caller }) => {
        const recording = await startRecording({ hub, name: peer('recorder-e'), callTimeout: 5000, out: file, filter: { payloads: false } })
        const plant = (await caller.proxy<{ writeSetpoint(v: number): Promise<boolean> }>('plant', device)).remote!
        await plant.writeSetpoint(900)
        await waitFor(() => recording.frames() >= 2)
        await recording.close()

        const summary = await replaySession({ hub, name: peer('replayer-e'), callTimeout: 5000, file, speed: 0 })
        // Sending it with no arguments would call the method with nothing and compare that, which
        // is a worse answer than saying the recording cannot be replayed.
        t.is(summary.failed, 1)
        t.regex(String(summary.calls[0].error), /without payloads/)
    })
    rmSync(file, { force: true })
})

test('a file that is not a recording is refused with a sentence', (t) => {
    const file = scratch()
    rmSync(file, { force: true })
    t.throws(() => readRecording(file))
})

test('a Date and a byte string survive the round trip that JSON would flatten', (t) => {
    const when = new Date('2024-03-01T10:00:00.000Z')
    const bytes = Uint8Array.from([0x00, 0xff, 0x10])
    const encoded = JSON.parse(JSON.stringify(encodeValue({ when, bytes, nested: [{ when }] })))
    // Tagged on the way out, because a timestamp that replayed as a string is not what the device
    // received - the whole reason this library carries MsgPack rather than JSON.
    t.deepEqual(encoded.when, { $date: '2024-03-01T10:00:00.000Z' })
    t.deepEqual(encoded.bytes, { $bytes: '00ff10' })

    const back = decodeValue(encoded) as { when: Date; bytes: Uint8Array; nested: { when: Date }[] }
    t.true(back.when instanceof Date)
    t.is(back.when.getTime(), when.getTime())
    t.true(back.bytes instanceof Uint8Array)
    t.deepEqual([...back.bytes], [0x00, 0xff, 0x10])
    t.is(back.nested[0].when.getTime(), when.getTime())
})
