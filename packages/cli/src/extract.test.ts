import test from 'ava'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { NamespaceSchema, TypeNode } from '@source-repo/msgrpc'
import { namespaceProblems } from '@source-repo/msgrpc'
import { extractSchema } from './extract.js'

const here = dirname(fileURLToPath(import.meta.url))
// The fixtures are read from source, so they are resolved against src rather than dist.
const fixture = (name: string) => resolve(here, '../src/fixture', name)

test('a marked class becomes a namespace, and unmarked methods stay out of it', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(diagnostics, [], 'the fixture should describe cleanly')

    const plant = schema.namespaces.plant
    t.truthy(plant)
    t.is(plant.version, '2')
    t.deepEqual(Object.keys(plant.methods).sort(), ['blob', 'configure', 'tree', 'writeSetpoint'])
    t.false('internalOnly' in plant.methods, 'an unmarked method reached the contract')
})

test('parameters, optionals and rest arguments are described', (t) => {
    const { schema } = extractSchema(fixture('tsconfig.json'))
    const write = schema.namespaces.plant.methods.writeSetpoint

    t.deepEqual(write.params[0], { kind: 'number' })
    // An optional parameter admits null, which is what the validator reads to decide how few
    // arguments a caller may send.
    const mode = write.params[1] as { kind: 'union'; options: TypeNode[] }
    t.is(mode.kind, 'union')
    t.true(mode.options.some((option) => option.kind === 'literal' && option.value === null))
    t.true(mode.options.some((option) => option.kind === 'union' || (option.kind === 'literal' && option.value === 'auto')))

    const blob = schema.namespaces.plant.methods.blob
    t.deepEqual(blob.params[0], { kind: 'bytes' }, 'Uint8Array should be a value, not an encoding of one')
    t.deepEqual(blob.rest, { kind: 'string' })
})

test('interfaces become named types and a recursive one becomes a reference', (t) => {
    const { schema } = extractSchema(fixture('tsconfig.json'))

    t.deepEqual(schema.namespaces.plant.methods.configure.params[0], { kind: 'ref', name: 'Limits' })
    const limits = schema.types?.Limits as { kind: 'object'; fields: Record<string, { optional?: boolean }> }
    t.is(limits.kind, 'object')
    t.true(limits.fields.min.optional, 'an optional field should be marked optional')

    // Node refers to itself; without ref handling this would not terminate.
    t.deepEqual(schema.namespaces.plant.methods.tree.returns, { kind: 'ref', name: 'Node' })
    const node = schema.types?.Node as { kind: 'object'; fields: Record<string, { type: TypeNode }> }
    t.deepEqual(node.fields.child.type, { kind: 'ref', name: 'Node' })
})

test('Promise is unwrapped and Date survives as a value', (t) => {
    const { schema } = extractSchema(fixture('tsconfig.json'))
    const returns = schema.namespaces.plant.methods.blob.returns as { kind: 'object'; fields: Record<string, { type: TypeNode }> }
    t.is(returns.kind, 'object', 'Promise<T> should be unwrapped to T')
    t.deepEqual(returns.fields.at.type, { kind: 'date' })
})

test('events declared as a tuple map are described', (t) => {
    const { schema } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(schema.namespaces.plant.events?.alarm, { params: [{ kind: 'string' }, { kind: 'number' }] })
})

test('types that cannot be described are reported, never emitted as any', (t) => {
    const { diagnostics } = extractSchema(fixture('unsupported-tsconfig.json'))
    const reasons = diagnostics.map((diagnostic) => `${diagnostic.where} ${diagnostic.reason}`).join('\n')

    t.regex(reasons, /fetch return is generic/, 'a generic should be refused')
    t.regex(reasons, /subscribe argument 0 is a function/, 'a callback should be refused')
    t.regex(reasons, /lookup return is a Map/, 'a Map should be refused')
    t.true(
        diagnostics.every((diagnostic) => diagnostic.file && diagnostic.line),
        'each diagnostic should point at a place in the source'
    )
})

test('the extracted contract feeds the same comparison the server uses', (t) => {
    const { schema } = extractSchema(fixture('tsconfig.json'))
    const current = schema.namespaces.plant

    // Narrowing a parameter is what CI has to catch before it ships.
    const narrowed: NamespaceSchema = {
        ...current,
        methods: { ...current.methods, writeSetpoint: { ...current.methods.writeSetpoint, params: [{ kind: 'number', max: 10 }, current.methods.writeSetpoint.params[1]] } }
    }
    const problems = namespaceProblems(current, narrowed, schema.types)
    t.true(problems.length >= 1)
    t.regex(problems.map((problem) => `${problem.where} ${problem.reason}`).join(' '), /writeSetpoint argument 0 narrowed/)

    t.deepEqual(namespaceProblems(current, current, schema.types), [], 'a contract should be compatible with itself')
})
