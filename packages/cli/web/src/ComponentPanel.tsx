import { RefObject, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { rpcComponent, type RpcComponentData, type RpcComponentLike, type RpcComponentStore, type RpcServer } from '@source-repo/rpc'
import { DescribedComponent } from './types'

/**
 * An observable component, rendered from the library's own store.
 *
 * The page is a peer, so it observes the way any peer does: component() over its own link, the
 * shared channel, the epoch/revision acceptance rules - not a feed the console re-serves. What
 * this panel adds is only rendering: the channel status beside the values, and last-known data
 * kept visible while stale, because "20 °C, stale since 14:03" is an answer and a blank is not.
 */

type Store = RpcComponentStore<RpcComponentData, RpcComponentData>

/**
 * The duck-typed projection of a process value: an object carrying `value` plus any of `quality`,
 * `unit`, `forced`. The domain classes live in sector contract packages the console has no
 * compile-time sight of, so the shape is recognized rather than imported - and anything that does
 * not match simply renders as the object it is, never hidden.
 */
const processValue = (value: unknown): { value: unknown; quality?: string; unit?: string; forced: boolean } | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as { [key: string]: unknown }
    if (!('value' in record)) return null
    if (!('quality' in record) && !('unit' in record) && !('forced' in record)) return null
    return {
        value: record.value,
        quality: typeof record.quality === 'string' ? record.quality : undefined,
        unit: typeof record.unit === 'string' ? record.unit : undefined,
        forced: record.forced === true
    }
}

const plain = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined'))

const ValueRow = ({ name, value }: { name: string; value: unknown }) => {
    const projected = processValue(value)
    return (
        <div className="value-row">
            <span className="value-name mono">{name}</span>
            {projected ? (
                <span className="value mono">
                    {plain(projected.value)}
                    {projected.unit && <span className="unit"> {projected.unit}</span>}
                </span>
            ) : (
                <span className="value mono">{plain(value)}</span>
            )}
            {/* Forced first and always: a forced value is right by decree, and the person at this
                console is exactly who must not mistake it for a measurement. */}
            {projected?.forced && <span className="quality forced">forced</span>}
            {projected?.quality && <span className={`quality q-${projected.quality}`}>{projected.quality}</span>}
        </div>
    )
}

export const ComponentPanel = ({
    peer,
    namespace,
    component,
    server,
    onSubscribed
}: {
    peer: string
    namespace: string
    component: DescribedComponent
    /** The page's own RpcServer - the peer this page is - read at observe time, like sendChat. */
    server: RefObject<RpcServer | null>
    /** The peer's observer count just changed, so a re-describe will show it moving. */
    onSubscribed?: () => void
}) => {
    const [store, setStore] = useState<Store | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => undefined), [store])
    // The store replaces its view object on every change, which is exactly the reference equality
    // useSyncExternalStore wants - no selector, no memo, no tearing.
    const getSnapshot = useCallback(() => store?.getSnapshot() ?? null, [store])
    const view = useSyncExternalStore(subscribe, getSnapshot)

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

    const stale = view?.status === 'stale'
    return (
        <div className={`component${stale ? ' stale' : ''}`}>
            <div className="component-head">
                <span className="comp-label">component</span>
                {view && <span className={`status-badge ${view.status}`}>{view.status}</span>}
                {view && view.receivedAt > 0 && (
                    <span className="muted">
                        rev {view.revision} ·{' '}
                        {stale && view.staleSince
                            ? `last known ${new Date(view.receivedAt).toLocaleTimeString()}, stale since ${new Date(view.staleSince).toLocaleTimeString()}`
                            : `updated ${new Date(view.receivedAt).toLocaleTimeString()}`}
                    </span>
                )}
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
            {store && view && view.receivedAt > 0 && (
                <div className="component-body">
                    <div className="value-table">
                        <h4>props</h4>
                        {Object.entries(view.props).map(([name, value]) => (
                            <ValueRow key={name} name={name} value={value} />
                        ))}
                        {Object.keys(view.props).length === 0 && <p className="muted">empty</p>}
                    </div>
                    <div className="value-table">
                        <h4>state</h4>
                        {Object.entries(view.state).map(([name, value]) => (
                            <ValueRow key={name} name={name} value={value} />
                        ))}
                        {Object.keys(view.state).length === 0 && <p className="muted">empty</p>}
                    </div>
                </div>
            )}
        </div>
    )
}
