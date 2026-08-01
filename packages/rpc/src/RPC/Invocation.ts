import type { RpcIdentity } from './Auth.js'

/**
 * The per-invocation handle, injected as a method's final parameter when it opts in with
 * `@rpc({ injectInvocation: true })`. Explicit rather than ambient by deliberate amendment: an
 * AsyncLocalStorage surface would work in Node and silently degrade in a page that hosts real
 * services, and the house style is explicit everywhere else - `$with`, declared semantics,
 * capture-by-listing.
 *
 * The parameter never exists for callers: the proxy type strips it from the visible signature and
 * the extractor omits it from the wire schema, so the remote contract is exactly the method
 * without it. What it exists for is the question a handler could not answer before: *who is
 * actually calling* - which is why `from`-style parameters were spoofable, and are now display
 * data at most.
 */

/** Brands the handle, so the proxy type can strip exactly this and never a coincidental object. */
export const rpcInvocationBrand: unique symbol = Symbol('@source-repo/rpc/invocation')

export interface RpcInvocationContext {
    /** This attempt's id - the same id an idempotency store keys redeliveries by. */
    readonly requestId: string
    /**
     * The peer the frame was routed from. Over an authenticating transport this is pinned - the
     * transport drops frames claiming any other source - so it is evidence there. Over a bare
     * relay or an un-ACLed broker it is as trustworthy as the link, which `identity` says.
     */
    readonly source: string
    /** Present when a transport vouched for the caller. Absent means `source` is a routed claim. */
    readonly identity?: RpcIdentity
    /** Milliseconds the caller said it would still wait, as received. */
    readonly ttl?: number
    /** The command identity the caller declared, when it declared one. */
    readonly idempotencyKey?: string
}

export interface RpcInvocationHandle {
    readonly [rpcInvocationBrand]: true
    readonly context: RpcInvocationContext
}

/**
 * Strips a trailing RpcInvocation from a method type - the caller-visible signature is the method
 * without it. The check is deliberately bidirectional: a trailing `unknown` accepts a
 * handle but is not one, and stripping it would silently shorten an honest signature.
 */
export type WithoutInvocation<F> = F extends (...args: [...infer Args, infer Last]) => infer Returns
    ? [Last] extends [RpcInvocationHandle]
        ? [RpcInvocationHandle] extends [Last]
            ? (...args: Args) => Returns
            : F
        : F
    : F

export type RemoteSurface<T> = { [K in keyof T]: WithoutInvocation<T[K]> }
