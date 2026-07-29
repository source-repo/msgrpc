/** The shapes the console receives from `msgrpc.describe()`, mirrored so the app stays self-contained. */

export type TypeNode =
    | { kind: 'any' }
    | { kind: 'null' }
    | { kind: 'boolean' }
    | { kind: 'number'; integer?: boolean; min?: number; max?: number }
    | { kind: 'string'; pattern?: string; minLength?: number; maxLength?: number }
    | { kind: 'bytes'; maxBytes?: number }
    | { kind: 'date' }
    | { kind: 'literal'; value: string | number | boolean | null }
    | { kind: 'array'; items: TypeNode; maxItems?: number }
    | { kind: 'tuple'; items: TypeNode[] }
    | { kind: 'object'; fields: { [name: string]: { type: TypeNode; optional?: boolean } }; additional?: boolean }
    | { kind: 'record'; values: TypeNode; keyPattern?: string; maxEntries?: number }
    | { kind: 'union'; options: TypeNode[] }
    | { kind: 'ref'; name: string }

export interface DescribedMethod {
    name: string
    params?: TypeNode[]
    paramNames?: string[]
    rest?: TypeNode
    returns?: TypeNode
}

export interface DescribedEvent {
    name: string
    params?: TypeNode[]
    subscribers: number
}

export interface DescribedNamespace {
    name: string
    version?: string
    className?: string
    created: boolean
    emitter: boolean
    methods: DescribedMethod[]
    events: DescribedEvent[]
}

export interface ServerDescription {
    name: string
    version?: string
    validating: boolean
    namespaces: DescribedNamespace[]
    types?: { [name: string]: TypeNode }
}

/**
 * The console's peer name is its name on the network, not a constant, so the page asks for it
 * before connecting. This is the one thing that cannot be an RPC call: you need a name to address.
 */
export const consoleIdentityPath = '/console.json'

export const fetchConsoleName = async () => {
    const response = await fetch(consoleIdentityPath)
    if (!response.ok) throw new Error(`the console did not say who it is (${response.status})`)
    return ((await response.json()) as { name: string }).name
}

/** What a tap asks to be shown. Mirrored from the CLI's bus.ts, like the rest of this file. */
export interface TapFilter {
    peer?: string
    namespace?: string
    kinds?: string[]
    payloads?: boolean
    ttl?: number
}

/** One frame the network carried between two peers. */
export interface TappedFrame {
    at: number
    source: string
    target: string
    kind: string
    namespace?: string
    method?: string
    event?: string
    id?: string
    ms?: number
    code?: string
    error?: string
    params?: unknown[]
    result?: unknown
    taps: string[]
}

/**
 * A frame a transport refused or could not deliver, a name two peers claimed, or a link that
 * failed. Mirrored from the CLI's console.ts, like the rest of this file.
 */
export interface NetworkProblem {
    at: number
    kind: string
    link: string
    peer?: string
    target?: string
    reason?: string
}

/** A peer arriving or leaving, with when and on which link. */
export interface PeerChange {
    peer: string
    state: string
    at: number
    link?: string
}

/** What a peer turned out to be, from a description the console had already made. */
export type PeerRole = 'broker' | 'console' | 'page' | 'device' | 'undescribed'

/** What the console's own service offers over msgrpc. */
export interface ConsoleService {
    peers(): Promise<{
        peers: string[]
        watching: string[]
        callTimeout: number
        links: { [peer: string]: string }
        /** What this console was started with, so the page can render a command line that runs. */
        network: { broker?: string; hub?: string; prefix?: string }
        /** Filled in as peers are described for other reasons, so it costs no extra traffic. */
        roles: { [peer: string]: PeerRole }
    }>
    /** Who has come and gone, newest first — including before this page was opened. */
    presence(): Promise<{ changes: PeerChange[] }>
    /** What has gone wrong on the links, newest first — including before this page was opened. */
    problems(): Promise<{ problems: NetworkProblem[] }>
    describe(peer: string): Promise<ServerDescription | { error: string; code?: string }>
    call(peer: string, namespace: string, method: string, args: unknown[]): Promise<{ result?: unknown; error?: string; code?: string; ms: number }>
    watch(peer: string, namespace: string, event: string): Promise<{ watching: boolean; already: boolean }>
    unwatch(peer: string, namespace: string, event: string): Promise<{ watching: boolean; already: boolean }>
    /**
     * Start watching traffic between other peers. The console decides where that is possible - a
     * broker's `bus` on socket.io, its own subscription on MQTT - and reports which it turned on.
     */
    tap(filter?: TapFilter): Promise<{ token: string; sources: string[] }>
    untap(token: string): Promise<{ tapping: boolean; already: boolean }>
    taps(): Promise<{ taps: { token: string; sources: string[] }[]; sources: string[] }>
}

export interface StreamedEvent {
    peer: string
    namespace: string
    event: string
    args: unknown[]
    at: number
}

/** Resolves a `ref` so widgets and labels do not have to care whether a type was named. */
export const resolve = (type: TypeNode | undefined, types: ServerDescription['types']): TypeNode | undefined =>
    type?.kind === 'ref' ? resolve(types?.[type.name], types) : type

/** How a type reads when written out, which is what a signature line should show. */
export const typeText = (type: TypeNode | undefined): string => {
    if (!type) return 'unknown'
    switch (type.kind) {
        case 'literal':
            return JSON.stringify(type.value)
        case 'array':
            return `${typeText(type.items)}[]`
        case 'tuple':
            return `[${type.items.map(typeText).join(', ')}]`
        case 'union':
            return type.options.map(typeText).join(' | ')
        case 'ref':
            return type.name
        case 'object':
            return `{ ${Object.entries(type.fields)
                .map(([name, field]) => `${name}${field.optional ? '?' : ''}: ${typeText(field.type)}`)
                .join(', ')} }`
        case 'record':
            return `{ [key: string]: ${typeText(type.values)} }`
        case 'number':
            return type.min !== undefined || type.max !== undefined ? `number(${type.min ?? ''}..${type.max ?? ''})` : 'number'
        default:
            return type.kind
    }
}

/** A parameter is optional when its type admits null, which is how the extractor writes `mode?`. */
export const isOptional = (type: TypeNode | undefined) =>
    type?.kind === 'any' || (type?.kind === 'union' && type.options.some((option) => option.kind === 'literal' && option.value === null))

/** The type to build a widget for, with the optional-ness stripped off. */
export const requiredPart = (type: TypeNode | undefined): TypeNode | undefined => {
    if (type?.kind !== 'union') return type
    const options = type.options.filter((option) => !(option.kind === 'literal' && option.value === null))
    return options.length === 1 ? options[0] : { ...type, options }
}
