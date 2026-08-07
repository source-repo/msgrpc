import test from 'ava'
import type { RpcInvocationHandle, WithoutInvocation } from './RPC/Invocation.js'

/**
 * The caller-visible signature, checked at compile time.
 *
 * These assertions do nothing at runtime and are the point of the file anyway: a regression here
 * does not throw, it publishes a handle in somebody's proxy signature - or, worse in the other
 * direction, quietly shortens an honest method whose last parameter merely accepts one. Neither
 * shows up as a failing call, so neither would be caught by any test that runs.
 */

/** Mutual assignability, which is stricter than `extends` and is what "the same type" has to mean. */
type Same<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

// The handle goes, and the parameters before it are untouched.
type _Required = Assert<Same<WithoutInvocation<(a: string, i: RpcInvocationHandle) => Promise<void>>, (a: string) => Promise<void>>>
type _Only = Assert<Same<WithoutInvocation<(i: RpcInvocationHandle) => Promise<void>>, () => Promise<void>>>

/**
 * Declared optional, which is the only spelling available after an optional parameter: TypeScript
 * refuses a required parameter following one. The parameter before it has to stay optional, since
 * narrowing it is a breaking change to every caller that sent nothing.
 */
type _Optional = Assert<
    Same<WithoutInvocation<(f?: { x: number }, i?: RpcInvocationHandle) => Promise<string>>, (f?: { x: number } | undefined) => Promise<string>>
>

/**
 * The trap the bidirectional check exists for. `unknown` accepts a handle and is not one, so
 * stripping it would silently shorten an honest signature - and `NonNullable<unknown>` is `{}`,
 * which keeps that true now that the optional form is admitted.
 */
type _Unknown = Assert<Same<WithoutInvocation<(a: string, u: unknown) => void>, (a: string, u: unknown) => void>>
type _OptionalUnknown = Assert<Same<WithoutInvocation<(a: string, u?: unknown) => void>, (a: string, u?: unknown) => void>>

/** An ordinary optional parameter is not a handle, whatever its position. */
type _OrdinaryOptional = Assert<Same<WithoutInvocation<(f?: { x: number }) => void>, (f?: { x: number }) => void>>
type _None = Assert<Same<WithoutInvocation<() => void>, () => void>>

test('the caller-visible signature is checked by the compiler, not at runtime', (t) => {
    // Reaching here means every assertion above compiled. `npm run typecheck` is where a break
    // would be reported; this exists so the file is run and cannot be quietly excluded.
    t.pass()
})
