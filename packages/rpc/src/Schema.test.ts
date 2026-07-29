import test from 'ava'
import { RpcServer } from './index.js'
import { RpcClient } from './RpcClient.js'
import { RpcError } from './RPC/RpcClientHandler.js'
import { rpc, exposeMethods, markedMethods } from './RPC/Expose.js'
import { RpcSchema, TypeNode, validateParams, validateValue } from './RPC/Schema.js'

const num: TypeNode = { kind: 'number' }
const str: TypeNode = { kind: 'string' }

// ------------------------------------------------------------------ exposure marks

class Plant {
    setpoint = 0
    @rpc
    async writeSetpoint(value: number) {
        this.setpoint = value
        return value
    }
    @rpc
    async readSetpoint() {
        return this.setpoint
    }
    /** Not marked, so not callable from outside however it is reached. */
    async wipeConfiguration() {
        return 'wiped'
    }
}

class Unmarked {
    async anything() {
        return 'ok'
    }
}

class Derived extends Plant {
    @rpc
    async extra() {
        return 'extra'
    }
}

test('marks are per class and inherited by subclasses', (t) => {
    t.deepEqual([...(markedMethods(new Plant()) ?? [])].sort(), ['readSetpoint', 'writeSetpoint'])
    t.deepEqual([...(markedMethods(new Derived()) ?? [])].sort(), ['extra', 'readSetpoint', 'writeSetpoint'])
    t.is(markedMethods(new Unmarked()), undefined, 'a class marking nothing should report nothing')
})

test('exposeMethods refuses a name that is not a method', (t) => {
    t.throws(() => exposeMethods(Unmarked, ['nope']), { message: /is not a method/ })
})

test('an unmarked method is not callable even though it is on the class', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3960 }] })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')
    const client = new RpcClient('http://localhost:3960')
    await client.ready()
    const proxy = await client.proxy<Plant & { wipeConfiguration: () => Promise<string> }>('plant')

    t.is(await proxy.remote!.writeSetpoint(12), 12)
    const error = await t.throwsAsync(async () => proxy.remote!.wipeConfiguration(), { instanceOf: RpcError })
    t.is(error?.code, 'MethodNotFound')

    await client.close()
    await server.close()
})

test('a class marking nothing still exposes everything, unless that is refused', async (t) => {
    const open = new RpcServer({ transports: [{ port: 3961 }] })
    await open.ready()
    open.exposeClassInstance(new Unmarked(), 'thing')
    const client = new RpcClient('http://localhost:3961')
    await client.ready()
    t.is(await (await client.proxy<Unmarked>('thing')).remote!.anything(), 'ok')
    await client.close()
    await open.close()

    const strict = new RpcServer({ transports: [{ port: 3962 }], requireExplicitExposure: true })
    await strict.ready()
    t.throws(() => strict.exposeClassInstance(new Unmarked(), 'thing'), { message: /marks no @rpc methods/ })
    await strict.close()
})

// ------------------------------------------------------------------ the validator

test('primitives, bounds and the MsgPack-native types', (t) => {
    t.is(validateValue(5, num), undefined)
    t.regex(validateValue('5', num) ?? '', /expected number, got string/)
    t.regex(validateValue(1.5, { kind: 'number', integer: true }) ?? '', /expected an integer/)
    t.regex(validateValue(11, { kind: 'number', max: 10 }) ?? '', /above the maximum/)
    t.regex(validateValue(NaN, num) ?? '', /expected number/)

    // Uint8Array and Date are values here, not encodings of them, because MsgPack carries both.
    t.is(validateValue(new Uint8Array([1]), { kind: 'bytes' }), undefined)
    t.regex(validateValue([1], { kind: 'bytes' }) ?? '', /expected bytes, got array/)
    t.regex(validateValue(new Uint8Array(9), { kind: 'bytes', maxBytes: 4 }) ?? '', /longer than 4 bytes/)
    t.is(validateValue(new Date(), { kind: 'date' }), undefined)
    t.regex(validateValue(new Date('nonsense'), { kind: 'date' }) ?? '', /expected a date/)
})

test('objects report the offending path rather than just a type', (t) => {
    const type: TypeNode = {
        kind: 'object',
        fields: { name: { type: str }, limits: { type: { kind: 'object', fields: { max: { type: num } } } }, note: { type: str, optional: true } }
    }
    t.is(validateValue({ name: 'a', limits: { max: 1 } }, type), undefined)
    t.is(validateValue({ name: 'a', limits: { max: 1 }, note: 'hi' }, type), undefined)
    t.is(validateValue({ name: 'a', limits: { max: 'x' } }, type), 'value.limits.max: expected number, got string')
    t.is(validateValue({ name: 'a' }, type), 'value.limits: missing')
    // An unexpected property usually means a caller built against a different contract.
    t.is(validateValue({ name: 'a', limits: { max: 1 }, extra: 1 }, type), 'value.extra: not part of this type')
})

test('unions, arrays and named references', (t) => {
    const types = { Node: { kind: 'object', fields: { child: { type: { kind: 'ref', name: 'Node' }, optional: true } } } as TypeNode }
    t.is(validateValue({ child: { child: {} } }, { kind: 'ref', name: 'Node' }, types), undefined)
    t.regex(validateValue({ child: 5 }, { kind: 'ref', name: 'Node' }, types) ?? '', /expected an object/)
    t.regex(validateValue(1, { kind: 'ref', name: 'Missing' }) ?? '', /unknown type 'Missing'/)

    const mode: TypeNode = { kind: 'union', options: [{ kind: 'literal', value: 'auto' }, { kind: 'literal', value: 'manual' }] }
    t.is(validateValue('auto', mode), undefined)
    t.regex(validateValue('other', mode) ?? '', /expected "auto" \| "manual"/)

    t.regex(validateValue([1, 2, 3], { kind: 'array', items: num, maxItems: 2 }) ?? '', /more than 2 items/)
    t.is(validateValue([1, 'x'], { kind: 'tuple', items: [num, str] }), undefined)
    t.regex(validateValue([1], { kind: 'tuple', items: [num, str] }) ?? '', /expected 2 elements/)
})

test('dictionaries are checked by value type, key and size', (t) => {
    const readings: TypeNode = { kind: 'record', values: num }
    t.is(validateValue({ a: 1, b: 2 }, readings), undefined)
    t.is(validateValue({}, readings), undefined, 'an empty dictionary is a valid one')
    t.is(validateValue({ a: 1, b: 'x' }, readings), 'value.b: expected number, got string')
    t.regex(validateValue([1, 2], readings) ?? '', /expected an object, got array/)
    t.regex(validateValue(new Date(), readings) ?? '', /expected an object, got date/)

    // Bounded like an array: a dictionary is the other shape a caller can grow without limit.
    t.regex(validateValue({ a: 1, b: 2 }, { kind: 'record', values: num, maxEntries: 1 }) ?? '', /more than 1 entries/)

    // What a numeric index signature becomes, since a JS object key is always a string.
    const byId: TypeNode = { kind: 'record', values: str, keyPattern: '^-?\\d+$' }
    t.is(validateValue({ 12: 'a' }, byId), undefined)
    t.regex(validateValue({ tag: 'a' }, byId) ?? '', /key does not match/)

    const nested: TypeNode = { kind: 'record', values: { kind: 'object', fields: { at: { type: { kind: 'date' } } } } }
    t.is(validateValue({ 'tank/level': { at: new Date() } }, nested), undefined)
    t.is(validateValue({ 'tank/level': { at: 1 } }, nested), 'value.tank/level.at: expected a date, got number')
})

test('a kind the validator does not know is refused rather than passed', (t) => {
    // Fail-open is the expensive direction: an unchecked value would otherwise wear a checked type.
    t.regex(validateValue(1, { kind: 'recrod' } as unknown as TypeNode) ?? '', /unknown type kind 'recrod'/)
})

test('deeply nested values are refused rather than exhausting the stack', (t) => {
    const types = { Node: { kind: 'object', fields: { child: { type: { kind: 'ref', name: 'Node' }, optional: true } } } as TypeNode }
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) deep = { child: deep }
    t.regex(validateValue(deep, { kind: 'ref', name: 'Node' }, types) ?? '', /nested deeper than/)
})

test('argument counts, optionals and rest parameters', (t) => {
    const optionalNum: TypeNode = { kind: 'union', options: [num, { kind: 'literal', value: null }] }
    t.is(validateParams([1], { params: [num] }), undefined)
    t.regex(validateParams([], { params: [num] }) ?? '', /expected at least 1 argument/)
    t.regex(validateParams([1, 2], { params: [num] }) ?? '', /expected at most 1 arguments/)
    t.is(validateParams([1], { params: [num, optionalNum] }), undefined)
    t.is(validateParams([1, 'a', 'b'], { params: [num], rest: str }), undefined)
    t.regex(validateParams([1, 'a', 2], { params: [num], rest: str }) ?? '', /argument 2: expected string/)
})

// ------------------------------------------------------------------ over a real link

const schema: RpcSchema = {
    schema: 1,
    version: '2',
    namespaces: {
        plant: {
            version: '3',
            methods: {
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], returns: num },
                readSetpoint: { params: [], returns: num }
            }
        }
    }
}

test('a call with the wrong argument type is refused before it reaches the method', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3963 }], schema })
    await server.ready()
    const plant = new Plant()
    server.exposeClassInstance(plant, 'plant')
    const client = new RpcClient('http://localhost:3963')
    await client.ready()
    const proxy = await client.proxy<Plant>('plant')

    t.is(await proxy.remote!.writeSetpoint(1200), 1200)

    const wrongType = await t.throwsAsync(async () => (proxy.remote as unknown as { writeSetpoint: (v: unknown) => Promise<number> }).writeSetpoint('banana'), {
        instanceOf: RpcError
    })
    t.is(wrongType?.code, 'InvalidParams')
    t.regex(wrongType?.message ?? '', /argument 0: expected number, got string/)
    // The namespace's contract version rides along, so a stale caller is recognisable as one.
    t.regex(wrongType?.message ?? '', /plant@3/)

    const outOfRange = await t.throwsAsync(async () => proxy.remote!.writeSetpoint(9999), { instanceOf: RpcError })
    t.regex(outOfRange?.message ?? '', /above the maximum 2000/)

    t.is(plant.setpoint, 1200, 'a refused call still reached the method')

    await client.close()
    await server.close()
})

test('an undescribed namespace passes unless validation is required', async (t) => {
    const lenient = new RpcServer({ transports: [{ port: 3964 }], schema })
    await lenient.ready()
    lenient.exposeClassInstance(new Unmarked(), 'thing')
    const client = new RpcClient('http://localhost:3964')
    await client.ready()
    t.is(await (await client.proxy<Unmarked>('thing')).remote!.anything(), 'ok')
    await client.close()
    await lenient.close()

    const strict = new RpcServer({ transports: [{ port: 3965 }], schema, validation: 'required' })
    await strict.ready()
    strict.exposeClassInstance(new Unmarked(), 'thing')
    const strictClient = new RpcClient('http://localhost:3965')
    await strictClient.ready()
    const error = await t.throwsAsync(async () => (await strictClient.proxy<Unmarked>('thing')).remote!.anything(), { instanceOf: RpcError })
    t.is(error?.code, 'InvalidParams')
    t.regex(error?.message ?? '', /not described by the schema/)
    await strictClient.close()
    await strict.close()
})

test('result validation catches a server breaking its own contract', async (t) => {
    class Liar {
        @rpc
        async readSetpoint() {
            return 'not a number' as unknown as number
        }
    }
    const server = new RpcServer({ transports: [{ port: 3966 }], schema, validateResults: true })
    await server.ready()
    server.exposeClassInstance(new Liar(), 'plant')
    const client = new RpcClient('http://localhost:3966')
    await client.ready()

    const error = await t.throwsAsync(async () => (await client.proxy<Liar>('plant')).remote!.readSetpoint(), { instanceOf: RpcError })
    t.is(error?.code, 'InvalidParams')
    t.regex(error?.message ?? '', /returned a value its own schema forbids/)

    await client.close()
    await server.close()
})

// ------------------------------------------------------------------ version compatibility

import { assignable, namespaceProblems } from './RPC/Compatibility.js'
import { NamespaceSchema } from './RPC/Schema.js'

test('assignability widens for inputs and narrows for outputs', (t) => {
    // A narrower type is assignable to a wider one, never the reverse.
    t.true(assignable({ kind: 'number', min: 0, max: 10 }, num))
    t.false(assignable(num, { kind: 'number', min: 0, max: 10 }))
    t.true(assignable({ kind: 'literal', value: 'auto' }, str))
    t.true(assignable(str, { kind: 'union', options: [str, num] }))
    t.false(assignable({ kind: 'union', options: [str, num] }, str))
    t.true(assignable({ kind: 'number', integer: true }, num))
    t.false(assignable(num, { kind: 'number', integer: true }))

    // 'any' absorbs anything but cannot be absorbed.
    t.true(assignable(num, { kind: 'any' }))
    t.false(assignable({ kind: 'any' }, num))

    // An object may gain optional fields, not required ones, and may not carry extras.
    const v1: TypeNode = { kind: 'object', fields: { a: { type: num } } }
    t.true(assignable(v1, { kind: 'object', fields: { a: { type: num }, b: { type: str, optional: true } } }))
    t.false(assignable(v1, { kind: 'object', fields: { a: { type: num }, b: { type: str } } }))
    t.false(assignable({ kind: 'object', fields: { a: { type: num }, extra: { type: num } } }, v1))
    t.true(assignable({ kind: 'object', fields: { a: { type: num }, extra: { type: num } } }, { kind: 'object', fields: { a: { type: num } }, additional: true }))
})

test('a dictionary follows its value type, and is not an object with no properties', (t) => {
    const numbers: TypeNode = { kind: 'record', values: num }
    t.true(assignable({ kind: 'record', values: { kind: 'number', min: 0, max: 10 } }, numbers))
    t.false(assignable(numbers, { kind: 'record', values: { kind: 'number', max: 10 } }))
    t.true(assignable({ kind: 'record', values: num, maxEntries: 4 }, { kind: 'record', values: num, maxEntries: 8 }))
    t.false(assignable(numbers, { kind: 'record', values: num, maxEntries: 8 }), 'unbounded is not assignable to bounded')
    t.false(assignable(numbers, { kind: 'record', values: num, keyPattern: '^\\d+$' }))

    // Any key at all against no key at all: the two are not interchangeable in either direction.
    t.false(assignable(numbers, { kind: 'object', fields: {} }))
    t.false(assignable({ kind: 'object', fields: {} }, numbers))
})

const v1: NamespaceSchema = {
    version: '1',
    methods: { writeSetpoint: { params: [num], returns: num }, readSetpoint: { params: [], returns: num } }
}

test('a widened parameter stays compatible, a narrowed one does not', (t) => {
    const widened: NamespaceSchema = { version: '2', methods: { ...v1.methods, writeSetpoint: { params: [{ kind: 'union', options: [num, str] }], returns: num } } }
    t.deepEqual(namespaceProblems(v1, widened), [], 'widening a parameter should stay compatible')

    const narrowed: NamespaceSchema = { version: '2', methods: { ...v1.methods, writeSetpoint: { params: [{ kind: 'number', max: 100 }], returns: num } } }
    const problems = namespaceProblems(v1, narrowed)
    t.is(problems.length, 1)
    t.is(problems[0].where, 'writeSetpoint argument 0')
    t.regex(problems[0].reason, /narrowed/)
})

test('a narrowed return stays compatible, a widened one does not', (t) => {
    const narrowedReturn: NamespaceSchema = { version: '2', methods: { ...v1.methods, readSetpoint: { params: [], returns: { kind: 'number', min: 0 } } } }
    t.deepEqual(namespaceProblems(v1, narrowedReturn), [], 'narrowing a return should stay compatible')

    const widenedReturn: NamespaceSchema = { version: '2', methods: { ...v1.methods, readSetpoint: { params: [], returns: { kind: 'union', options: [num, str] } } } }
    t.regex(namespaceProblems(v1, widenedReturn)[0]?.reason ?? '', /widened/)
})

test('removed methods, added required arguments and dropped events are reported', (t) => {
    t.regex(namespaceProblems(v1, { version: '2', methods: { readSetpoint: v1.methods.readSetpoint } })[0]?.reason ?? '', /no longer exists/)

    const extraRequired: NamespaceSchema = { version: '2', methods: { ...v1.methods, writeSetpoint: { params: [num, str], returns: num } } }
    t.regex(namespaceProblems(v1, extraRequired).map((p) => p.reason).join(' '), /requires 2 arguments/)

    const withEvent: NamespaceSchema = { ...v1, events: { alarm: { params: [str] } } }
    t.regex(namespaceProblems(withEvent, v1)[0]?.reason ?? '', /no longer emitted/)
})

test('a method that becomes more dangerous to repeat is a breaking change', (t) => {
    // The one incompatibility no type comparison can see: every argument and return still lines up,
    // and code written against the old promise now retries something that must not be retried.
    const asQuery: NamespaceSchema = { version: '1', methods: { start: { params: [], semantics: 'query' } } }
    const asCommand: NamespaceSchema = { version: '2', methods: { start: { params: [], semantics: 'non-repeatable-command' } } }

    t.regex(namespaceProblems(asQuery, asCommand)[0]?.reason ?? '', /no longer safe/)
    // The other direction is a promise being strengthened, which strands nobody: a caller that was
    // careful with a command loses nothing by the command becoming a query.
    t.deepEqual(namespaceProblems(asCommand, asQuery), [])
    // Dropping the declaration altogether takes the promise away, which is also breaking.
    t.regex(namespaceProblems(asQuery, { version: '2', methods: { start: { params: [] } } })[0]?.reason ?? '', /nothing to rely on/)
    // Undeclared to declared adds one, and breaks nobody.
    t.deepEqual(namespaceProblems({ version: '1', methods: { start: { params: [] } } }, asCommand), [])
})

test('a caller declaring an incompatible version is refused with the reason', async (t) => {
    // v2 narrows writeSetpoint, so a v1 caller can no longer be served safely.
    const served: RpcSchema = {
        schema: 1,
        namespaces: {
            plant: {
                version: '2',
                methods: { writeSetpoint: { params: [{ kind: 'number', min: 0, max: 100 }], returns: num }, readSetpoint: { params: [], returns: num } },
                history: { '1': { methods: v1.methods } }
            }
        }
    }
    const callerContract: RpcSchema = { schema: 1, namespaces: { plant: { version: '1', methods: v1.methods } } }

    const server = new RpcServer({ transports: [{ port: 3967 }], schema: served })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const stale = new RpcClient('http://localhost:3967', { schema: callerContract })
    await stale.ready()
    const error = await t.throwsAsync(async () => (await stale.proxy<Plant>('plant')).remote!.writeSetpoint(50), { instanceOf: RpcError })
    t.is(error?.code, 'IncompatibleVersion')
    t.regex(error?.message ?? '', /plant@1 is not compatible with plant@2/)
    t.regex(error?.message ?? '', /writeSetpoint argument 0 narrowed/)

    // A caller declaring nothing is unaffected: only its arguments are checked.
    const current = new RpcClient('http://localhost:3967')
    await current.ready()
    t.is(await (await current.proxy<Plant>('plant')).remote!.writeSetpoint(50), 50)

    await stale.close()
    await current.close()
    await server.close()
})

test('an older caller whose contract still holds keeps working', async (t) => {
    // v2 only widens, so a v1 caller is still safe and must not be refused.
    const served: RpcSchema = {
        schema: 1,
        namespaces: {
            plant: {
                version: '2',
                methods: { writeSetpoint: { params: [{ kind: 'union', options: [num, str] }], returns: num }, readSetpoint: { params: [], returns: num } },
                history: { '1': { methods: v1.methods } }
            }
        }
    }
    const server = new RpcServer({ transports: [{ port: 3968 }], schema: served })
    await server.ready()
    server.exposeClassInstance(new Plant(), 'plant')

    const older = new RpcClient('http://localhost:3968', { schema: { schema: 1, namespaces: { plant: { version: '1', methods: v1.methods } } } })
    await older.ready()

    t.is(await (await older.proxy<Plant>('plant')).remote!.writeSetpoint(50), 50, 'a caller whose contract still holds was refused')

    await older.close()
    await server.close()
})

// ------------------------------------------------------------------ introspection

import type { ServerDescription } from './RPC/Introspection.js'
import { rpcNamespace } from './RPC/Expose.js'
import { EventEmitter } from 'events'

@rpcNamespace('boiler', { version: '4' })
class Boiler extends EventEmitter {
    @rpc
    async setTemperature(celsius: number) {
        return celsius
    }
    @rpc
    async status() {
        return 'ok'
    }
    private secret() {
        return 'hidden'
    }
}

test('introspection is off unless asked for', async (t) => {
    const server = new RpcServer({ transports: [{ port: 3970 }] })
    await server.ready()
    server.exposeClassInstance(new Boiler())
    const client = new RpcClient('http://localhost:3970')
    await client.ready()

    const error = await t.throwsAsync(async () => (await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')).remote!.describe(), {
        instanceOf: RpcError
    })
    t.is(error?.code, 'ClassNotFound')

    await client.close()
    await server.close()
})

test('describe reports namespaces, methods, events and live instances', async (t) => {
    const boilerSchema: RpcSchema = {
        schema: 1,
        version: '7',
        namespaces: {
            boiler: {
                version: '4',
                methods: { setTemperature: { params: [{ kind: 'number', max: 120 }], returns: num }, status: { params: [], returns: str } },
                events: { overheat: { params: [num] } }
            }
        }
    }
    const server = new RpcServer({ transports: [{ port: 3971 }], schema: boilerSchema, exposeIntrospection: true })
    await server.ready()
    const boiler = new Boiler()
    // Exposed without a name: the class declares its namespace.
    server.exposeClassInstance(boiler)
    const client = new RpcClient('http://localhost:3971')
    await client.ready()

    // A live subscription should show up in the description.
    const proxy = await client.proxy<Boiler>('boiler')
    await proxy.remote!.on('overheat', () => {})

    const described = await (await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')).remote!.describe()

    t.is(described.version, '7')
    t.true(described.validating)
    const boilerNs = described.namespaces.find((namespace) => namespace.name === 'boiler')
    t.truthy(boilerNs)
    t.is(boilerNs!.version, '4')
    t.is(boilerNs!.className, 'Boiler')
    t.false(boilerNs!.created)
    t.true(boilerNs!.emitter)
    // Only marked methods, and the schema supplies their types.
    t.deepEqual(boilerNs!.methods.map((method) => method.name).sort(), ['setTemperature', 'status'])
    t.deepEqual(boilerNs!.methods.find((method) => method.name === 'setTemperature')!.params, [{ kind: 'number', max: 120 }])
    t.deepEqual(boilerNs!.events, [{ name: 'overheat', params: [{ kind: 'number' }], subscribers: 1 }])

    await client.close()
    await server.close()
})

test('describe describes itself, and required validation does not refuse it', async (t) => {
    // Before this, the one call a peer makes to find out what a server offers was the only
    // undescribed thing on it, and 'required' refused it outright.
    const server = new RpcServer({
        transports: [{ port: 3979 }],
        schema: { schema: 1, namespaces: { boiler: { methods: { status: { params: [], returns: str } } } } },
        validation: 'required',
        exposeIntrospection: true
    })
    await server.ready()
    server.exposeClassInstance(new Boiler())
    const client = new RpcClient('http://localhost:3979')
    await client.ready()

    const described = await (await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')).remote!.describe()
    const introspection = described.namespaces.find((namespace) => namespace.name === 'msgrpc')
    t.deepEqual(
        introspection!.methods.find((method) => method.name === 'describe')!.returns,
        { kind: 'ref', name: 'msgrpc.ServerDescription' },
        'describe should report the type it actually returns'
    )

    // The prefix keeps a library out of the user's type names: one flat map serves every namespace,
    // so an unprefixed ServerDescription here would collide with a plant that defines its own.
    t.truthy(described.types?.['msgrpc.ServerDescription'])
    t.deepEqual((described.types!['msgrpc.ServerDescription'] as { kind: 'object'; fields: { [name: string]: { type: TypeNode } } }).fields.types.type, {
        kind: 'record',
        values: { kind: 'ref', name: 'msgrpc.TypeNode' }
    })

    await client.close()
    await server.close()
})

test('a schema of its own for the msgrpc namespace is left alone', async (t) => {
    // It is the contract that server actually serves; overwriting it would describe the server as
    // something it is not.
    const mine: RpcSchema = { schema: 1, namespaces: { msgrpc: { methods: { describe: { params: [], returns: { kind: 'any' } } } } } }
    const server = new RpcServer({ transports: [{ port: 3980 }], schema: mine, exposeIntrospection: true })
    await server.ready()
    const client = new RpcClient('http://localhost:3980')
    await client.ready()

    const described = await (await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')).remote!.describe()
    const introspection = described.namespaces.find((namespace) => namespace.name === 'msgrpc')
    t.deepEqual(introspection!.methods.find((method) => method.name === 'describe')!.returns, { kind: 'any' })
    t.falsy(described.types?.['msgrpc.ServerDescription'], 'nothing should have been merged in')

    await client.close()
    await server.close()
})

test('describe is subject to authorize like any other call', async (t) => {
    const server = new RpcServer({
        transports: [{ port: 3972 }],
        exposeIntrospection: true,
        authorize: ({ instanceName }) => instanceName !== 'msgrpc'
    })
    await server.ready()
    server.exposeClassInstance(new Boiler())
    const client = new RpcClient('http://localhost:3972')
    await client.ready()

    const error = await t.throwsAsync(async () => (await client.proxy<{ describe: () => Promise<ServerDescription> }>('msgrpc')).remote!.describe(), {
        instanceOf: RpcError
    })
    t.is(error?.code, 'Forbidden')

    await client.close()
    await server.close()
})
