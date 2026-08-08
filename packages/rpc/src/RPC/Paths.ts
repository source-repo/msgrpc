/**
 * Typed paths into a component's state, built by reading rather than by spelling.
 *
 * A generic setter takes a path, and a path written as a string is the one part of an otherwise
 * checked call that nothing checks: no completion, no rename safety, and no way for the compiler
 * to know that `zones.top.setpoint` wants a number. That is a poor trade in a library where the
 * class is the contract and everything else about the call is verified.
 *
 * ```typescript
 * const state = rpcRoot<OvenState>()                       // once, wherever the type is known
 *
 * await oven.set(rpcPath(state.zones.top.setpoint), 180)
 * const setpoint = await oven.get(rpcPath(state.zones.top.setpoint))   // typed number
 * ```
 *
 * The proxy records the properties that were read and hands back the path they spell, carrying the
 * type at the end of it. Completion works, a rename moves it, a misspelling does not compile, the
 * value written is checked against that type rather than against `unknown`, and the value read
 * back arrives as a `number` without a cast.
 *
 * The read direction is the one that matters on a slow link: a component whose whole snapshot
 * takes eighty seconds to arrive can answer one path in a tenth of one, and the caller still
 * writes it as though it were reading a field.
 *
 * What it deliberately does not do is perform the write. An assignment statement has nowhere to
 * put the facts a remote write produces - whether it was authorized, whether it arrived, whether
 * it ran - so the call stays a call and keeps its `await`. The proxy is used for the half it is
 * actually good at, which is recording what the caller meant; see
 * `notes/setting-state-from-a-console.md`.
 */

/** Carries the type at a path so it can be recovered by inference. Never read at runtime. */
declare const VALUE: unique symbol

/**
 * A path being built. Every property leads to another one, and the phantom member is what lets
 * `rpcPath` infer the type at the end - a mapped type alone is not inferrable, an intersection
 * member is. Recursion stops at non-objects, so a `number` in the middle does not expand into
 * `toFixed` and the rest of its prototype.
 *
 * The conditional is written `[T] extends [object]` so it does not distribute: a field typed
 * `'idle' | 'heating'` must arrive at the end of the path as that union and not as one arm of it,
 * or a setter would accept any word at all.
 */
export type RpcPathOf<T> = ([T] extends [object] ? { readonly [K in keyof T]-?: RpcPathOf<NonNullable<T[K]>> } : unknown) & {
    readonly [VALUE]?: T
}

/**
 * Just the phantom, which is what `rpcPath` infers against. Inferring against the whole of
 * `RpcPathOf<V>` puts an unresolved conditional in the way, and a field typed `'idle' | 'heating'`
 * comes back widened - accepting any word where the contract named two.
 */
export interface RpcPathNode<V> {
    readonly [VALUE]?: V
}

/** The type at the end of a path, for checking the value written there or typing the one read back. */
export type RpcPathValue<P> = P extends { readonly [VALUE]?: infer T } ? T : never

/**
 * The segments, carrying what is at the end of them.
 *
 * A real `string[]` at runtime and on the wire - the phantom exists only so a signature can say
 * `set(path: RpcTypedPath<V>, value: V)` and have the compiler check the value, or `get(path:
 * RpcTypedPath<V>): Promise<V>` and have it type the answer. A plain `string[]` still passes;
 * it just degrades to `unknown` at the end, which is what a hand-written path deserves.
 */
export type RpcTypedPath<V> = string[] & { readonly [VALUE]?: V }

const PATH = Symbol('source-rpc.path')

const pathProxy = (path: string[]): unknown =>
    new Proxy(
        {},
        {
            get(_target, property) {
                if (property === PATH) return path
                // A symbol is never a state field, and answering with a path would make an
                // accidental `await` or a console.log look like a property of the state.
                if (typeof property === 'symbol') return undefined
                return pathProxy([...path, property])
            }
        }
    )

/**
 * A root to spell paths from. The one place the state's type is named; everything after it infers.
 *
 * It exists because TypeScript will not infer one type argument while another is given, so a
 * `rpcPath<OvenState>((state) => state.zones.top.setpoint)` form cannot both take the state type
 * and work out the type at the end of the path. Naming the root once is the smaller price, and it
 * reads better at the call sites, which outnumber it.
 */
export const rpcRoot = <T>(): RpcPathOf<T> => pathProxy([]) as RpcPathOf<T>

/**
 * The segments a path spells, carrying what is at the end of them.
 *
 * ```typescript
 * const state = rpcRoot<OvenState>()
 * rpcPath(state.zones.top.setpoint)   // ['zones', 'top', 'setpoint'], typed number
 * ```
 */
export const rpcPath = <V>(node: RpcPathNode<V>): RpcTypedPath<V> => {
    const path = (node as { [PATH]?: string[] })?.[PATH]
    if (!path) throw new Error('rpcPath: expects a property of an rpcRoot, not a value of its own')
    return path as RpcTypedPath<V>
}

/**
 * The generic setter as a *caller* sees it: the path carries its own type, and the value is checked
 * against it.
 *
 * The method on the class cannot be written this way, and that is not an oversight. `extract`
 * describes a contract in a runtime type language, and `set<V>(path: RpcTypedPath<V>, value:
 * NoInfer<V>)` has nothing to describe - it refuses the signature loudly rather than publishing
 * `any`, which is the same refusal it makes for an unresolved generic component. So the served
 * method is concrete:
 *
 * ```typescript
 * @rpc({ semantics: 'idempotent-command', sets: '*' })
 * async set(path: string[], value: unknown) { … }
 * ```
 *
 * and a caller that wants the compile-time half asks for this interface instead, which is ordinary
 * use of `proxy<T>()` rather than anything new:
 *
 * ```typescript
 * const state = rpcRoot<FieldState>()
 * const writer = await client.proxy<RpcPathWriter>('field', 'bakery')
 *
 * await writer.set(rpcPath(state.tags['flue.temp'].value), 21.5)
 * await writer.set(rpcPath(state.tags['flue.temp'].quality), 'good')   // 'nearly' does not compile
 * ```
 *
 * `NoInfer` on the value is what makes that last line a check rather than the appearance of one:
 * without it the value is a second inference site, `V` widens to include whatever was passed, and
 * every call compiles. `Paths.test.ts` pins it with a `@ts-expect-error`.
 *
 * Losing the compile-time check costs less than it looks, because it is not the only one. The state
 * interface travels in the contract, so the type at a path is published - a console, the MCP
 * `set_state` tool, or the component itself can refuse a wrong value at the boundary from the
 * contract alone, and do. This buys the caller completion and rename safety on top of that.
 */
export interface RpcPathWriter {
    set<V>(path: RpcTypedPath<V>, value: NoInfer<V>): Promise<unknown>
}

/** One assignment a draft collected: where, and what to put there. */
export interface RpcStateWrite {
    path: string[]
    value: unknown
}

/**
 * A write-only view of state, for collecting several assignments into one call.
 *
 * `Draft` is what makes `d.zones.top.setpoint = 180` a checked expression rather than a string and
 * a cast. It is write-only in intent and cannot be made so in the type system, so the one rule is
 * that a draft is never read from - a read returns the path builder, not the value, and comparing
 * it to anything will quietly be false.
 */
export type RpcDraft<T> = {
    -readonly [K in keyof T]: T[K] extends object ? RpcDraft<T[K]> : T[K]
}

const draftProxy = (path: string[], writes: RpcStateWrite[]): unknown =>
    new Proxy(
        {},
        {
            get(_target, property) {
                if (typeof property === 'symbol') return undefined
                return draftProxy([...path, property], writes)
            },
            set(_target, property, value) {
                if (typeof property === 'symbol') return false
                writes.push({ path: [...path, property], value })
                return true
            }
        }
    )

/**
 * The assignments a function makes, in the order it made them, as one list to send in one call.
 *
 * ```typescript
 * await oven.apply(rpcWrites<OvenState>((state) => {
 *     state.zones.top.setpoint = 180
 *     state.mode = 'heating'
 * }))
 * ```
 *
 * Two fields, one command, one outcome - which is the thing a per-field setter cannot offer and
 * an assignment to a remote object cannot either. Nothing is sent here: this returns what to send,
 * and the sending stays a method call with somewhere to put a refusal.
 */
export const rpcWrites = <T>(collect: (state: RpcDraft<T>) => void): RpcStateWrite[] => {
    const writes: RpcStateWrite[] = []
    collect(draftProxy([], writes) as RpcDraft<T>)
    return writes
}
