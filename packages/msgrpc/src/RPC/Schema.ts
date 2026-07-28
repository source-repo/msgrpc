/**
 * A small type language for describing what an exposed method accepts and returns, and a validator
 * for it.
 *
 * Deliberately not JSON Schema. It has to describe what MsgPack actually carries - Uint8Array and
 * Date are values here, not string encodings of them - and it has to be checkable without pulling
 * a validation engine into a package that ships to browsers and embedded targets.
 *
 * Nothing generates these yet; they are written by hand or supplied by a build step. The format
 * carries version and history fields from the start so adding that step later needs no change to
 * the document.
 */

export type TypeNode =
    /** Accepts anything. Use sparingly: it is the hole every other check is trying to close. */
    | { kind: 'any' }
    | { kind: 'null' }
    | { kind: 'boolean' }
    | { kind: 'number'; integer?: boolean; min?: number; max?: number }
    | { kind: 'string'; pattern?: string; minLength?: number; maxLength?: number }
    /** Uint8Array, which MsgPack carries natively. */
    | { kind: 'bytes'; maxBytes?: number }
    | { kind: 'date' }
    | { kind: 'literal'; value: string | number | boolean | null }
    | { kind: 'array'; items: TypeNode; maxItems?: number }
    | { kind: 'tuple'; items: TypeNode[] }
    | { kind: 'object'; fields: { [name: string]: FieldNode }; additional?: boolean }
    /**
     * A dictionary: keys not known in advance, values all of one type. `{ [tag: string]: Reading }`
     * is how plant data usually arrives, and describing it as an `object` would produce a type that
     * refuses every value, since it has no named properties to declare.
     *
     * `keyPattern` constrains the keys, which is what a numeric index signature becomes - a JS
     * object key is always a string, so `{ [id: number]: X }` is a string key that must read as a
     * number rather than a separate key type.
     */
    | { kind: 'record'; values: TypeNode; keyPattern?: string; maxEntries?: number }
    | { kind: 'union'; options: TypeNode[] }
    /** Reference to a named type, which is how recursive and shared shapes are expressed. */
    | { kind: 'ref'; name: string }

export interface FieldNode {
    type: TypeNode
    optional?: boolean
}

export interface MethodSchema {
    /** One entry per positional parameter. */
    params: TypeNode[]
    /**
     * Parameter names, positionally matching `params`. Carried for tooling that has to present a
     * call to a person - a form needs a label, and "argument 0" is not one. Never used for
     * checking, so a schema written by hand can leave it out.
     */
    paramNames?: string[]
    /** Type of any further arguments, for a rest parameter. Absent means no extra arguments. */
    rest?: TypeNode
    /** Checked only when result validation is on. */
    returns?: TypeNode
}

export interface NamespaceSchema {
    /**
     * Contract version for this namespace, for diagnostics. Reported alongside a validation
     * failure so a stale caller is recognisable as one, rather than looking like a type error.
     */
    version?: string
    methods: { [method: string]: MethodSchema }
    events?: { [event: string]: { params: TypeNode[] } }
    /** Skip validation for this namespace, for a hot path where the cost is not worth it. */
    validate?: boolean
    /**
     * Earlier versions of this namespace, newest last. Reserved for the extraction CLI, which uses
     * them to detect a breaking change before it ships. Not consulted for dispatch: a call that
     * was valid under an older contract still reaches the current implementation, so accepting it
     * would move the failure from the validator into the method body.
     */
    history?: { [version: string]: Omit<NamespaceSchema, 'history'> }
}

export interface RpcSchema {
    /** Format version of this document, not of the contract it describes. */
    schema: 1
    /** Contract version covering the document as a whole. */
    version?: string
    types?: { [name: string]: TypeNode }
    namespaces: { [namespace: string]: NamespaceSchema }
}

/** Guards against a hostile payload nesting deeply enough to exhaust the stack. */
const MAX_DEPTH = 32

const typeName = (value: unknown): string => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    if (value instanceof Uint8Array) return 'bytes'
    if (value instanceof Date) return 'date'
    return typeof value
}

const describe = (type: TypeNode): string => {
    switch (type.kind) {
        case 'literal':
            return JSON.stringify(type.value)
        case 'array':
            return `${describe(type.items)}[]`
        case 'tuple':
            return `[${type.items.map(describe).join(', ')}]`
        case 'union':
            return type.options.map(describe).join(' | ')
        case 'ref':
            return type.name
        case 'object':
            return 'object'
        case 'record':
            return `{ [key: string]: ${describe(type.values)} }`
        default:
            return type.kind
    }
}

/** Rejects the things that are `typeof 'object'` but are values in their own right here. */
const isPlainObject = (value: unknown): value is { [key: string]: unknown } =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date)

/**
 * Returns a human-readable reason the value does not match, or undefined when it does. The path
 * names the offending position, because "expected number" is not much help three levels into an
 * argument.
 */
export const validateValue = (value: unknown, type: TypeNode, types: RpcSchema['types'] = {}, path = '', depth = 0): string | undefined => {
    if (depth > MAX_DEPTH) return `${path || 'value'}: nested deeper than ${MAX_DEPTH} levels`
    const at = path || 'value'
    switch (type.kind) {
        case 'any':
            return undefined
        case 'null':
            return value === null ? undefined : `${at}: expected null, got ${typeName(value)}`
        case 'boolean':
            return typeof value === 'boolean' ? undefined : `${at}: expected boolean, got ${typeName(value)}`
        case 'number': {
            if (typeof value !== 'number' || Number.isNaN(value)) return `${at}: expected number, got ${typeName(value)}`
            if (type.integer && !Number.isInteger(value)) return `${at}: expected an integer, got ${value}`
            if (type.min !== undefined && value < type.min) return `${at}: ${value} is below the minimum ${type.min}`
            if (type.max !== undefined && value > type.max) return `${at}: ${value} is above the maximum ${type.max}`
            return undefined
        }
        case 'string': {
            if (typeof value !== 'string') return `${at}: expected string, got ${typeName(value)}`
            if (type.minLength !== undefined && value.length < type.minLength) return `${at}: shorter than ${type.minLength} characters`
            if (type.maxLength !== undefined && value.length > type.maxLength) return `${at}: longer than ${type.maxLength} characters`
            if (type.pattern !== undefined && !new RegExp(type.pattern).test(value)) return `${at}: does not match ${type.pattern}`
            return undefined
        }
        case 'bytes': {
            if (!(value instanceof Uint8Array)) return `${at}: expected bytes, got ${typeName(value)}`
            if (type.maxBytes !== undefined && value.length > type.maxBytes) return `${at}: longer than ${type.maxBytes} bytes`
            return undefined
        }
        case 'date':
            return value instanceof Date && !Number.isNaN(value.getTime()) ? undefined : `${at}: expected a date, got ${typeName(value)}`
        case 'literal':
            return value === type.value ? undefined : `${at}: expected ${JSON.stringify(type.value)}`
        case 'array': {
            if (!Array.isArray(value)) return `${at}: expected an array, got ${typeName(value)}`
            if (type.maxItems !== undefined && value.length > type.maxItems) return `${at}: more than ${type.maxItems} items`
            for (let i = 0; i < value.length; i++) {
                const failure = validateValue(value[i], type.items, types, `${at}[${i}]`, depth + 1)
                if (failure) return failure
            }
            return undefined
        }
        case 'tuple': {
            if (!Array.isArray(value)) return `${at}: expected a tuple, got ${typeName(value)}`
            if (value.length !== type.items.length) return `${at}: expected ${type.items.length} elements, got ${value.length}`
            for (let i = 0; i < type.items.length; i++) {
                const failure = validateValue(value[i], type.items[i], types, `${at}[${i}]`, depth + 1)
                if (failure) return failure
            }
            return undefined
        }
        case 'object': {
            if (!isPlainObject(value)) return `${at}: expected an object, got ${typeName(value)}`
            const record = value
            for (const [name, field] of Object.entries(type.fields)) {
                const present = record[name] !== undefined
                if (!present) {
                    if (field.optional) continue
                    return `${at}.${name}: missing`
                }
                const failure = validateValue(record[name], field.type, types, `${at}.${name}`, depth + 1)
                if (failure) return failure
            }
            if (!type.additional) {
                const extra = Object.keys(record).find((key) => !(key in type.fields))
                // Refused rather than ignored: an unexpected property is usually a caller built
                // against a different contract, and silently dropping it hides that.
                if (extra !== undefined) return `${at}.${extra}: not part of this type`
            }
            return undefined
        }
        case 'record': {
            if (!isPlainObject(value)) return `${at}: expected an object, got ${typeName(value)}`
            const keys = Object.keys(value)
            // Bounded like an array, and for the same reason: a dictionary is the other shape a
            // caller can grow without limit.
            if (type.maxEntries !== undefined && keys.length > type.maxEntries) return `${at}: more than ${type.maxEntries} entries`
            const pattern = type.keyPattern === undefined ? undefined : new RegExp(type.keyPattern)
            for (const key of keys) {
                if (pattern && !pattern.test(key)) return `${at}.${key}: key does not match ${type.keyPattern}`
                const failure = validateValue(value[key], type.values, types, `${at}.${key}`, depth + 1)
                if (failure) return failure
            }
            return undefined
        }
        case 'union': {
            for (const option of type.options) if (!validateValue(value, option, types, at, depth + 1)) return undefined
            return `${at}: expected ${describe(type)}, got ${typeName(value)}`
        }
        case 'ref': {
            const target = types[type.name]
            if (!target) return `${at}: unknown type '${type.name}'`
            return validateValue(value, target, types, at, depth + 1)
        }
    }
    // Unreachable for a well-formed node, and deliberately not a silent pass: a kind this validator
    // does not know - a typo, or a document written for a later version of the language - would
    // otherwise fall through as valid, which is an unchecked value wearing a checked type.
    return `${at}: unknown type kind '${(type as TypeNode).kind}'`
}

/** Returns a reason the arguments do not match the method's parameters, or undefined. */
export const validateParams = (params: unknown[], method: MethodSchema, types: RpcSchema['types'] = {}): string | undefined => {
    const required = method.params.filter((_, index) => !isOptional(method.params[index])).length
    if (params.length < required) return `expected at least ${required} argument${required === 1 ? '' : 's'}, got ${params.length}`
    if (params.length > method.params.length && !method.rest) return `expected at most ${method.params.length} arguments, got ${params.length}`
    for (let i = 0; i < params.length; i++) {
        const type = i < method.params.length ? method.params[i] : method.rest!
        const failure = validateValue(params[i], type, types, `argument ${i}`)
        if (failure) return failure
    }
    return undefined
}

/** A parameter is optional when its type admits undefined, expressed as a union with a null literal. */
const isOptional = (type: TypeNode) => type.kind === 'any' || (type.kind === 'union' && type.options.some((o) => o.kind === 'literal' && o.value === null))
