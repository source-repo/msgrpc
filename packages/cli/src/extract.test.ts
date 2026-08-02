import test from 'ava'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { NamespaceSchema, TypeNode } from '@source-repo/rpc'
import { namespaceProblems } from '@source-repo/rpc'
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
    t.deepEqual(Object.keys(plant.methods).sort(), [
        'advanceBatch',
        'blob',
        'byId',
        'configure',
        'counts',
        'labels',
        'loadRecipe',
        'readSetpoint',
        'readings',
        'setMode',
        'tree',
        'writeSetpoint'
    ])
    t.false('internalOnly' in plant.methods, 'an unmarked method reached the contract')
})

test('what a method does to the world is read off the decorator and into the contract', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(diagnostics, [], 'the fixture should describe cleanly')
    const plant = schema.namespaces.plant

    t.is(plant.methods.readSetpoint.semantics, 'query')
    t.is(plant.methods.setMode.semantics, 'idempotent-command')
    t.is(plant.methods.advanceBatch.semantics, 'non-repeatable-command')
    // Undeclared stays undeclared. Guessing that an unmarked method is safe to repeat is the one
    // mistake this feature exists to stop anybody making.
    t.is(plant.methods.writeSetpoint.semantics, undefined)
})

test('effect is read off the decorator, independently of semantics', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(diagnostics, [], 'the fixture should describe cleanly')
    const plant = schema.namespaces.plant

    // The point of the classification: identical semantics, different power.
    t.is(plant.methods.setMode.semantics, 'idempotent-command')
    t.is(plant.methods.loadRecipe.semantics, 'idempotent-command')
    t.is(plant.methods.loadRecipe.effect, 'program')

    // Undeclared stays undeclared in the contract. The server applies the conservative default;
    // recording a guess here would put an invention in a file that gets committed and compared.
    t.is(plant.methods.setMode.effect, undefined)
    t.is(plant.methods.readSetpoint.effect, undefined)
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

test('index signatures become dictionaries rather than being refused', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(diagnostics, [])

    // The value type is described, so a wrong reading is still caught; only the keys are open.
    t.deepEqual(schema.namespaces.plant.methods.readings.returns, { kind: 'record', values: { kind: 'ref', name: 'Reading' } })
    t.deepEqual(schema.types?.Reading, { kind: 'object', fields: { value: { type: { kind: 'number' } }, at: { type: { kind: 'date' } } } })

    // A numeric index is a string key that has to read as a number.
    t.deepEqual(schema.namespaces.plant.methods.byId.returns, { kind: 'record', values: { kind: 'string' }, keyPattern: '^-?\\d+$' })
})

test('two instantiations of one generic alias stay distinct', (t) => {
    // Both are Record, so keying them by alias name would make the second a reference to the
    // first - a contract that says string where the method returns number, and looks checked.
    const { schema } = extractSchema(fixture('tsconfig.json'))
    t.deepEqual(schema.namespaces.plant.methods.counts.returns, { kind: 'record', values: { kind: 'number' } })
    t.deepEqual(schema.namespaces.plant.methods.labels.returns, { kind: 'record', values: { kind: 'string' } })
    t.false('Record' in (schema.types ?? {}), 'a generic instantiation is not a name to share')
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
    t.regex(reasons, /mixed return has both declared properties and an index signature/, 'a part-dictionary should be refused')
    // A namespace named by a constant used to be skipped, which produced a contract with nothing in
    // it and no complaint - "wrote 0 namespaces" being the only sign, in a line that reads like
    // success. Refused now, the same as a type that cannot be described.
    t.regex(reasons, /Computed declares @rpcNamespace\(NAMESPACE\).*has to be a literal/, 'a computed namespace name should be refused')
    t.true(
        diagnostics.every((diagnostic) => diagnostic.file && diagnostic.line),
        'each diagnostic should point at a place in the source'
    )
})

test('the contracts this package ships still match the source they came from', (t) => {
    // Both are loaded at runtime - the console loads its own, the page ships its chat one - so a
    // service changed without re-extracting would ship a contract describing the old shape, and
    // validation would refuse calls the method now accepts. `npm run contract` regenerates them.
    for (const [project, stored] of [
        ['../tsconfig.contract.json', '../src/console.types.json'],
        ['../tsconfig.bus.json', '../src/bus.types.json'],
        ['../web/tsconfig.contract.json', '../web/src/chat.types.json'],
        // msgrpc's own, which it loads to describe describe(). It lives there and is generated
        // here, because the extractor that writes it is this package.
        ['../../rpc/tsconfig.contract.json', '../../rpc/src/RPC/Introspection.types.json']
    ]) {
        const { schema, diagnostics } = extractSchema(resolve(here, project))
        t.deepEqual(diagnostics, [], `${project} should describe cleanly`)
        t.deepEqual(schema, JSON.parse(readFileSync(resolve(here, stored), 'utf8')), `${stored} is stale — run npm run contract`)
    }
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

test('a component describes its props and state, resolved through the base chain', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('component-tsconfig.json'))

    const oven = schema.namespaces.oven
    t.truthy(oven.component, 'a class extending RpcComponent should carry a component contract')
    t.is(oven.component!.snapshot, 1)
    // Named aliases become refs, so the console and the checker share one definition.
    t.deepEqual(oven.component!.props, { kind: 'ref', name: 'OvenProps' })
    t.deepEqual(oven.component!.state, { kind: 'ref', name: 'OvenState' })
    t.truthy(schema.types?.OvenProps)
    t.truthy(schema.types?.OvenState)

    // A subclass one level down describes identically: the chain is walked, not the first extends.
    t.deepEqual(schema.namespaces.grill.component, oven.component)

    // The generic case is refused loudly, and its namespace carries no component at all - a
    // snapshot schema of `any` would sit in the contract looking exactly like a real one.
    t.true(
        diagnostics.some((diagnostic) => /unresolved generic/.test(diagnostic.reason)),
        `expected the unresolved-generic diagnostic, got: ${JSON.stringify(diagnostics)}`
    )
    t.falsy(schema.namespaces.half.component)
})

test('capabilities are captured package-qualified, closed over extends, and local interfaces refused', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('capability-tsconfig.json'))

    // Implementing the subinterface emits the parent too, so a runtime search stays a flat match.
    t.deepEqual(schema.namespaces.renderer.capabilities, ['@fixture/contracts/AdvancedRenderer', '@fixture/contracts/Renderer'])

    // A local interface is not a shared identity, and saying so loudly is the whole protection:
    // two vendors' private `UiBuilder`s must never match each other by accident.
    t.true(
        diagnostics.some((diagnostic) => /declared in this same package/.test(diagnostic.reason)),
        `expected the local-interface diagnostic, got: ${JSON.stringify(diagnostics)}`
    )
    t.falsy(schema.namespaces.local_spinner.capabilities, 'the refused capability is absent, not degraded to a bare name')
})

test('an injected invocation handle never reaches the contract, and the half-declared states are named', (t) => {
    const { schema, diagnostics } = extractSchema(fixture('capability-tsconfig.json'))

    // Declared and present: the final parameter is the runtime's, so callers see the method without it.
    const audit = schema.namespaces.renderer.methods.audit
    t.is(audit.params.length, 1)
    t.deepEqual(audit.paramNames, ['layout'])

    // Present without the declaration: nothing will inject it, and silence would ship a handler
    // reading undefined - so it is a diagnostic, in the extractor's usual loud tradition.
    t.true(
        diagnostics.some((diagnostic) => /nothing will ever inject it/.test(diagnostic.reason)),
        `expected the orphaned-handle diagnostic, got: ${JSON.stringify(diagnostics)}`
    )

    // A mistyped effect is the same class of mistake and gets the same treatment: this is the
    // field a grant is written against, so a typo must not quietly publish a method that claims
    // nothing about the power it exercises.
    t.true(
        diagnostics.some((diagnostic) => /declares effect 'programme'/.test(diagnostic.reason)),
        `expected the mistyped-effect diagnostic, got: ${JSON.stringify(diagnostics)}`
    )
    t.is(schema.namespaces.local_spinner.methods.misspelled.effect, undefined, 'a refused effect is absent, never guessed')
})
