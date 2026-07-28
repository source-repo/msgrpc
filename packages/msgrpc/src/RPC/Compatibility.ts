import { MethodSchema, NamespaceSchema, RpcSchema, TypeNode } from './Schema.js'

/**
 * Deciding whether a caller built against an older contract can safely talk to the current one.
 *
 * Validating an old call against its own old schema would prove nothing: it still reaches the
 * current implementation, so acceptance would only move the failure from the validator into the
 * method body. What the stored history is actually good for is comparing the two contracts and
 * asking whether every call the old one permitted is still one this one handles.
 *
 * That is ordinary function subtyping. Parameters are contravariant - the current contract has to
 * accept everything the old one allowed, so widening a parameter is safe and narrowing it is not.
 * Returns are covariant - everything the current contract can return has to fit what the old
 * caller expects, so narrowing a return is safe and widening it is not.
 *
 * The check is conservative: where it cannot prove compatibility it reports incompatibility, since
 * a false "safe" is the expensive direction.
 */

export interface Incompatibility {
    /** Where the problem is, e.g. "writeSetpoint argument 0". */
    where: string
    reason: string
}

const resolve = (type: TypeNode, types: RpcSchema['types']): TypeNode => (type.kind === 'ref' ? resolve(types?.[type.name] ?? { kind: 'any' }, types) : type)

const widerOrEqualNumber = (from: { min?: number; max?: number; integer?: boolean }, to: { min?: number; max?: number; integer?: boolean }) => {
    if (to.integer && !from.integer) return false
    if (to.min !== undefined && (from.min === undefined || from.min < to.min)) return false
    if (to.max !== undefined && (from.max === undefined || from.max > to.max)) return false
    return true
}

/**
 * True when every value valid under `from` is also valid under `to`.
 *
 * Depth-limited for the same reason the validator is: a recursive pair of types must not be able
 * to spin this forever.
 */
export const assignable = (from: TypeNode, to: TypeNode, types: RpcSchema['types'] = {}, depth = 0): boolean => {
    if (depth > 32) return false
    const source = resolve(from, types)
    const target = resolve(to, types)

    if (target.kind === 'any') return true
    // An 'any' source can hold anything, so only an 'any' target can accept it.
    if (source.kind === 'any') return false

    if (source.kind === 'union') return source.options.every((option) => assignable(option, target, types, depth + 1))
    if (target.kind === 'union') return target.options.some((option) => assignable(source, option, types, depth + 1))

    if (source.kind === 'literal') {
        if (target.kind === 'literal') return source.value === target.value
        const literalKind = source.value === null ? 'null' : typeof source.value
        if (literalKind !== target.kind) return false
        if (target.kind === 'number' && typeof source.value === 'number') return widerOrEqualNumber({ min: source.value, max: source.value, integer: Number.isInteger(source.value) }, target)
        return true
    }
    if (source.kind !== target.kind) return false

    switch (source.kind) {
        case 'null':
        case 'boolean':
        case 'date':
            return true
        case 'number':
            return widerOrEqualNumber(source, target as typeof source)
        case 'string': {
            const stringTarget = target as typeof source
            if (stringTarget.minLength !== undefined && (source.minLength === undefined || source.minLength < stringTarget.minLength)) return false
            if (stringTarget.maxLength !== undefined && (source.maxLength === undefined || source.maxLength > stringTarget.maxLength)) return false
            // Regex subsumption is undecidable in general, so only an identical pattern counts.
            if (stringTarget.pattern !== undefined && stringTarget.pattern !== source.pattern) return false
            return true
        }
        case 'bytes': {
            const bytesTarget = target as typeof source
            return bytesTarget.maxBytes === undefined || (source.maxBytes !== undefined && source.maxBytes <= bytesTarget.maxBytes)
        }
        case 'array': {
            const arrayTarget = target as typeof source
            if (arrayTarget.maxItems !== undefined && (source.maxItems === undefined || source.maxItems > arrayTarget.maxItems)) return false
            return assignable(source.items, arrayTarget.items, types, depth + 1)
        }
        case 'tuple': {
            const tupleTarget = target as typeof source
            if (source.items.length !== tupleTarget.items.length) return false
            return source.items.every((item, index) => assignable(item, tupleTarget.items[index], types, depth + 1))
        }
        case 'object': {
            const objectTarget = target as typeof source
            for (const [name, field] of Object.entries(objectTarget.fields)) {
                const sourceField = source.fields[name]
                if (!sourceField) {
                    // Gaining an optional field is the ordinary way a contract evolves; only a new
                    // required field breaks a source that never supplied it.
                    if (field.optional) continue
                    return false
                }
                if (!field.optional && sourceField.optional) return false
                if (!assignable(sourceField.type, field.type, types, depth + 1)) return false
            }
            if (!objectTarget.additional) {
                // The source could produce a property the target refuses.
                for (const name of Object.keys(source.fields)) if (!(name in objectTarget.fields)) return false
            }
            return true
        }
        default:
            return false
    }
}

/** Lowest number of arguments a caller of this method might send. */
const requiredArity = (method: MethodSchema) =>
    method.params.filter((type) => !(type.kind === 'any' || (type.kind === 'union' && type.options.some((o) => o.kind === 'literal' && o.value === null)))).length

const methodProblems = (name: string, caller: MethodSchema, current: MethodSchema, types: RpcSchema['types']): Incompatibility[] => {
    const problems: Incompatibility[] = []

    // The current contract must accept every argument count the old caller might send.
    if (!current.rest && current.params.length < caller.params.length)
        problems.push({ where: name, reason: `takes at most ${current.params.length} arguments, but a caller may send ${caller.params.length}` })
    if (requiredArity(current) > requiredArity(caller))
        problems.push({ where: name, reason: `requires ${requiredArity(current)} arguments, but a caller may send as few as ${requiredArity(caller)}` })

    // Parameters are contravariant: what the caller may send must still be accepted.
    for (let i = 0; i < caller.params.length; i++) {
        const currentParam = i < current.params.length ? current.params[i] : current.rest
        if (!currentParam) continue
        if (!assignable(caller.params[i], currentParam, types))
            problems.push({ where: `${name} argument ${i}`, reason: 'narrowed, so a value the caller may send is no longer accepted' })
    }

    // Returns are covariant: what this contract returns must still be understood.
    if (caller.returns && current.returns && !assignable(current.returns, caller.returns, types))
        problems.push({ where: `${name} return`, reason: 'widened, so a value this contract may return is not one the caller expects' })

    return problems
}

/**
 * Compares the contract a caller was built against with the one now being served. An empty result
 * means every call the caller might make is still handled.
 */
export const namespaceProblems = (caller: NamespaceSchema, current: NamespaceSchema, types: RpcSchema['types'] = {}): Incompatibility[] => {
    const problems: Incompatibility[] = []

    for (const [name, callerMethod] of Object.entries(caller.methods)) {
        const currentMethod = current.methods[name]
        if (!currentMethod) {
            problems.push({ where: name, reason: 'no longer exists' })
            continue
        }
        problems.push(...methodProblems(name, callerMethod, currentMethod, types))
    }

    // Events travel the other way: emitted here, received there.
    for (const [name, callerEvent] of Object.entries(caller.events ?? {})) {
        const currentEvent = current.events?.[name]
        if (!currentEvent) {
            // Not unsafe, but a subscription that can never fire is a silent failure worth naming.
            problems.push({ where: `event ${name}`, reason: 'is no longer emitted, so a subscription to it would never fire' })
            continue
        }
        for (let i = 0; i < currentEvent.params.length; i++) {
            const callerParam = callerEvent.params[i]
            if (!callerParam) {
                problems.push({ where: `event ${name} argument ${i}`, reason: 'is emitted but the caller does not expect it' })
                continue
            }
            if (!assignable(currentEvent.params[i], callerParam, types))
                problems.push({ where: `event ${name} argument ${i}`, reason: 'widened, so a value this contract may emit is not one the caller expects' })
        }
    }

    return problems
}

/** One line naming why an older contract cannot be served, or undefined when it can. */
export const describeProblems = (namespace: string, version: string, current: string | undefined, problems: Incompatibility[]) =>
    problems.length
        ? `${namespace}@${version} is not compatible with ${namespace}@${current ?? 'current'}: ` +
          problems.map((problem) => `${problem.where} ${problem.reason}`).join('; ')
        : undefined
