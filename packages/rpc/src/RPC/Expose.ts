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
 * What kind of power a method exercises, as opposed to whether it may be repeated.
 *
 * Deliberately orthogonal to `semantics`, because the two answer different questions and conflating
 * them was a real bug in an earlier design: `deployProgram(bundle)` and `setSetpoint(value)` can
 * both be honest `idempotent-command`s, and an AI principal permitted to adjust a setpoint must not
 * thereby be permitted to deploy a program. Semantics decide retry; effect decides which authority
 * a caller needs to have been granted.
 *
 * - `observe` reads and changes nothing a caller could notice.
 * - `operate` changes the world the way an operator does: setpoints, modes, acknowledgements.
 * - `program` changes what the system *is* - deploying, editing, starting or removing programs,
 *   contracts or logic. The distinction that matters most, because its blast radius is unbounded.
 * - `security-admin` changes who may do any of the above.
 *
 * Absent, a method's effect is inferred conservatively: a declared `query` observes, and anything
 * else operates. An unclassifiable method is never treated as harmless.
 */
export type RpcEffect = 'observe' | 'operate' | 'program' | 'security-admin'

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
/** Methods that receive an injected RpcInvocation as their final parameter, per constructor. */
const injected = new WeakMap<object, Set<string>>()
/** Declared effect per constructor and method name, for the methods that declare one. */
const effects = new WeakMap<object, Map<string, RpcEffect>>()
/** Declared state path per constructor and method name, for the methods that say what they set. */
const setters = new WeakMap<object, Map<string, string>>()

/**
 * What a `sets` declaration may say: `*`, or a dot path into the component's state.
 *
 * Segments are only required to be non-empty and free of dots and control characters, rather than
 * to be identifiers - a record's keys are data, so `tags.147` is a legitimate path into state and a
 * stricter rule would refuse it for looking unlike a variable name.
 */
const usableSetsPath = (path: string) =>
    // eslint-disable-next-line no-control-regex -- a path is a name, and names carry no control characters
    path === '*' || (path.length > 0 && !/[\u0000-\u001f\u007f]/.test(path) && path.split('.').every((segment) => segment.length > 0))

const markOn = (constructor: object, method: string, options: RpcMethodOptions) => {
    let names = marked.get(constructor)
    if (!names) marked.set(constructor, (names = new Set()))
    names.add(method)
    if (options.conflate) {
        let conflatable = conflated.get(constructor)
        if (!conflatable) conflated.set(constructor, (conflatable = new Set()))
        conflatable.add(method)
    }
    if (options.requiresAuthority) {
        let guarded = authority.get(constructor)
        if (!guarded) authority.set(constructor, (guarded = new Set()))
        guarded.add(method)
    }
    if (options.injectInvocation) {
        let handles = injected.get(constructor)
        if (!handles) injected.set(constructor, (handles = new Set()))
        handles.add(method)
    }
    if (options.effect) {
        let declaredEffects = effects.get(constructor)
        if (!declaredEffects) effects.set(constructor, (declaredEffects = new Map()))
        declaredEffects.set(method, options.effect)
    }
    if (options.sets !== undefined) {
        // Refused here rather than published: a path with an empty segment reaches nothing, and a
        // console drawing an editor from it would offer to write somewhere that does not exist.
        if (!usableSetsPath(options.sets)) throw new Error(`@rpc: '${options.sets}' is not a usable sets path - use '*', a field, or a dot path like 'zones.top.setpoint'`)
        let declaredSetters = setters.get(constructor)
        if (!declaredSetters) setters.set(constructor, (declaredSetters = new Map()))
        declaredSetters.set(method, options.sets)
    }
    if (!options.semantics) return
    let declarations = semantics.get(constructor)
    if (!declarations) semantics.set(constructor, (declarations = new Map()))
    declarations.set(method, options.semantics)
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
    /**
     * Inject an RpcInvocation as this method's final parameter - who is actually calling, vouched
     * or claimed, with the request's id, ttl and idempotency key. The parameter never exists for
     * callers: the proxy type strips it and the extractor omits it from the wire schema. This is
     * how a handler reads the authenticated caller instead of trusting a `from`-style argument.
     */
    injectInvocation?: boolean
    /**
     * What kind of power this method exercises - `observe`, `operate`, `program` or
     * `security-admin`. Orthogonal to `semantics`: see RpcEffect.
     *
     * Declared where it is not obvious, and it is not obvious more often than it looks. A method
     * that deploys a program is `program` however idempotent it is, and leaving that undeclared
     * means it is read as `operate` - safe for a human caller, and the difference between two
     * different grants for an AI one.
     */
    effect?: RpcEffect
    /**
     * Which path in this component's `state` calling this method sets - `'setpoint'`, or
     * `'zones.top.setpoint'` for a nested one, or `'*'` for a method that takes a path and sets
     * whatever it names.
     *
     * Declared for the same reason `semantics` and `effect` are, and against the same temptation.
     * A console can guess which method sets a field by looking for a one-argument `set<Field>`, and
     * that guess is right almost always - which is the problem. `setMode` might not assign
     * `state.mode` at all; it might begin a mode transition with a purge cycle and an interlock
     * behind it. `setPressure` might command a setpoint while `state.pressure` is the measurement
     * beside it, so an editor drawn on the measured value writes somewhere the operator did not
     * mean. When a name-based guess is wrong it is wrong silently, in the direction of commanding a
     * plant, and nothing on the row shows it. So the author who writes the method says what it
     * sets, once, next to the semantics they were already declaring.
     *
     * It does not make the field writable and nothing here writes anything: the method body stays
     * the author's, which is what keeps the clamping, the interlock and the refusal-while-the-
     * door-is-open that a per-field setter exists to apply. `'*'` says a method *can* set paths,
     * never that every path is open - which paths it accepts is decided inside it.
     *
     * Only meaningful on an `RpcComponent`, since `state` is what a path names, and refused
     * elsewhere at expose time rather than published as a claim about a state that does not exist.
     */
    sets?: string
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
        markOn((this as object).constructor, String(context.name), options)
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
 * Marks methods without decorators, and can say everything `@rpc` can.
 *
 * This exists for the population that cannot use decorators at all: V8 does not ship them, so a
 * script run under Node's type stripping - which is how the scripts directory runs - dies on the
 * `@` with a SyntaxError. The array form marks with nothing declared, as it always has; the object
 * form carries the same options the decorator takes, so semantics, conflation, authority and the
 * invocation handle are not privileges of code with a compile step.
 *
 * ```typescript
 * exposeMethods(ChatService, ['say', 'who'])                          // marked, nothing declared
 * exposeMethods(ChatService, {
 *     say: { injectInvocation: true },                                // = @rpc({ injectInvocation: true })
 *     who: {}                                                         // = bare @rpc
 * })
 * ```
 *
 * Names that are not functions on the prototype are rejected, since a typo would silently expose
 * nothing. Note that `extract` reads decorators from source, not these runtime marks - a class
 * marked only this way contributes no semantics to an extracted contract, which is the right
 * bargain for scripts, whose whole point is running without a build step.
 */
export function exposeMethods<T>(constructor: new (...args: never[]) => T, methods: string[]): new (...args: never[]) => T
export function exposeMethods<T>(constructor: new (...args: never[]) => T, methods: { [method: string]: RpcMethodOptions }): new (...args: never[]) => T
export function exposeMethods<T>(constructor: new (...args: never[]) => T, methods: string[] | { [method: string]: RpcMethodOptions }) {
    const entries: [string, RpcMethodOptions][] = Array.isArray(methods) ? methods.map((method) => [method, {}]) : Object.entries(methods)
    for (const [method, options] of entries) {
        if (typeof (constructor.prototype as Record<string, unknown>)[method] !== 'function')
            throw new Error(`exposeMethods: ${constructor.name}.${method} is not a method`)
        markOn(constructor, method, options)
    }
    return constructor
}

/**
 * Declares a class's namespace without the @rpcNamespace decorator, for the same population
 * exposeMethods serves. The same declaration lands in the same place, so exposeClassInstance and
 * the extraction machinery read it identically - only the syntax differs.
 *
 * ```typescript
 * declareRpcNamespace(ChatService, 'chat', { version: '1.0.0' })
 * ```
 */
export const declareRpcNamespace = <T extends abstract new (...args: never[]) => unknown>(
    constructor: T,
    name: string,
    options: { version?: string; execution?: RpcExecution; mailbox?: number } = {}
) => {
    namespaces.set(constructor, { name, version: options.version, execution: options.execution, mailbox: options.mailbox })
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

/**
 * The effects an instance's methods declare, walking the chain so a subclass inherits them, with
 * the nearest constructor winning - an override that turns an operation into a programming action
 * has to be able to say so.
 */
export const declaredEffect = (instance: object): Map<string, RpcEffect> => {
    const declarations = new Map<string, RpcEffect>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const [method, effect] of effects.get(ctor) ?? []) if (!declarations.has(method)) declarations.set(method, effect)
    }
    return declarations
}

/**
 * What each of an instance's methods declares it sets, walking the chain so a subclass inherits
 * them, with the nearest constructor winning - an override that moves which field a method commands
 * has to be able to say so.
 */
export const declaredSets = (instance: object): Map<string, string> => {
    const declarations = new Map<string, string>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const [method, path] of setters.get(ctor) ?? []) if (!declarations.has(method)) declarations.set(method, path)
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

/** The methods an instance declares as invocation-injected, walking the chain like the others. */
export const declaredInjection = (instance: object): Set<string> => {
    const methods = new Set<string>()
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const method of injected.get(ctor) ?? []) methods.add(method)
    }
    return methods
}
