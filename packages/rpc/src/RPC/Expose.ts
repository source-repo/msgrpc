import type { RpcCallContext } from './Auth.js'
import type { RpcMethodSemantics } from './Messages.js'

/**
 * How calls into one exposed instance may overlap.
 *
 * When nothing is declared, the default is graded by what each method says it does. A `query` runs
 * as it arrives, and a method declaring `idempotent-command` or `non-repeatable-command` semantics
 * is serialised per instance - command state is exactly what interleaving corrupts, where
 * `setMode('manual'); start(); setSetpoint(80)` from one caller lands inside `stop();
 * setMode('automatic')` from another and leaves a machine in a combination neither asked for, and
 * the contract already names which methods command. A method that declares nothing keeps the old
 * behaviour and runs in parallel: guessing that an unmarked method is safe to serialise would be
 * the same mistake as guessing it is safe to repeat.
 *
 * `parallel` forces every call to run as it arrives, declared commands included - the opt-out for
 * a re-entrant design. `serial` runs one call at a time per exposed instance, whatever the methods
 * declare. A function instead runs one call at a time per key it returns, which is how a server
 * fronting many devices keeps each device's commands in order without serialising the whole server
 * behind the slowest one.
 *
 * **A serialised method must not call back into its own queue over RPC.** The second call waits
 * behind the first, which is waiting for it. The deadline being read after the queue wait means
 * the pair unwinds as a caller Timeout and an expired refusal rather than hanging forever - loud,
 * but still wrong. A design that re-enters declares `execution: 'parallel'` and does its own
 * coordination.
 */
export type RpcExecution = 'parallel' | 'serial' | ((context: RpcCallContext) => string)

/**
 * Marking which methods of a class may be called remotely.
 *
 * exposeClassInstance walks the prototype chain and publishes every function it finds, so a helper
 * a class never meant to offer becomes callable by anyone who can reach the transport. Marking the
 * intended methods turns that into an allow-list.
 *
 * A class with no marks keeps the old behaviour, so the plain "just expose the class" style still
 * works. Set requireExplicitExposure on RpcServer to make the marks compulsory instead.
 */

/** Marked method names per constructor. Subclasses accumulate their own plus the ones they inherit. */
const marked = new WeakMap<object, Set<string>>()
/** Declared semantics per constructor and method name, for the methods that declare any. */
const semantics = new WeakMap<object, Map<string, RpcMethodSemantics>>()
/** Methods declared conflatable per constructor, for the queues to read. */
const conflated = new WeakMap<object, Set<string>>()
/** Methods that require the caller to hold the component's authority, per constructor. */
const authority = new WeakMap<object, Set<string>>()

const markOn = (constructor: object, method: string, declared?: RpcMethodSemantics, conflate?: boolean, requiresAuthority?: boolean) => {
    let names = marked.get(constructor)
    if (!names) marked.set(constructor, (names = new Set()))
    names.add(method)
    if (conflate) {
        let conflatable = conflated.get(constructor)
        if (!conflatable) conflated.set(constructor, (conflatable = new Set()))
        conflatable.add(method)
    }
    if (requiresAuthority) {
        let guarded = authority.get(constructor)
        if (!guarded) authority.set(constructor, (guarded = new Set()))
        guarded.add(method)
    }
    if (!declared) return
    let declarations = semantics.get(constructor)
    if (!declarations) semantics.set(constructor, (declarations = new Map()))
    declarations.set(method, declared)
}

export interface RpcMethodOptions {
    /**
     * What this method does to the world: `query`, `idempotent-command` or
     * `non-repeatable-command`. Read by a caller deciding whether an uncertain answer may be
     * retried, and by the server deciding whether to consult a durable idempotency store.
     */
    semantics?: RpcMethodSemantics
    /**
     * Latest wins: while a call to this method waits in its queue, a newer call to the same method
     * in the same queue replaces it, and the replaced caller is answered `Superseded` immediately.
     * For setpoint-shaped commands, where only the newest value matters and executing a backlog of
     * stale ones serves nobody.
     *
     * Only an `idempotent-command` may conflate - enforced when the instance is exposed. Dropping
     * one of two queued non-repeatable commands would silently skip work a caller was promised,
     * and a query has no queue to conflate in.
     */
    conflate?: boolean
    /**
     * Only the peer currently holding this component's authority may call it - the plant's
     * local/remote switch, the HMI-in-control, the teach pendant that owns the arm. Authority is
     * acquired with `$acquire`, visible in the component snapshot as `authority`, and expires.
     *
     * Only declared methods are gated, which is the safety rule stated positively: an E-stop is
     * written without this flag and is therefore never behind a held lease. Declaring it on a
     * class that is not an RpcComponent is refused at expose time - authority is held on the
     * component, so anywhere else there is nothing to check against.
     */
    requiresAuthority?: boolean
}

type RpcMethodDecorator<This, Args extends unknown[], Return> = (
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
) => void

const mark = <This, Args extends unknown[], Return>(
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
    options: RpcMethodOptions
) => {
    if (context.static) throw new Error('@rpc: static methods cannot be exposed')
    if (context.private) throw new Error('@rpc: private methods cannot be exposed')
    context.addInitializer(function (this: This) {
        markOn((this as object).constructor, String(context.name), options.semantics, options.conflate, options.requiresAuthority)
    })
}

/**
 * Marks a method as remotely callable, and optionally says what it does to the world.
 *
 * ```typescript
 * class Plant {
 *     @rpc async readSetpoint() { ... }                                    // marked, nothing declared
 *     @rpc({ semantics: 'idempotent-command' }) async writeSetpoint(v: number) { ... }
 *     @rpc({ semantics: 'non-repeatable-command' }) async advanceBatch() { ... }
 *     private recompute() { ... }                                          // unmarked, so unreachable
 * }
 * ```
 *
 * Both spellings are the same decorator: bare `@rpc` where there is nothing to say, and `@rpc({…})`
 * where there is. A standard ECMAScript decorator either way, so no experimentalDecorators is
 * needed, and the mark is recorded per instance at construction, which is when the RPC layer needs
 * it.
 */
export function rpc<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
): void
export function rpc<This, Args extends unknown[], Return>(options: RpcMethodOptions): RpcMethodDecorator<This, Args, Return>
export function rpc<This, Args extends unknown[], Return>(
    targetOrOptions: ((this: This, ...args: Args) => Return) | RpcMethodOptions,
    context?: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
): void | RpcMethodDecorator<This, Args, Return> {
    // Applied directly, the runtime hands a decorator its target and context; called as a factory,
    // the one argument is the options object. A function in the first position is the giveaway.
    if (typeof targetOrOptions === 'function' && context) return mark(context, {})
    const options = targetOrOptions as RpcMethodOptions
    return (_target, methodContext) => mark(methodContext, options)
}

/**
 * Marks methods without decorators, for JavaScript callers or code that prefers not to use them.
 * Names that are not functions on the prototype are rejected, since a typo would silently expose
 * nothing.
 */
export const exposeMethods = <T>(constructor: new (...args: never[]) => T, methods: string[]) => {
    for (const method of methods) {
        if (typeof (constructor.prototype as Record<string, unknown>)[method] !== 'function')
            throw new Error(`exposeMethods: ${constructor.name}.${method} is not a method`)
        markOn(constructor, method)
    }
    return constructor
}

/** Namespace declared by a class, so the name is written once and read by both ends. */
const namespaces = new WeakMap<object, DeclaredNamespace>()

export interface DeclaredNamespace {
    name: string
    version?: string
    execution?: RpcExecution
    /** How many calls may wait in one of this instance's queues before arrivals are refused Busy. */
    mailbox?: number
}

/**
 * Declares the name a class is exposed under, and optionally the version of its contract and how
 * its calls may overlap.
 *
 * The exposure name only existed at the call site - `exposeClassInstance(instance, 'plant')` - so
 * nothing reading the source could tell which namespace a class belongs to. Declaring it here lets
 * the extraction CLI key a schema correctly, and lets exposeClassInstance take the name as read.
 *
 * ```typescript
 * @rpcNamespace('plant', { version: '3', execution: 'serial' })
 * class Plant { @rpc async writeSetpoint(value: number) { ... } }
 * ```
 */
export const rpcNamespace =
    (name: string, options: { version?: string; execution?: RpcExecution; mailbox?: number } = {}) =>
    <T extends abstract new (...args: never[]) => unknown>(target: T, _context: ClassDecoratorContext) => {
        namespaces.set(target, { name, version: options.version, execution: options.execution, mailbox: options.mailbox })
        return target
    }

/** The namespace an instance's class declares, walking up so a subclass inherits it. */
export const declaredNamespace = (instance: object) => {
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        const declared = namespaces.get(ctor)
        if (declared) return declared
    }
    return undefined
}

/** The marked method names for an instance, or undefined when the class marks nothing. */
export const markedMethods = (instance: object): Set<string> | undefined => {
    const names = new Set<string>()
    // Walk the chain so a subclass inherits its parent's marks.
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const name of marked.get(ctor) ?? []) names.add(name)
    }
    return names.size ? names : undefined
}

/**
 * The semantics an instance's methods declare, walking the chain so a subclass inherits them.
 *
 * A subclass that redeclares wins, which is why the nearest constructor is consulted first: an
 * override that turns a query into a command has to be able to say so.
 */
export const declaredSemantics = (instance: object): Map<string, RpcMethodSemantics> => {
    const declarations = new Map<string, RpcMethodSemantics>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const [method, declared] of semantics.get(ctor) ?? []) if (!declarations.has(method)) declarations.set(method, declared)
    }
    return declarations
}

/** The methods an instance declares conflatable, walking the chain so a subclass inherits them. */
export const declaredConflation = (instance: object): Set<string> => {
    const methods = new Set<string>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const method of conflated.get(ctor) ?? []) methods.add(method)
    }
    return methods
}

/** The methods an instance declares as authority-gated, walking the chain so a subclass inherits them. */
export const declaredAuthority = (instance: object): Set<string> => {
    const methods = new Set<string>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const method of authority.get(ctor) ?? []) methods.add(method)
    }
    return methods
}
