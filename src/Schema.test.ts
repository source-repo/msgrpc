import test from 'ava'
import { RpcServer } from './RpcServer.js'
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
