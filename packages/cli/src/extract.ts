import { resolve as resolvePath, dirname } from 'node:path'
import { ClassDeclaration, MethodDeclaration, Node, Project, ts, Type } from 'ts-morph'
import type { MethodSchema, NamespaceSchema, RpcMethodSemantics, RpcSchema, TypeNode } from '@source-repo/rpc'

/**
 * Reads a contract out of TypeScript source.
 *
 * The rule that keeps this honest: anything the type language cannot represent is reported, never
 * emitted as `any`. A schema that quietly degrades on the hard cases is worse than no schema,
 * because it still looks like protection while checking nothing.
 *
 * Static analysis only - no user code is executed - so the namespace has to be declared in the
 * source with @rpcNamespace rather than inferred from an exposeClassInstance call somewhere else.
 */

export interface Diagnostic {
    /** Where the problem is, e.g. "Plant.writeSetpoint argument 0". */
    where: string
    reason: string
    file?: string
    line?: number
}

export interface ExtractResult {
    schema: RpcSchema
    diagnostics: Diagnostic[]
}

interface Context {
    types: { [name: string]: TypeNode }
    diagnostics: Diagnostic[]
    /** Named types currently being converted, so a recursive one becomes a ref instead of looping. */
    inProgress: Set<string>
    where: string
    node: Node
}

const fail = (context: Context, reason: string): TypeNode => {
    context.diagnostics.push({
        where: context.where,
        reason,
        file: context.node.getSourceFile().getFilePath(),
        line: context.node.getStartLineNumber()
    })
    // Returned so extraction can continue and report everything at once. The caller refuses the
    // whole run when any diagnostic was raised, so this never reaches a schema file.
    return { kind: 'any' }
}

/** The name to key a shared or recursive type under, or undefined for an anonymous shape. */
const nameOf = (type: Type) => {
    // An instantiated generic has a symbol but not a usable name: Record<string, number> and
    // Record<string, string> share the symbol `Record`, so keying both under it would silently make
    // the second a reference to the first's value type. Inline them instead.
    if (type.getAliasTypeArguments().length || type.getTypeArguments().length) return undefined
    const alias = type.getAliasSymbol()?.getName()
    if (alias && alias !== '__type') return alias
    const symbol = type.getSymbol()?.getName()
    return symbol && symbol !== '__type' && symbol !== '__object' ? symbol : undefined
}

const isPromise = (type: Type) => type.getSymbol()?.getName() === 'Promise'

export const typeToNode = (type: Type, context: Context, depth = 0): TypeNode => {
    if (depth > 24) return fail(context, 'nests deeper than the extractor follows')

    if (type.isAny() || type.isUnknown()) return { kind: 'any' }
    if (type.isTypeParameter()) return fail(context, `is generic (${type.getText()}), which has no runtime type to check`)
    if (type.getCallSignatures().length) return fail(context, 'is a function, which cannot be checked on the wire')

    if (type.isString()) return { kind: 'string' }
    if (type.isNumber()) return { kind: 'number' }
    if (type.isBoolean()) return { kind: 'boolean' }
    if (type.isNull()) return { kind: 'null' }
    if (type.isStringLiteral()) return { kind: 'literal', value: type.getLiteralValue() as string }
    if (type.isNumberLiteral()) return { kind: 'literal', value: type.getLiteralValue() as number }
    if (type.isBooleanLiteral()) return { kind: 'literal', value: type.getText() === 'true' }

    const symbolName = type.getSymbol()?.getName()
    // Both are values under MsgPack rather than encodings of them.
    if (symbolName === 'Date') return { kind: 'date' }
    if (symbolName === 'Uint8Array') return { kind: 'bytes' }
    if (symbolName === 'Map' || symbolName === 'Set')
        return fail(context, `is a ${symbolName}, which MsgPack does not carry; use an object or an array`)

    if (type.isTuple()) return { kind: 'tuple', items: type.getTupleElements().map((element) => typeToNode(element, context, depth + 1)) }
    if (type.isArray()) {
        const element = type.getArrayElementType()
        return element ? { kind: 'array', items: typeToNode(element, context, depth + 1) } : fail(context, 'is an array of an unknown element type')
    }

    // A named union or object becomes a reference. Registering only objects meant a recursive
    // union - a value type, an AST node - was expanded inline until it ran out of depth.
    const name = nameOf(type)
    if (name && (type.isUnion() || type.isObject())) {
        if (context.inProgress.has(name) || context.types[name]) return { kind: 'ref', name }
        context.inProgress.add(name)
        context.types[name] = { kind: 'any' } // placeholder, so a member referring back resolves
        context.types[name] = type.isUnion() ? unionToNode(type, context, depth) : objectToNode(type, context, depth)
        context.inProgress.delete(name)
        return { kind: 'ref', name }
    }

    if (type.isUnion()) return unionToNode(type, context, depth)
    if (type.isObject()) return objectToNode(type, context, depth)

    return fail(context, `has no representation in the schema type language (${type.getText()})`)
}

const unionToNode = (type: Type, context: Context, depth: number): TypeNode => {
    // undefined in a union means optional, which the parameter and field layers handle.
    const options = type.getUnionTypes().filter((option) => !option.isUndefined())
    if (!options.length) return fail(context, 'is undefined only')
    if (options.length === 1) return typeToNode(options[0], context, depth + 1)
    // A boolean surfaces as true | false; collapse it back.
    if (options.length === 2 && options.every((option) => option.isBooleanLiteral())) return { kind: 'boolean' }
    return { kind: 'union', options: options.map((option) => typeToNode(option, context, depth + 1)) }
}

const objectToNode = (type: Type, context: Context, depth: number): TypeNode => {
    // getProperties() cannot see an index signature, so a dictionary has to be recognised here or
    // it would be described as an object permitting no properties at all, refusing every value.
    const indexed = type.getStringIndexType() ?? type.getNumberIndexType()
    if (indexed) {
        // Both at once would need a type that is part record and part object. Refused rather than
        // guessed: dropping either half produces a contract that looks checked and is not.
        if (type.getProperties().length)
            return fail(context, 'has both declared properties and an index signature, which the schema type language cannot describe yet')
        // A numeric index is still a string key on the wire, since JS object keys always are.
        const numeric = !type.getStringIndexType()
        return { kind: 'record', values: typeToNode(indexed, context, depth + 1), ...(numeric ? { keyPattern: '^-?\\d+$' } : {}) }
    }
    const fields: { [name: string]: { type: TypeNode; optional?: boolean } } = {}
    for (const property of type.getProperties()) {
        const propertyType = property.getTypeAtLocation(context.node)
        const optional = property.isOptional() || propertyType.isNullable()
        const nested = { ...context, where: `${context.where}.${property.getName()}` }
        fields[property.getName()] = { type: typeToNode(propertyType, nested, depth + 1), ...(optional ? { optional: true } : {}) }
    }
    return { kind: 'object', fields }
}

const hasDecorator = (node: MethodDeclaration | ClassDeclaration, name: string) =>
    node.getDecorators().some((decorator) => decorator.getName() === name)

/** A string property of an object literal passed to a decorator, when it is written as a literal. */
const literalOption = (argument: Node | undefined, option: string) => {
    if (!Node.isObjectLiteralExpression(argument)) return undefined
    const property = argument.getProperty(option)
    if (!Node.isPropertyAssignment(property)) return undefined
    const initializer = property.getInitializer()
    return Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined
}

const SEMANTICS = new Set<string>(['query', 'idempotent-command', 'non-repeatable-command'])

/**
 * What `@rpc({ semantics: '…' })` declares, if anything.
 *
 * Part of the contract rather than of the implementation: it is a promise about whether a caller
 * may repeat the call, and `check` compares it between versions like any other part of the shape.
 */
const declaredSemantics = (method: MethodDeclaration, context: Context): RpcMethodSemantics | undefined => {
    const decorator = method.getDecorators().find((candidate) => candidate.getName() === 'rpc')
    const declared = literalOption(decorator?.getArguments()[0], 'semantics')
    if (declared === undefined) return undefined
    if (!SEMANTICS.has(declared)) {
        // Named rather than dropped: a typo here would quietly publish a contract saying nothing
        // about a method whose author thought they had said something about it.
        context.diagnostics.push({
            where: context.where,
            reason: `declares semantics '${declared}', which is not one of ${[...SEMANTICS].join(', ')}`,
            file: method.getSourceFile().getFilePath(),
            line: method.getStartLineNumber()
        })
        return undefined
    }
    return declared as RpcMethodSemantics
}

const namespaceDeclaration = (declaration: ClassDeclaration, diagnostics: Diagnostic[]) => {
    const decorator = declaration.getDecorators().find((candidate) => candidate.getName() === 'rpcNamespace')
    if (!decorator) return undefined
    const [nameArgument, optionsArgument] = decorator.getArguments()
    // Reported rather than skipped. This reads the source rather than running it, so a name that is
    // a constant cannot be resolved - and a class quietly left out produced a contract with nothing
    // in it whose only symptom was the count in "wrote 0 namespaces", which reads like success.
    if (!Node.isStringLiteral(nameArgument)) {
        diagnostics.push({
            where: declaration.getName() ?? 'class',
            reason: `declares @rpcNamespace(${nameArgument?.getText() ?? ''}) - the name has to be a literal, since this reads the source rather than running it`,
            file: declaration.getSourceFile().getFilePath(),
            line: declaration.getStartLineNumber()
        })
        return undefined
    }
    const name = nameArgument.getLiteralValue()
    if (!name) return undefined
    let version: string | undefined
    if (Node.isObjectLiteralExpression(optionsArgument)) {
        const property = optionsArgument.getProperty('version')
        if (Node.isPropertyAssignment(property)) {
            const initializer = property.getInitializer()
            if (Node.isStringLiteral(initializer)) version = initializer.getLiteralValue()
        }
    }
    return { name, version }
}

const methodToSchema = (method: MethodDeclaration, context: Context): MethodSchema => {
    const params: TypeNode[] = []
    const paramNames: string[] = []
    let rest: TypeNode | undefined
    for (const parameter of method.getParameters()) {
        const at = { ...context, where: `${context.where} argument ${params.length}`, node: parameter }
        if (parameter.isRestParameter()) {
            const element = parameter.getType().getArrayElementType()
            rest = element ? typeToNode(element, at) : fail(at, 'is a rest parameter of an unknown element type')
            continue
        }
        const node = typeToNode(parameter.getType(), at)
        // An optional parameter is expressed as a union admitting null, which is what the
        // validator reads to decide how few arguments a caller may send.
        params.push(parameter.isOptional() ? { kind: 'union', options: [node, { kind: 'literal', value: null }] } : node)
        paramNames.push(parameter.getName())
    }

    let returnType = method.getReturnType()
    if (isPromise(returnType)) returnType = returnType.getTypeArguments()[0] ?? returnType
    const returns = returnType.isVoid() || returnType.isUndefined() ? undefined : typeToNode(returnType, { ...context, where: `${context.where} return` })

    const semantics = declaredSemantics(method, context)
    return {
        params,
        ...(paramNames.length ? { paramNames } : {}),
        ...(rest ? { rest } : {}),
        ...(returns ? { returns } : {}),
        ...(semantics ? { semantics } : {})
    }
}

/**
 * Events are declared as a property type rather than inferred from emit() calls, which cannot be
 * read statically with any confidence:
 *
 * ```typescript
 * declare rpcEvents: { alarm: [message: string] }
 * ```
 */
const eventsFromDeclaration = (declaration: ClassDeclaration, context: Context) => {
    const property = declaration.getProperty('rpcEvents')
    if (!property) return undefined
    const events: { [event: string]: { params: TypeNode[] } } = {}
    for (const event of property.getType().getProperties()) {
        const at = { ...context, where: `${context.where} event ${event.getName()}`, node: property }
        const tuple = event.getTypeAtLocation(property)
        if (!tuple.isTuple()) {
            fail(at, 'must be declared as a tuple of its arguments, e.g. [message: string]')
            continue
        }
        events[event.getName()] = { params: tuple.getTupleElements().map((element) => typeToNode(element, at)) }
    }
    return Object.keys(events).length ? events : undefined
}

export const extractSchema = (tsConfigFilePath: string): ExtractResult => {
    const project = new Project({ tsConfigFilePath })
    // Exactly what include/files/exclude resolve to, asked of TypeScript rather than inferred.
    // Resolving types pulls dependencies into the project, and `extract --project` should describe
    // this project rather than every decorated class it happens to import.
    const configured = ts.parseJsonConfigFileContent(
        ts.readConfigFile(tsConfigFilePath, ts.sys.readFile).config,
        ts.sys,
        dirname(resolvePath(tsConfigFilePath))
    )
    const own = new Set(configured.fileNames.map((file) => resolvePath(file)))
    const diagnostics: Diagnostic[] = []
    const types: { [name: string]: TypeNode } = {}
    const namespaces: { [namespace: string]: NamespaceSchema } = {}

    for (const sourceFile of project.getSourceFiles().filter((file) => own.has(resolvePath(file.getFilePath())))) {
        for (const declaration of sourceFile.getClasses()) {
            const declared = namespaceDeclaration(declaration, diagnostics)
            if (!declared) continue

            const methods: { [method: string]: MethodSchema } = {}
            const context: Context = { types, diagnostics, inProgress: new Set(), where: declaration.getName() ?? 'class', node: declaration }
            for (const method of declaration.getMethods()) {
                if (!hasDecorator(method, 'rpc')) continue
                methods[method.getName()] = methodToSchema(method, { ...context, where: `${declared.name}.${method.getName()}`, node: method })
            }
            if (!Object.keys(methods).length) {
                diagnostics.push({
                    where: declared.name,
                    reason: 'declares @rpcNamespace but marks no @rpc methods, so it would expose nothing',
                    file: sourceFile.getFilePath(),
                    line: declaration.getStartLineNumber()
                })
                continue
            }
            const events = eventsFromDeclaration(declaration, { ...context, where: declared.name })
            namespaces[declared.name] = { ...(declared.version ? { version: declared.version } : {}), methods, ...(events ? { events } : {}) }
        }
    }

    // One unrepresentable type reaches every leaf beneath it, so the same complaint repeats.
    const seen = new Set<string>()
    const unique = diagnostics.filter((diagnostic) => {
        const key = `${diagnostic.where}|${diagnostic.reason}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
    return { schema: { schema: 1, ...(Object.keys(types).length ? { types } : {}), namespaces }, diagnostics: unique }
}
