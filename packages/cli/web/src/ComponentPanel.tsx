import { RefObject, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { rpcComponent, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcServer } from '@source-repo/rpc'
import { ValueTree, storeSource, type EditAffordance } from './ValueTree'
import type { DescribedComponent, DescribedMethod, TypeNode } from './types'

/**
 * An observable component, rendered from the library's own store and against its own contract.
 *
 * The page is a peer, so it observes the way any peer does: component() over its own link, the
 * shared channel, the epoch/revision acceptance rules - not a feed the console re-serves. What
 * this panel adds is only rendering: the channel status beside the values, last-known data kept
 * visible while stale - because "20 °C, stale since 14:03" is an answer and a blank is not - and
 * the tree drawn from the props and state interfaces the contract publishes.
 *
 * Editing is the same principle from the other side: a value is not written, a method is called.
 *
 * **Which method is read from the contract, never guessed from a name.** A method declaring
 * `@rpc({ sets: 'setpoint' })` is the only thing that puts an editor on `setpoint`. The panel used
 * to look for a one-argument `set<Field>` instead, which is right almost always - the residue being
 * methods like `setMode`, which may begin a transition with an interlock behind it rather than
 * assign `state.mode`, or `setPressure` beside a measured `state.pressure`. A guess that is wrong
 * is wrong silently and in the direction of commanding a plant, so the claim is now the author's:
 * a peer that declares nothing offers no editors at all.
 *
 * The row still proposes the *call* and shows it in full before it is sent - what the operator
 * commits is `setSetpoint(180)`, not "the setpoint" - because a declared path says which method
 * changes a value, not that the value is a writable field. See notes/setting-state-from-a-console.md.
 */

type Store = RpcComponentStore<RpcComponentData, RpcComponentData>

/** How to call whatever claims a path: the method, and whether the path travels as an argument. */
type Setter = { method: DescribedMethod; generic: boolean }

/**
 * The method that claims this path, when one does.
 *
 * A declaration and nothing else: `sets` is matched against the path the row draws, so a nested
 * `zones.top.setpoint` is reachable where the old naming rule could only ever see a top-level field.
 *
 * A per-field claim wins over a generic one where both exist, and it should: the specific method is
 * the one whose body was written for that value, with whatever clamp and interlock belong to it,
 * where the generic setter is the blunt instrument that happens to reach the same place.
 *
 * The parameter counts are what stop a row inventing arguments. A per-field setter takes exactly the
 * one value this row sends; a generic one takes the path and the value and nothing else. Anything
 * with a third parameter changes something the row cannot describe, and guessing it is how a console
 * writes something nobody asked for. A method with *no* described signature is not refused, though:
 * a peer serving no schema publishes its declarations and no parameter lists, and the declaration is
 * the claim - the count only refines it where the contract carries one.
 */
const takesArguments = (method: DescribedMethod, count: number) => method.params === undefined || method.params.length === count

const setterMethod = (path: string[], methods: DescribedMethod[]): Setter | undefined => {
    const wanted = path.join('.')
    const named = methods.find((method) => method.sets === wanted && takesArguments(method, 1))
    if (named) return { method: named, generic: false }
    // `sets: '*'` reaches this host only when it opted in - describe() withholds the claim
    // otherwise - so an editor drawn from one is an editor the next call will actually accept.
    const generic = methods.find((method) => method.sets === '*' && takesArguments(method, 2))
    return generic ? { method: generic, generic: true } : undefined
}

/**
 * One fact *about* the channel, never a value in it.
 *
 * Each of these is a primitive, so useSyncExternalStore compares it and bails out - which is what
 * keeps a snapshot that moved a temperature from re-rendering the panel, and therefore from
 * re-rendering the tree underneath it. Without this the arrangement below is pointless at the top:
 * one spinning tag would redraw every one of its siblings by way of their parent.
 */
const useChannelFact = <T,>(store: Store | null, select: (view: ReturnType<Store['getSnapshot']>) => T, absent: T): T =>
    useSyncExternalStore(
        useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => undefined), [store]),
        useCallback(() => (store ? select(store.getSnapshot()) : absent), [store, select, absent])
    )

/** Hoisted, so their identity is stable and the read is not rebuilt on every render. */
const statusOf = (view: ReturnType<Store['getSnapshot']>) => view.status
const hasDataOf = (view: ReturnType<Store['getSnapshot']>) => view.receivedAt > 0

/**
 * The one line that legitimately moves on every snapshot, so it moves on its own. Three words in
 * a span is a cheap thing to redraw at ten hertz; three hundred rows is not.
 */
const Revision = ({ store }: { store: Store }) => {
    const view = useSyncExternalStore(
        useCallback((listener: () => void) => store.subscribe(listener), [store]),
        useCallback(() => store.getSnapshot(), [store])
    )
    if (view.receivedAt === 0) return null
    return (
        <span className="muted">
            rev {view.revision} ·{' '}
            {view.status === 'stale' && view.staleSince
                ? `last known ${new Date(view.receivedAt).toLocaleTimeString()}, stale since ${new Date(view.staleSince).toLocaleTimeString()}`
                : `updated ${new Date(view.receivedAt).toLocaleTimeString()}`}
        </span>
    )
}

export const ComponentPanel = ({
    peer,
    namespace,
    component,
    methods,
    types,
    server,
    onSubscribed
}: {
    peer: string
    namespace: string
    component: DescribedComponent
    /** This namespace's described methods, which is where the editors come from. */
    methods: DescribedMethod[]
    /** Named types from the contract, for resolving the refs inside props and state. */
    types?: { [name: string]: TypeNode }
    /** The page's own RpcServer - the peer this page is - read at observe time, like sendChat. */
    server: RefObject<RpcServer | null>
    /** The peer's observer count just changed, so a re-describe will show it moving. */
    onSubscribed?: () => void
}) => {
    const [store, setStore] = useState<Store | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [pending, setPending] = useState<string | undefined>()
    const [failed, setFailed] = useState<{ path: string; message: string } | undefined>()

    const status = useChannelFact(store, statusOf, undefined)
    const hasData = useChannelFact(store, hasDataOf, false)

    const props = useMemo(() => (store ? storeSource(store, ['props']) : null), [store])
    const state = useMemo(() => (store ? storeSource(store, ['state']) : null), [store])

    // The one place the channel is released: stopping sets store to null and unmounting does the
    // same implicitly, so switching peers cannot leak a subscription the server keeps serving.
    useEffect(() => () => void store?.close(), [store])

    const observe = async () => {
        const link = server.current
        if (!link) return
        setBusy(true)
        setError(null)
        try {
            const remote = await link.component<RpcComponentLike>(namespace, peer)
            setStore(remote[rpcComponent] as Store)
            onSubscribed?.()
        } catch (e) {
            setError((e as { message?: string }).message ?? String(e))
        } finally {
            setBusy(false)
        }
    }

    const stop = () => {
        setStore(null)
        onSubscribed?.()
    }

    /**
     * State only: props are the host's inputs and are not the caller's to set. Depth is no longer
     * the limit it was - a declaration can name `zones.top.setpoint` - so a path renders with an
     * editor exactly when some method claims it, and without one when none does, which is the
     * honest answer rather than a guess that ran out of rope.
     */
    const edit: EditAffordance = {
        setterFor: (path) => {
            const setter = setterMethod(path, methods)
            if (!setter) return undefined
            const { method, generic } = setter
            return {
                method: method.name,
                call: async (value: unknown) => {
                    const link = server.current
                    if (!link) return
                    setPending(path.join('.'))
                    setFailed(undefined)
                    try {
                        const proxy = await link.proxy<Record<string, (...args: unknown[]) => Promise<unknown>>>(namespace, peer)
                        // The generic form is told where to write; the per-field one already knows.
                        await (generic ? proxy[method.name](path, value) : proxy[method.name](value))
                        // Nothing is written locally on success. The value on screen changes when
                        // the component publishes its next snapshot, which is the only report that
                        // the plant agrees - an optimistic row would show a setpoint the oven
                        // refused.
                    } catch (e) {
                        setFailed({ path: path.join('.'), message: (e as { message?: string }).message ?? String(e) })
                    } finally {
                        setPending(undefined)
                    }
                }
            }
        },
        ...(pending ? { pending } : {}),
        ...(failed ? { failed } : {})
    }

    const stale = status === 'stale'
    return (
        <div className={`component${stale ? ' stale' : ''}`}>
            <div className="component-head">
                <span className="comp-label">component</span>
                {status && <span className={`status-badge ${status}`}>{status}</span>}
                {store && <Revision store={store} />}
                <span className="muted">
                    {component.subscribers} observer{component.subscribers === 1 ? '' : 's'}
                </span>
                {!store && (
                    <button className="toggle" onClick={() => void observe()} disabled={busy}>
                        {busy ? 'observing…' : 'observe'}
                    </button>
                )}
                {store && (
                    <button className="toggle on" onClick={stop}>
                        stop
                    </button>
                )}
            </div>
            {error && <p className="component-error">{error}</p>}
            {!store && !error && <p className="muted">Cached props and state, read without a call. Observe to subscribe.</p>}
            {hasData && props && state && (
                <div className="component-body">
                    <div className="value-table">
                        <h4>props</h4>
                        <ValueTree source={props} type={component.props} types={types} />
                    </div>
                    <div className="value-table">
                        <h4>state</h4>
                        <ValueTree source={state} type={component.state} types={types} edit={edit} />
                    </div>
                </div>
            )}
        </div>
    )
}
