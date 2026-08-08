import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { typeText, type TypeNode } from './types'

/**
 * A value drawn against the interface that was published with it, one row at a time.
 *
 * A component's `props` and `state` are part of its contract exactly as its methods are: `extract`
 * reads the interfaces with ts-morph and the schema carries them, so describe() hands this console
 * a type it has never seen and it can draw the whole tree - nested objects, records keyed by tag,
 * unions of literals - without knowing anything about ovens.
 *
 * Which is the difference worth having. Drawing from the *value* alone works until a field is null,
 * or absent, or an empty record, at which point a value-driven panel shows nothing and cannot say
 * whether that is a missing value or a missing field. Drawing from the type means the row is there
 * either way, labelled, with the shape it is supposed to have. The value-driven path below is only
 * the fallback for data that has no published type - a context value, which is `unknown` by design.
 *
 * **Every leaf subscribes to its own value, and nothing subscribes to the snapshot.** A component
 * publishes its state whole, so a screen of three hundred tags with one of them spinning would
 * otherwise re-render three hundred rows to move one number - which is the shape a real plant
 * screen has. Instead each leaf reads its own path and `useSyncExternalStore` compares what comes
 * back: leaf values are primitives, so an unchanged one bails out before React does any work. The
 * spinning tag re-renders; its neighbours run one property read each and render nothing.
 *
 * Branches subscribe to as little as they need to know their own shape - which for a typed object
 * is nothing at all, since the fields come from the contract, and for a record or an array is the
 * key list flattened to a string, so it bails out unless a key appears or disappears.
 *
 * A row offers to *call a method*, never to write a value - and the method it names is a suggestion
 * from a naming rule, shown in full before it is sent, not a claim that the field is writable. See
 * notes/setting-state-from-a-console.md for the declared marker that should replace the rule.
 */

/**
 * Where a row gets its value. Deliberately not "the value": what is passed down the tree is the
 * means to read one path, so a parent never has to hold - or re-render for - its children's data.
 */
export interface ValueSource {
    subscribe(listener: () => void): () => void
    read(path: string[]): unknown
}

/** How a leaf may be changed, when it may be. Supplied by whoever knows the methods. */
export interface EditAffordance {
    /** The method that sets this path, or undefined when the contract offers none. */
    setterFor(path: string[]): { method: string; call(value: unknown): Promise<void> } | undefined
    /** Path currently in flight, so its row can say so. */
    pending?: string
    /** Failure from the last attempt, keyed by path. */
    failed?: { path: string; message: string }
}

const readAt = (root: unknown, path: string[]): unknown => {
    let at = root
    for (const step of path) {
        if (at === null || typeof at !== 'object') return undefined
        at = (at as { [key: string]: unknown })[step]
    }
    return at
}

/** Module-level, so a static source's subscribe keeps one identity and never resubscribes. */
const NEVER = () => () => undefined

/** For data that is not live: a context value, which arrives whole and has no store behind it. */
export const staticSource = (value: unknown): ValueSource => ({ subscribe: NEVER, read: (path) => readAt(value, path) })

/**
 * A live store, rooted at one of its fields. Build it once per store - a new source object
 * resubscribes every leaf, which is the one way to make this arrangement cost more than the
 * arrangement it replaces.
 */
export const storeSource = (store: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }, base: string[]): ValueSource => ({
    subscribe: (listener) => store.subscribe(listener),
    read: (path) => readAt(store.getSnapshot(), [...base, ...path])
})

/** One path, one subscription, and a bailout whenever the primitive that comes back is the same. */
const useValueAt = (source: ValueSource, path: string[]) => {
    const key = path.join('\u0001')
    // Keyed by the joined path rather than the array, which is rebuilt on every render and would
    // otherwise make a new read on every render.
    const read = useCallback(() => source.read(path), [source, key])
    return useSyncExternalStore(source.subscribe, read, read)
}

/**
 * The keys of a container, as a string so the comparison is a string comparison. A record whose
 * values all change keeps its key list, so a branch redraws only when a tag appears or goes.
 */
const useKeysAt = (source: ValueSource, path: string[]) => {
    const key = path.join('\u0001')
    // Keyed by the joined path, as above.
    const read = useCallback(() => {
        const at = source.read(path)
        return at !== null && typeof at === 'object' ? Object.keys(at).join('\u0001') : ''
    }, [source, key])
    const joined = useSyncExternalStore(source.subscribe, read, read)
    return useMemo(() => (joined === '' ? [] : joined.split('\u0001')), [joined])
}

const resolve = (type: TypeNode | undefined, types: { [name: string]: TypeNode } | undefined): TypeNode | undefined =>
    type?.kind === 'ref' ? resolve(types?.[type.name], types) : type

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A union every option of which is a literal is a closed set of choices, and renders as one. */
const literalOptions = (type: TypeNode | undefined) =>
    type?.kind === 'union' && type.options.every((option) => option.kind === 'literal')
        ? type.options.map((option) => (option as { kind: 'literal'; value: string | number | boolean | null }).value)
        : undefined

/**
 * The duck-typed projection of a process value: an object carrying `value` plus any of `quality`,
 * `unit`, `forced`. The domain classes live in sector contract packages the console has no
 * compile-time sight of, so the shape is recognized rather than imported - from the published type
 * where there is one, and from the value itself where there is not.
 */
const isProcessValueType = (type: TypeNode | undefined) =>
    type?.kind === 'object' && 'value' in type.fields && ('quality' in type.fields || 'unit' in type.fields || 'forced' in type.fields)

const isProcessValue = (value: unknown) => isRecord(value) && 'value' in value && ('quality' in value || 'unit' in value || 'forced' in value)

const plain = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined'))

const Editor = ({
    value,
    type,
    setter,
    busy,
    onDone
}: {
    value: unknown
    type: TypeNode | undefined
    setter: { method: string; call(value: unknown): Promise<void> }
    busy: boolean
    onDone: () => void
}) => {
    const [draft, setDraft] = useState(() => (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')))
    const options = literalOptions(type)

    const commit = async (raw: unknown) => {
        await setter.call(raw)
        onDone()
    }

    if (options) {
        return (
            <select
                className="value-edit"
                autoFocus
                defaultValue={String(value)}
                disabled={busy}
                onChange={(event) => void commit(options.find((option) => String(option) === event.target.value) ?? event.target.value)}
                onBlur={onDone}
            >
                {options.map((option) => (
                    <option key={String(option)} value={String(option)}>
                        {String(option)}
                    </option>
                ))}
            </select>
        )
    }

    if (type?.kind === 'boolean') {
        return <input className="value-edit" type="checkbox" autoFocus defaultChecked={value === true} disabled={busy} onChange={(event) => void commit(event.target.checked)} />
    }

    const numeric = type?.kind === 'number'
    return (
        <form
            className="value-edit-form"
            onSubmit={(event) => {
                event.preventDefault()
                // Parsed to the declared type, so the call carries a number where the contract
                // says number - the server would refuse the string, correctly and unhelpfully.
                if (numeric) {
                    const parsed = Number(draft)
                    if (Number.isNaN(parsed)) return
                    void commit(parsed)
                    return
                }
                if (type?.kind === 'string' || type === undefined) void commit(draft)
                else
                    try {
                        void commit(JSON.parse(draft))
                    } catch {
                        void commit(draft)
                    }
            }}
        >
            <input
                className="value-edit"
                autoFocus
                value={draft}
                disabled={busy}
                type={numeric ? 'number' : 'text'}
                {...(numeric && type.min !== undefined ? { min: type.min } : {})}
                {...(numeric && type.max !== undefined ? { max: type.max } : {})}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') onDone()
                }}
            />
            <button className="toggle" type="submit" disabled={busy} title={`${setter.method}(${draft || '…'})`}>
                {busy ? '…' : `send ${setter.method}(${draft || '…'})`}
            </button>
        </form>
    )
}

const Row = ({
    name,
    value,
    type,
    path,
    edit,
    unit,
    quality,
    forced
}: {
    name: string
    value: unknown
    type: TypeNode | undefined
    path: string[]
    edit?: EditAffordance
    unit?: unknown
    quality?: unknown
    forced?: boolean
}) => {
    const [editing, setEditing] = useState(false)
    const key = path.join('.')
    const setter = edit?.setterFor(path)
    const busy = edit?.pending === key
    const failure = edit?.failed?.path === key ? edit.failed.message : undefined

    return (
        <div className="value-row">
            <span className="value-name mono" title={type ? typeText(type) : undefined}>
                {name}
            </span>
            {editing && setter ? (
                <Editor value={value} type={type} setter={setter} busy={busy} onDone={() => setEditing(false)} />
            ) : (
                <>
                    <span className="value mono">
                        {plain(value)}
                        {typeof unit === 'string' && <span className="unit"> {unit}</span>}
                    </span>
                    {/* Forced first and always: a forced value is right by decree, and the person at
                        this console is exactly who must not mistake it for a measurement. */}
                    {forced && <span className="quality forced">forced</span>}
                    {typeof quality === 'string' && <span className={`quality q-${quality}`}>{quality}</span>}
                    {/* Named, because what happens is a call and not an assignment. Which method it
                        is comes from the contract - some method declared it sets this path - and
                        the operator commits that call rather than a value. */}
                    {setter && (
                        <button className="toggle edit" onClick={() => setEditing(true)} title={`proposes a call to ${setter.method}()`}>
                            call {setter.method}
                        </button>
                    )}
                </>
            )}
            {failure && <span className="component-error">{failure}</span>}
        </div>
    )
}

const Leaf = ({ source, name, path, type, edit }: { source: ValueSource; name: string; path: string[]; type: TypeNode | undefined; edit?: EditAffordance }) => (
    <Row name={name} value={useValueAt(source, path)} type={type} path={path} edit={edit} />
)

/**
 * Three fields to a schema, one thing to a reader - and three subscriptions, so a tag whose
 * quality flickers does not redraw the ones beside it either.
 */
const ProcessLeaf = ({ source, name, path, type }: { source: ValueSource; name: string; path: string[]; type: TypeNode | undefined }) => (
    <Row
        name={name}
        value={useValueAt(source, [...path, 'value'])}
        unit={useValueAt(source, [...path, 'unit'])}
        quality={useValueAt(source, [...path, 'quality'])}
        forced={useValueAt(source, [...path, 'forced']) === true}
        type={type}
        path={path}
    />
)

/** A container whose members come from the value: a record's tags, an array's indices. */
const KeyedBranch = (props: {
    source: ValueSource
    path: string[]
    childType?: TypeNode
    types?: { [name: string]: TypeNode }
    edit?: EditAffordance
    depth: number
    name?: string
}) => {
    const keys = useKeysAt(props.source, props.path)
    return <Members {...props} members={keys.map((key) => ({ key, childType: props.childType }))} />
}

const Members = ({
    source,
    path,
    types,
    edit,
    depth,
    name,
    members
}: {
    source: ValueSource
    path: string[]
    types?: { [name: string]: TypeNode }
    edit?: EditAffordance
    depth: number
    name?: string
    members: { key: string; childType?: TypeNode }[]
}) => {
    const body = (
        <div className={depth === 0 ? undefined : 'value-branch'}>
            {members.map(({ key, childType }) => (
                <ValueTree key={key} name={key} source={source} type={childType} types={types} path={[...path, key]} edit={edit} depth={depth + 1} />
            ))}
            {members.length === 0 && <p className="muted">empty</p>}
        </div>
    )
    // The root is props or state and is already titled; anything deeper keeps its field name
    // above the indent, because the shape of the state is part of what the panel is showing.
    if (depth === 0) return body
    return (
        <div className="value-node">
            <span className="value-name mono branch">{name}</span>
            {body}
        </div>
    )
}

/** Reads nothing itself: it decides what a node is from the type, and delegates the value to the row. */
export const ValueTree = ({
    source,
    type,
    types,
    name,
    path = [],
    edit,
    depth = 0
}: {
    source: ValueSource
    /** The published type for this value. Absent means draw what the value happens to be. */
    type?: TypeNode
    types?: { [name: string]: TypeNode }
    name?: string
    path?: string[]
    edit?: EditAffordance
    depth?: number
}) => {
    const resolved = resolve(type, types)

    if (isProcessValueType(resolved)) return <ProcessLeaf source={source} name={name ?? ''} path={path} type={resolved} />

    // Fields from the contract: the shape is known without reading anything, so this branch never
    // re-renders at all - only the leaves under it do.
    if (resolved?.kind === 'object')
        return (
            <Members
                source={source}
                path={path}
                types={types}
                edit={edit}
                depth={depth}
                name={name}
                members={Object.entries(resolved.fields).map(([key, field]) => ({ key, childType: field.type }))}
            />
        )
    if (resolved?.kind === 'tuple')
        return <Members source={source} path={path} types={types} edit={edit} depth={depth} name={name} members={resolved.items.map((item, index) => ({ key: String(index), childType: item }))} />

    // Keys from the value, so this branch subscribes to the key list and nothing more.
    if (resolved?.kind === 'record') return <KeyedBranch source={source} path={path} childType={resolved.values} types={types} edit={edit} depth={depth} name={name} />
    if (resolved?.kind === 'array') return <KeyedBranch source={source} path={path} childType={resolved.items} types={types} edit={edit} depth={depth} name={name} />

    if (resolved === undefined) return <Untyped source={source} name={name} path={path} edit={edit} depth={depth} types={types} />

    return <Leaf source={source} name={name ?? ''} path={path} type={resolved} edit={edit} />
}

/** No published type - a context value. The value decides, which is the fallback, not the norm. */
const Untyped = ({
    source,
    name,
    path,
    edit,
    depth,
    types
}: {
    source: ValueSource
    name?: string
    path: string[]
    edit?: EditAffordance
    depth: number
    types?: { [name: string]: TypeNode }
}) => {
    const value = useValueAt(source, path)
    if (isProcessValue(value)) return <ProcessLeaf source={source} name={name ?? ''} path={path} type={undefined} />
    if (isRecord(value) || Array.isArray(value)) return <KeyedBranch source={source} path={path} types={types} edit={edit} depth={depth} name={name} />
    return <Row name={name ?? ''} value={value} type={undefined} path={path} edit={edit} />
}
