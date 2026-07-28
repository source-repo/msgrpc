import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcClient, TransportEvent } from '@source-repo/msgrpc'
import { MethodPanel } from './MethodPanel'
import { ConsoleService, DescribedEvent, ServerDescription, StreamedEvent, fetchConsoleName, typeText } from './types'

/**
 * The console talks to the CLI over msgrpc itself: the CLI runs an RpcServer on the same HTTP
 * server that served this page, and this is an ordinary browser client of it. Calls and the event
 * stream both ride the library rather than a bespoke REST and SSE pair.
 */

const useConsole = () => {
    const [service, setService] = useState<ConsoleService | null>(null)
    const [status, setStatus] = useState('connecting')
    const events = useRef<((event: StreamedEvent) => void) | null>(null)
    const peerChange = useRef<((peer: string, state: string) => void) | null>(null)

    useEffect(() => {
        let client: RpcClient | undefined
        void (async () => {
            try {
                // Ask who is serving this page before addressing it: the console's name is its own
                // name on the network, so it differs between instances.
                const consoleName = await fetchConsoleName()
                client = new RpcClient(window.location.origin, { defaultTarget: consoleName, readyTimeout: 10000 })
                client.on(TransportEvent.disconnected, () => setStatus('reconnecting'))
                client.on(TransportEvent.connected, () => setStatus('connected'))
                await client.ready()
                const proxy = await client.proxy<ConsoleService & { on: (e: string, h: (...a: unknown[]) => void) => void }>('console')
                await proxy.remote!.on('event', (event: unknown) => events.current?.(event as StreamedEvent))
                await proxy.remote!.on('peer', (change: unknown) => {
                    const { peer, state } = change as { peer: string; state: string }
                    peerChange.current?.(peer, state)
                })
                const remote = proxy.remote as ConsoleService
                // The console does the waiting: it holds the broker link, enforces --timeout, and
                // its answer says what went wrong. A browser giving up first would replace that
                // diagnosis with a bare 'Timeout' at almost exactly the same moment.
                const { callTimeout } = await remote.peers()
                if (client.rpcClient && callTimeout) client.rpcClient.callTimeout = callTimeout + 5000
                setService(remote)
                setStatus('connected')
            } catch (e) {
                setStatus(`cannot reach the console: ${(e as Error).message}`)
            }
        })()
        return () => void client?.close()
    }, [])

    return { service, status, events, peerChange }
}

export const App = () => {
    const { service, status, events, peerChange } = useConsole()
    const [peers, setPeers] = useState<string[]>([])
    const [offline, setOffline] = useState<Set<string>>(new Set())
    const [selected, setSelected] = useState<string | null>(null)
    const [described, setDescribed] = useState<ServerDescription | { error: string; code?: string } | null>(null)
    const [watching, setWatching] = useState<Set<string>>(new Set())
    const [stream, setStream] = useState<StreamedEvent[]>([])

    const refreshPeers = useCallback(async () => {
        if (!service) return
        const state = await service.peers()
        setPeers(state.peers)
        setWatching(new Set(state.watching))
    }, [service])

    useEffect(() => {
        void refreshPeers()
        events.current = (event) => setStream((current) => [event, ...current].slice(0, 200))
        peerChange.current = (peer, state) => {
            setOffline((current) => {
                const next = new Set(current)
                if (state === 'offline') next.add(peer)
                else next.delete(peer)
                return next
            })
            void refreshPeers()
        }
    }, [service, refreshPeers, events, peerChange])

    const select = async (peer: string) => {
        setSelected(peer)
        setDescribed(null)
        if (!service) return
        setDescribed(await service.describe(peer))
        await refreshPeers()
    }

    const toggleWatch = async (namespace: string, event: DescribedEvent) => {
        if (!service || !selected) return
        const key = `${selected}/${namespace}/${event.name}`
        const answer = watching.has(key) ? await service.unwatch(selected, namespace, event.name) : await service.watch(selected, namespace, event.name)
        setWatching((current) => {
            const next = new Set(current)
            if (answer.watching) next.add(key)
            else next.delete(key)
            return next
        })
        if (selected) setDescribed(await service.describe(selected))
    }

    const failed = described && 'error' in described ? described : null
    const description = described && !('error' in described) ? described : null

    return (
        <div className="app">
            <aside>
                <header>
                    <h1>Peers</h1>
                    <span className={`status ${status === 'connected' ? 'ok' : 'warn'}`}>{status}</span>
                </header>
                {peers.length === 0 && <p className="muted">Waiting for a peer to announce itself…</p>}
                {peers.map((peer) => (
                    <button key={peer} className={`peer${peer === selected ? ' selected' : ''}`} onClick={() => void select(peer)}>
                        <span className={`dot${offline.has(peer) ? ' off' : ''}`} />
                        {peer}
                    </button>
                ))}
            </aside>

            <main>
                {!selected && <p className="muted">Select a peer to see what it exposes.</p>}
                {selected && !described && <p className="muted">Describing {selected}…</p>}
                {failed && (
                    <div className="notice">
                        <strong>{failed.code ?? 'Error'}</strong>
                        <p>{failed.error}</p>
                        <p className="muted">A server answers this only when it is started with exposeIntrospection.</p>
                    </div>
                )}
                {description && (
                    <>
                        <header className="peer-head">
                            <h1>{description.name}</h1>
                            <span className="muted">
                                {description.version ? `contract ${description.version} · ` : ''}
                                {description.validating ? 'arguments checked' : 'arguments not checked'}
                            </span>
                        </header>
                        {description.namespaces.map((namespace) => (
                            <section key={namespace.name} className="namespace">
                                <h2>
                                    {namespace.name}
                                    {namespace.version && <span className="badge">@{namespace.version}</span>}
                                    <span className="muted mono">
                                        {namespace.className}
                                        {namespace.created ? ' · created at runtime' : ''}
                                    </span>
                                </h2>
                                {namespace.methods.map((method) => (
                                    <MethodPanel
                                        key={method.name}
                                        peer={selected!}
                                        namespace={namespace.name}
                                        method={method}
                                        types={description.types}
                                        service={service!}
                                    />
                                ))}
                                {namespace.events.length > 0 && (
                                    <div className="events">
                                        <h3>events</h3>
                                        {namespace.events.map((event) => {
                                            const on = watching.has(`${selected}/${namespace.name}/${event.name}`)
                                            return (
                                                <div key={event.name} className="event-row">
                                                    <code>
                                                        {event.name}({event.params ? event.params.map(typeText).join(', ') : '…'})
                                                    </code>
                                                    <button className={on ? 'toggle on' : 'toggle'} onClick={() => void toggleWatch(namespace.name, event)}>
                                                        {on ? 'unwatch' : 'watch'}
                                                    </button>
                                                    <span className="muted">
                                                        {event.subscribers} subscriber{event.subscribers === 1 ? '' : 's'}
                                                    </span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </section>
                        ))}
                    </>
                )}
            </main>

            <section className="stream">
                <header>
                    <h1>Events</h1>
                    {stream.length > 0 && (
                        <button className="toggle" onClick={() => setStream([])}>
                            clear
                        </button>
                    )}
                </header>
                {stream.length === 0 && <p className="muted">Watch an event to see it here.</p>}
                {stream.map((event, index) => (
                    <div key={`${event.at}-${index}`} className="streamed">
                        <time>{new Date(event.at).toLocaleTimeString()}</time>
                        <code>
                            {event.peer}/{event.namespace}.{event.event}
                        </code>
                        <pre>{JSON.stringify(event.args)}</pre>
                    </div>
                ))}
            </section>
        </div>
    )
}
