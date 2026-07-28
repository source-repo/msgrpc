import { TypeNode, ServerDescription, isOptional, requiredPart, resolve, typeText } from './types'

/**
 * One input per argument, chosen from the argument's own type, rather than one JSON array for the
 * whole call. A setpoint should be a number box and a mode should be a dropdown of the modes that
 * exist; making someone hand-write `[1200, "auto"]` puts the burden of the schema back on them.
 *
 * The value held per field is always a string, and `toValue` turns it into what the wire needs. A
 * shape the widgets cannot express - an object, an array, anything named - falls back to JSON in a
 * textarea, which is honest rather than pretending to render an editor for it.
 */

export interface FieldState {
    text: string
    include: boolean
}

const literalOptions = (type: TypeNode | undefined): (string | number | boolean | null)[] | undefined => {
    if (type?.kind !== 'union') return undefined
    const values = type.options.filter((option) => option.kind === 'literal').map((option) => (option as { value: string | number | boolean | null }).value)
    return values.length === type.options.length && values.length > 0 ? values : undefined
}

const hexToBytes = (text: string) => {
    const hex = text.replace(/[\s:]/g, '')
    if (hex.length % 2) throw new Error('expected an even number of hex digits')
    if (hex && !/^[0-9a-fA-F]+$/.test(hex)) throw new Error('expected hex digits')
    return Uint8Array.from(hex.match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [])
}

/** The first option a union offers, ignoring the null that marks it optional. */
const firstOption = (type: TypeNode & { kind: 'union' }) => type.options.find((option) => !(option.kind === 'literal' && option.value === null)) ?? type.options[0]

/**
 * A value of the given type, used to fill the JSON box with a skeleton rather than `{}`. Someone
 * calling `configure(limits: Limits)` should see the field names, not have to look them up.
 */
const sample = (type: TypeNode | undefined, types: ServerDescription['types'], depth = 0): unknown => {
    const target = resolve(requiredPart(type), types)
    if (!target || depth > 4) return null
    switch (target.kind) {
        case 'number':
            return target.min ?? 0
        case 'string':
        case 'bytes':
            return ''
        case 'boolean':
            return false
        case 'date':
            return new Date()
        case 'literal':
            return target.value
        case 'array':
            return []
        case 'tuple':
            return target.items.map((item) => sample(item, types, depth + 1))
        case 'union':
            return sample(firstOption(target), types, depth + 1)
        case 'object':
            return Object.fromEntries(
                Object.entries(target.fields)
                    .filter(([, field]) => !field.optional)
                    .map(([name, field]) => [name, sample(field.type, types, depth + 1)])
            )
        default:
            return null
    }
}

/**
 * JSON has no date and no byte string, so what comes out of the textarea has to be walked against
 * the type and converted. Without this, any object with a timestamp in it is unusable from the
 * form: the server checks for a Date and receives a string.
 */
const coerce = (value: unknown, type: TypeNode | undefined, types: ServerDescription['types'], depth = 0): unknown => {
    const target = resolve(type, types)
    if (!target || value === null || value === undefined || depth > 8) return value
    switch (target.kind) {
        case 'date':
            return typeof value === 'string' || typeof value === 'number' ? new Date(value) : value
        case 'bytes':
            return typeof value === 'string' ? hexToBytes(value) : value
        case 'array':
            return Array.isArray(value) ? value.map((item) => coerce(item, target.items, types, depth + 1)) : value
        case 'tuple':
            return Array.isArray(value) ? value.map((item, index) => coerce(item, target.items[index], types, depth + 1)) : value
        case 'object':
            if (typeof value !== 'object' || Array.isArray(value)) return value
            return Object.fromEntries(Object.entries(value as { [name: string]: unknown }).map(([name, field]) => [name, coerce(field, target.fields[name]?.type, types, depth + 1)]))
        case 'union': {
            // Only when the union leaves one real choice. Guessing which branch was meant would be
            // worse than sending what was typed and letting the server say why it is wrong.
            const options = target.options.filter((option) => !(option.kind === 'literal' && option.value === null))
            return options.length === 1 ? coerce(value, options[0], types, depth + 1) : value
        }
        default:
            return value
    }
}

/** Turns the field's text into the value to send, or throws with something a person can act on. */
export const toValue = (text: string, type: TypeNode | undefined, types: ServerDescription['types']): unknown => {
    const target = resolve(requiredPart(type), types)
    const trimmed = text.trim()
    switch (target?.kind) {
        case 'number': {
            if (trimmed === '') throw new Error('expected a number')
            const value = Number(trimmed)
            if (Number.isNaN(value)) throw new Error(`${trimmed} is not a number`)
            return value
        }
        case 'boolean':
            return trimmed === 'true'
        case 'string':
            return text
        case 'date': {
            const value = new Date(trimmed)
            if (Number.isNaN(value.getTime())) throw new Error('expected a date')
            return value
        }
        case 'bytes':
            return hexToBytes(trimmed)
        case 'literal':
            return target.value
        default: {
            if (literalOptions(target)) {
                // A select over literals: the text is the chosen value, typed as the literal was.
                const match = literalOptions(target)!.find((option) => String(option) === trimmed)
                if (match !== undefined) return match
            }
            if (trimmed === '') return undefined
            let parsed
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                throw new Error('expected JSON')
            }
            return coerce(parsed, requiredPart(type), types)
        }
    }
}

/** A starting value that is valid more often than an empty box would be. */
export const initialText = (type: TypeNode | undefined, types: ServerDescription['types']): string => {
    const target = resolve(requiredPart(type), types)
    const options = literalOptions(target)
    if (options) return String(options[0])
    switch (target?.kind) {
        case 'number':
            return String(target.min ?? 0)
        case 'boolean':
            return 'false'
        case 'date':
            return new Date().toISOString().slice(0, 16)
        case 'array':
            return '[]'
        case 'tuple':
        case 'object':
            return JSON.stringify(sample(target, types), null, 2)
        default:
            return ''
    }
}

export const ArgumentField = ({
    name,
    type,
    types,
    state,
    onChange
}: {
    name: string
    type: TypeNode | undefined
    types: ServerDescription['types']
    state: FieldState
    onChange: (next: FieldState) => void
}) => {
    const optional = isOptional(type)
    const target = resolve(requiredPart(type), types)
    const options = literalOptions(target)
    const set = (text: string) => onChange({ ...state, text })
    const disabled = optional && !state.include

    const widget = () => {
        if (options)
            return (
                <select className="control" value={state.text} disabled={disabled} onChange={(e) => set(e.target.value)}>
                    {options.map((option) => (
                        <option key={String(option)} value={String(option)}>
                            {String(option)}
                        </option>
                    ))}
                </select>
            )
        switch (target?.kind) {
            case 'boolean':
                return (
                    <label className="checkbox">
                        <input type="checkbox" checked={state.text === 'true'} disabled={disabled} onChange={(e) => set(String(e.target.checked))} />
                        <span>{state.text === 'true' ? 'true' : 'false'}</span>
                    </label>
                )
            case 'number':
                return (
                    <input
                        className="control"
                        type="number"
                        value={state.text}
                        disabled={disabled}
                        min={target.min}
                        max={target.max}
                        step={target.integer ? 1 : 'any'}
                        onChange={(e) => set(e.target.value)}
                    />
                )
            case 'date':
                return <input className="control" type="datetime-local" value={state.text} disabled={disabled} onChange={(e) => set(e.target.value)} />
            case 'string':
                return <input className="control" type="text" value={state.text} disabled={disabled} onChange={(e) => set(e.target.value)} />
            case 'bytes':
                return (
                    <input className="control mono" type="text" placeholder="hex, e.g. 01 ff 2a" value={state.text} disabled={disabled} onChange={(e) => set(e.target.value)} />
                )
            default:
                return (
                    <textarea
                        className="control mono"
                        rows={Math.min(12, Math.max(2, state.text.split('\n').length))}
                        placeholder="JSON"
                        value={state.text}
                        disabled={disabled}
                        onChange={(e) => set(e.target.value)}
                    />
                )
        }
    }

    return (
        <div className={`field${disabled ? ' off' : ''}`}>
            <div className="field-label">
                {optional && (
                    <input
                        type="checkbox"
                        className="include"
                        checked={state.include}
                        title="send this argument"
                        onChange={(e) => onChange({ ...state, include: e.target.checked })}
                    />
                )}
                <span className="name">
                    {name}
                    {optional ? '?' : ''}
                </span>
                {/* The named type, not what it resolves to: `Limits` is the useful label. */}
                <span className="type">{typeText(requiredPart(type))}</span>
            </div>
            {widget()}
        </div>
    )
}
