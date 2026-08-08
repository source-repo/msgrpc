import { RefObject, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { defineRpcContext, type RpcContextAxis, type RpcContextStore, type RpcServer } from '@source-repo/rpc'
import { ValueTree, staticSource } from './ValueTree'
import type { DescribedRef } from './types'

/**
 * The ambient data a node inherits, as that node's own host resolves it.
 *
 * The page asks with contextAt(), which is the library's own resolver started one step further
 * out: the same chain walking, the same nearest/collect, the same lifecycle words, and the same
 * cycle and depth checks - so what this shows is what the node sees, not a second opinion the
 * console arrived at on its own. The alternative would have been to graft the page into the
 * topology beside the node it wants to read, which is a claim about the plant that is not true.
 *
 * **There is no list of tokens to pick from, and that is deliberate.** Context has no enumeration
 * surface: a caller must already know a token's id, because listing what ambient data a plant
 * carries is reconnaissance of a sharper kind than listing methods, and a token whose provider
 * declares `exposure: 'local'` is filtered from remote answers silently rather than refused - a
 * refusal would confirm it exists. So an operator types the ids they are entitled to know, and
 * the console remembers them per peer.
 */

interface Watched {
    id: string
    /**
     * Which chain to walk. It belongs to the token's definition, and the console has not seen
     * that definition - so it is asked for rather than guessed at, and getting it wrong answers
     * `missing` rather than borrowing from the other axis. There is no fallback between them.
     */
    axis: RpcContextAxis
}

const key = (peer: string) => `source-rpc.context-tokens.${peer}`

const remembered = (peer: string): Watched[] => {
    try {
        const held = localStorage.getItem(key(peer))
        return held ? (JSON.parse(held) as Watched[]) : []
    } catch {
        return []
    }
}

const remember = (peer: string, watched: Watched[]) => {
    try {
        localStorage.setItem(key(peer), JSON.stringify(watched))
    } catch {
        // A console in a private window still works; it just forgets between visits.
    }
}

const refText = (ref: DescribedRef, home: string) => (ref.peer === home ? ref.instance : `${ref.peer}/${ref.instance}`)

const TokenView = ({ store, home, onRemove }: { store: RpcContextStore; home: string; onRemove: () => void }) => {
    const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
    const getSnapshot = useCallback(() => store.getSnapshot(), [store])
    const view = useSyncExternalStore(subscribe, getSnapshot)

    // Asked for with `collect` whatever the provider declared, because a console showing the whole
    // chain is strictly more use than one showing only the winner - and the winner is the first.
    const entries = view.entries ?? (view.entry ? [view.entry] : [])

    return (
        <div className="context-token">
            <div className="context-token-head">
                <code className="mono">{view.tokenId}</code>
                <span className={`axis-badge ${view.axis}`}>{view.axis}</span>
                <span className={`status-badge ${view.status}`}>{view.status}</span>
                {view.status === 'stale' && view.staleSince && <span className="muted">stale since {new Date(view.staleSince).toLocaleTimeString()}</span>}
                {view.status === 'invalid' && (
                    <span className="component-error">
                        {view.invalidReason}
                        {view.invalidPath ? `: ${view.invalidPath.map((ref) => `${ref.peer}/${ref.instance}`).join(' -> ')}` : ''}
                    </span>
                )}
                <button className="toggle" onClick={onRemove} title="stop watching this token">
                    ✕
                </button>
            </div>
            {view.status === 'missing' && <p className="muted">nothing on this node&apos;s {view.axis} chain provides it</p>}
            {entries.map((entry, index) => (
                <div key={`${entry.provider.peer}/${entry.provider.instance}`} className="context-entry">
                    <span className="muted mono provider" title={`provided at ${entry.provider.peer}/${entry.provider.instance}`}>
                        {refText(entry.provider, home)}
                        {index === 0 && entries.length > 1 ? ' · nearest' : ''}
                    </span>
                    {/* No published type: a context value is `unknown` on the wire by design, so
                        the tree draws what is there rather than what was promised. */}
                    <ValueTree source={staticSource(entry.value)} />
                </div>
            ))}
        </div>
    )
}

const TokenRow = ({ watched, peer, node, server, onRemove }: { watched: Watched; peer: string; node: string; server: RefObject<RpcServer | null>; onRemove: () => void }) => {
    const [store, setStore] = useState<RpcContextStore | null>(null)

    useEffect(() => {
        const link = server.current
        if (!link) return
        const token = defineRpcContext({ id: watched.id, schemaVersion: '1', axis: watched.axis, resolution: 'collect' })
        const opened = link.contextAt({ peer, instance: node }, token)
        setStore(opened)
        return () => {
            opened.close()
            setStore(null)
        }
    }, [peer, node, watched.id, watched.axis, server])

    if (!store) return null
    return <TokenView store={store} home={peer} onRemove={onRemove} />
}

export const ContextPanel = ({ peer, node, server }: { peer: string; node: string; server: RefObject<RpcServer | null> }) => {
    const [watching, setWatching] = useState<Watched[]>(() => remembered(peer))
    const [draft, setDraft] = useState('')
    const [axis, setAxis] = useState<RpcContextAxis>('physical')

    useEffect(() => setWatching(remembered(peer)), [peer])

    const update = (next: Watched[]) => {
        setWatching(next)
        remember(peer, next)
    }

    const add = () => {
        const id = draft.trim()
        if (!id || watching.some((held) => held.id === id && held.axis === axis)) return
        update([...watching, { id, axis }])
        setDraft('')
    }

    return (
        <div className="context">
            <div className="context-head">
                <span className="comp-label">context</span>
                <span className="muted mono">{node}</span>
                <form
                    className="context-add"
                    onSubmit={(event) => {
                        event.preventDefault()
                        add()
                    }}
                >
                    <input value={draft} placeholder="token id, e.g. acme.site" aria-label="context token id" onChange={(event) => setDraft(event.target.value)} />
                    <select value={axis} aria-label="axis" onChange={(event) => setAxis(event.target.value as RpcContextAxis)}>
                        <option value="physical">physical</option>
                        <option value="logical">logical</option>
                    </select>
                    <button className="toggle" type="submit" disabled={!draft.trim()}>
                        watch
                    </button>
                </form>
            </div>
            {watching.length === 0 && (
                <p className="muted">
                    Name a token to watch it. There is no list to choose from on purpose: a caller must already know an id, because enumerating the ambient data a
                    plant carries is reconnaissance.
                </p>
            )}
            {watching.map((held) => (
                <TokenRow
                    key={`${held.id} ${held.axis}`}
                    watched={held}
                    peer={peer}
                    node={node}
                    server={server}
                    onRemove={() => update(watching.filter((other) => !(other.id === held.id && other.axis === held.axis)))}
                />
            ))}
        </div>
    )
}
