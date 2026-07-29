import test from 'ava'
import { randomUUID } from 'crypto'
import { execFileSync } from 'node:child_process'
import { RpcClient, RpcServer, type RpcSchema } from '@source-repo/rpc'
import { startFake } from './fake.js'
import { findPython, javascriptRuntime, pythonCandidates, pythonRuntime } from './handlers.js'

/**
 * A fake that reacts, rather than repeating a canned answer.
 *
 * The behaviour worth testing is not that a handler runs - it is that the gate holds, that state
 * survives between calls, and that a handler which misbehaves fails the call instead of the process.
 */

const run = randomUUID().slice(0, 8)
const peer = (name: string) => `${name}-${run}`

const havePython = (() => {
    try {
        execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
})()

/** A pump whose reading depends on the setpoint it was last given. */
const PLANT: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '1',
            methods: {
                read: { params: [], returns: { kind: 'number' } },
                setSetpoint: { params: [{ kind: 'number' }], paramNames: ['bar'], returns: { kind: 'null' } }
            }
        }
    }
}

const fakeOn = async (port: number, script: object, allowExec = true) => {
    const hub = new RpcServer({ name: peer(`hub${port}`), transports: [{ port }] })
    await hub.ready()
    const name = peer(`pump${port}`)
    const fake = await startFake({
        hub: `http://localhost:${port}`,
        name,
        callTimeout: 6000,
        schema: PLANT,
        script: script as never,
        ...(allowExec ? { allowExec: true } : {})
    })
    const client = new RpcClient(`http://localhost:${port}`, { name: peer(`caller${port}`), callTimeout: 6000 })
    await client.ready()
    const plant = await client.proxy<{ read(): Promise<number>; setSetpoint(bar: number): Promise<null> }>('plant', name)
    return {
        plant: plant.remote!,
        close: async () => {
            await client.close()
            await fake.close()
            await hub.close()
        }
    }
}

test('a script asking for handlers without --allow-exec is refused, not quietly ignored', async (t) => {
    // Ignoring them would serve generated values that look plausible and answer nothing the
    // simulation was written to answer, which is the failure that wastes an afternoon.
    await t.throwsAsync(
        startFake({
            hub: 'http://localhost:1',
            name: peer('never'),
            callTimeout: 500,
            schema: PLANT,
            script: { handlers: { 'plant.read': '() => 1' } }
        }),
        { message: /uses handlers, which run code it supplied.*--allow-exec/s }
    )
})

test('python is named in the refusal too, so the message says what was asked for', async (t) => {
    await t.throwsAsync(
        startFake({
            hub: 'http://localhost:1',
            name: peer('never2'),
            callTimeout: 500,
            schema: PLANT,
            script: { python: { program: 'pass', targets: ['plant.read'] } }
        }),
        { message: /uses python/ }
    )
})

test('a javascript handler holds state between calls and sees its arguments', async (t) => {
    const { plant, close } = await fakeOn(7431, {
        state: { bar: 0 },
        handlers: {
            'plant.setSetpoint': '(bar) => { state.bar = bar; return null }',
            'plant.read': '() => state.bar'
        }
    })

    t.is(await plant.read(), 0)
    await plant.setSetpoint(4)
    // The reading moved because the write moved it: this is the whole point of handlers over returns.
    t.is(await plant.read(), 4)
    await plant.setSetpoint(9)
    t.is(await plant.read(), 9)

    await close()
})

test('a handler that throws fails its call and leaves the fake serving', async (t) => {
    const { plant, close } = await fakeOn(7432, {
        handlers: { 'plant.setSetpoint': '() => { throw new Error("valve stuck") }', 'plant.read': '() => 7' }
    })

    await t.throwsAsync(plant.setSetpoint(1), { message: /valve stuck/ })
    // Still answering afterwards, which is what separates a failed call from a dead peer.
    t.is(await plant.read(), 7)

    await close()
})

test('a handler that will not finish is cut off rather than wedging the process', async (t) => {
    const { plant, close } = await fakeOn(7433, {
        handlers: { 'plant.read': '() => { while (true) {} }' }
    })

    await t.throwsAsync(plant.read())

    await close()
})

test('the javascript context has no way to reach the machine it runs on', (t) => {
    const runtime = javascriptRuntime({ 'plant.read': '() => typeof require + " " + typeof process' }, {})
    // Not a security boundary - node:vm is documented as not being one - but a handler written
    // without thinking should not find the filesystem sitting in scope.
    return runtime.call('plant.read', []).then((answer) => t.is(answer, 'undefined undefined'))
})

test('a handler that does not compile is a startup failure, not a call that fails later', async (t) => {
    await t.throwsAsync(
        startFake({
            hub: 'http://localhost:1',
            name: peer('bad'),
            callTimeout: 500,
            schema: PLANT,
            allowExec: true,
            script: { handlers: { 'plant.read': '() => {' } }
        }),
        { message: /did not compile/ }
    )
})

test('the interpreter to try is chosen per platform, since python3 is not the Windows name', (t) => {
    // A Windows Embedded PLC has `py` from the python.org installer and `python`, and generally no
    // `python3` at all. Trying one name and hoping is how a fake refuses to start on the platform
    // the device is actually on.
    t.deepEqual(pythonCandidates('linux'), ['python3', 'python'])
    t.deepEqual(pythonCandidates('darwin'), ['python3', 'python'])
    t.is(pythonCandidates('win32')[0], 'py')
    t.true(pythonCandidates('win32').includes('python'))

    // Probed rather than assumed: Windows also ships a `python` that is a Store stub rather than an
    // interpreter, and it fails this the same way a missing one does.
    t.is(findPython(['definitely-not-an-interpreter']), undefined)
    if (havePython) t.truthy(findPython())
})

test('a python program answers, and keeps its own state', async (t) => {
    if (!havePython) {
        t.pass('no python3 on PATH - skipped')
        return
    }
    const { plant, close } = await fakeOn(7434, {
        python: {
            program: [
                'bar = {"value": 0}',
                "@rpc('plant.setSetpoint')",
                'def set_setpoint(v):',
                '    bar["value"] = v',
                '    return None',
                "@rpc('plant.read')",
                'def read():',
                '    return bar["value"]'
            ].join('\n'),
            targets: ['plant.read', 'plant.setSetpoint']
        }
    })

    t.is(await plant.read(), 0)
    await plant.setSetpoint(12)
    t.is(await plant.read(), 12)

    await close()
})

test('a python program that stops reading fails the call rather than the process', async (t) => {
    if (!havePython) {
        t.pass('no python3 - skipped')
        return
    }
    // A write to a child whose read end has gone raises EPIPE on the stream, and an unhandled
    // 'error' on a stream is an uncaught exception. This program stays alive with stdin closed,
    // which is the deterministic form of what an interpreter that died leaves behind - and before
    // the listener existed it took the whole fake down instead of failing one call.
    const runtime = await pythonRuntime('import os, time\nos.close(0)\ntime.sleep(30)\n', ['a.b'])
    await new Promise((resolve) => setTimeout(resolve, 400))

    const failure = await t.throwsAsync(runtime.call('a.b', []))
    t.regex(String(failure?.message), /no longer reading/)

    await runtime.close()
    // Reaching here at all is the assertion: an uncaught exception would have ended the worker.
    t.pass()
})

test('a python handler that raises is reported with what python said', async (t) => {
    if (!havePython) {
        t.pass('no python3 on PATH - skipped')
        return
    }
    const { plant, close } = await fakeOn(7435, {
        python: {
            program: ["@rpc('plant.read')", 'def read():', '    raise ValueError("sensor unplugged")'].join('\n'),
            targets: ['plant.read']
        }
    })

    await t.throwsAsync(plant.read(), { message: /sensor unplugged/ })

    await close()
})
