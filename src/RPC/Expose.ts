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

const markOn = (constructor: object, method: string) => {
    let names = marked.get(constructor)
    if (!names) marked.set(constructor, (names = new Set()))
    names.add(method)
}

/**
 * Marks a method as remotely callable.
 *
 * ```typescript
 * class Plant {
 *     @rpc async writeSetpoint(value: number) { ... }
 *     private recompute() { ... }   // unmarked, so unreachable
 * }
 * ```
 *
 * A standard ECMAScript decorator, so no experimentalDecorators is needed. The mark is recorded
 * per instance at construction, which is when the RPC layer needs it.
 */
export const rpc = <This, Args extends unknown[], Return>(
    _target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
) => {
    if (context.static) throw new Error('@rpc: static methods cannot be exposed')
    if (context.private) throw new Error('@rpc: private methods cannot be exposed')
    context.addInitializer(function (this: This) {
        markOn((this as object).constructor, String(context.name))
    })
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

/** The marked method names for an instance, or undefined when the class marks nothing. */
export const markedMethods = (instance: object): Set<string> | undefined => {
    const names = new Set<string>()
    // Walk the chain so a subclass inherits its parent's marks.
    for (let ctor: object | null = instance.constructor; ctor; ctor = Object.getPrototypeOf(ctor)) {
        for (const name of marked.get(ctor) ?? []) names.add(name)
    }
    return names.size ? names : undefined
}
