import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcServer, TransportEvent, readableNameFrom, type RpcSchema } from '@source-repo/msgrpc'
import { Chat } from './Chat'
import { ChatMessage, ChatService } from './ChatService'
// Extracted from ChatService by `npm run contract` and committed. A page is the one peer nobody can
// read the source of at runtime, so shipping its contract is what lets another console show
// `say(from: string, text: string)` instead of `say(…)`.
import chatContract from './chat.types.json'
import { MethodPanel } from './MethodPanel'
import { ConsoleService, DescribedEvent, ServerDescription, StreamedEvent, fetchConsoleName, typeText } from './types'

/**
 * The page talks to the CLI over msgrpc itself, and is a peer of the network in its own right.
 *
 * One RpcServer does both. It serves over the connection it opens to the console - the only thing
 * a browser can do, since it cannot listen - which is what lets another peer call the chat service
 * exposed here. The same object calls outwards with proxy(), so browsing the network and hosting a
 * service on it share one link and one name.
 *
 * The name is derived from the console this page is attached to, so it is the same on every reload
 * and two pages on different consoles are plainly different peers.
 */

const useConsole = () => {
    const [service, setService] = useState<ConsoleService | null>(null)
    const [me, setMe] = useState('')
    const [status, setStatus] = useState('connecting')
    const events = useRef<((event: StreamedEvent) => void) | null>(null)
    const peerChange = useRef<((peer: string, state: string) => void) | null>(null)
    const said = useRef<((from: string, text: string) => void) | null>(null)
    const peer = useRef<RpcServer | null>(null)

    useEffect(() => {
        let server: RpcServer | undefined
        void (async () => {
            try {
                // Ask who is serving this page before addressing it: the console's name is its own
                // name on the network, so it differs between instances.
                const consoleName = await fetchConsoleName()
                // Derived from the console rather than drawn at random, so a reload comes back as
                // the same peer instead of leaving a stranger in everyone's list. A second tab on
                // the same console adds a suffix, which sessionStorage keeps across its reloads.
                let tab = sessionStorage.getItem('msgrpc-tab')
                if (!tab) {
                    tab = Math.random().toString(36).slice(2, 5)
                    sessionStorage.setItem('msgrpc-tab', tab)
                }
                const first = !sessionStorage.getItem('msgrpc-second-tab')
                const name = readableNameFrom(window.location.host) + (first ? '' : `-${tab}`)
                setMe(name)

                server = new RpcServer({
                    name,
                    transports: [{ connect: window.location.origin }],
                    readyTimeout: 10000,
                    schema: chatContract as RpcSchema,
                    // So a page can be selected in another page's console and describe itself.
                    // Without it every peer here answers ClassNotFound, which is true but useless.
                    exposeIntrospection: true
                })
                // No name here: @rpcNamespace('chat') carries it. That matters in a bundle, where
                // the class name is minified to something like `Mv` and would be the fallback.
                server.exposeClassInstance(new ChatService((from, text) => said.current?.(from, text)))
                const link = server.transports[0]
                link?.on(TransportEvent.disconnected, () => setStatus('reconnecting'))
                link?.on(TransportEvent.connected, () => setStatus('connected'))
                await server.ready()
                // Attached after ready(): transports are built asynchronously, so before it there
                // is nothing to listen to.
                for (const transport of server.transports) {
                    transport.on(TransportEvent.disconnected, () => setStatus('reconnecting'))
                    transport.on(TransportEvent.connected, () => setStatus('connected'))
                }
                peer.current = server

                const proxy = await server.proxy<ConsoleService & { on: (e: string, h: (...a: unknown[]) => void) => Promise<unknown> }>('console', consoleName)
                await proxy.remote!.on('event', (event: unknown) => events.current?.(event as StreamedEvent))
                await proxy.remote!.on('peer', (change: unknown) => {
                    const { peer: name, state } = change as { peer: string; state: string }
                    peerChange.current?.(name, state)
                })
                const remote = proxy.remote as ConsoleService
                // The console does the waiting: it holds the broker link, enforces --timeout, and
                // its answer says what went wrong. A browser giving up first would replace that
                // diagnosis with a bare 'Timeout' at almost exactly the same moment.
                const { callTimeout } = await remote.peers()
                if (callTimeout) server.caller.callTimeout = callTimeout + 5000
                setService(remote)
                setStatus('connected')
            } catch (e) {
                setStatus(`cannot reach the console: ${(e as Error).message}`)
            }
        })()
        return () => void server?.close()
    }, [])

    return { service, status, me, events, peerChange, said, peer }
}

export const App = () => {
    const { service, status, me, events, peerChange, said, peer } = useConsole()
    const [chats, setChats] = useState<{ [peer: string]: ChatMessage[] }>({})
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

    // The tab is where two consoles are told apart when both are open, so it carries the peer name
    // rather than a title that is the same on every one of them.
    useEffect(() => {
        if (me) document.title = me
    }, [me])

    useEffect(() => {
        said.current = (from, text) =>
            setChats((current) => ({ ...current, [from]: [...(current[from] ?? []), { from, text, at: Date.now(), mine: false }] }))
    }, [said])

    /** Calls the peer's own chat service - the page at the other end, not the console. */
    const sendChat = async (text: string) => {
        if (!peer.current || !selected) return 'not connected'
        setChats((current) => ({ ...current, [selected]: [...(current[selected] ?? []), { from: me, text, at: Date.now(), mine: true }] }))
        try {
            const proxy = await peer.current.proxy<{ say: (from: string, text: string) => Promise<string> }>('chat', selected)
            await proxy.remote!.say(me, text)
            return undefined
        } catch (e) {
            // Most often the peer is not running this console, so it exposes no chat namespace.
            return `${selected} did not take it: ${(e as { code?: string; message?: string }).message ?? String(e)}`
        }
    }

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
                {/*
                 * This page is a peer of the network, not a viewer of it - it hosts an RpcServer of
                 * its own - so it says which peer it is, in the one place that is always visible.
                 * The same name appears in the list below, marked, because that is where someone
                 * looking at two consoles side by side will actually compare them.
                 */}
                <div className="identity">
                    <span className="muted">this page is</span>
                    <span className="mono name" title="the peer name this page serves and calls under">
                        {me || '…'}
                    </span>
                </div>
                <header>
                    <h1>Peers</h1>
                    <span className={`status ${status === 'connected' ? 'ok' : 'warn'}`}>{status}</span>
                </header>
                {peers.length === 0 && <p className="muted">Waiting for a peer to announce itself…</p>}
                {peers.map((peer) => (
                    <button key={peer} className={`peer${peer === selected ? ' selected' : ''}`} onClick={() => void select(peer)}>
                        <span className={`dot${offline.has(peer) ? ' off' : ''}`} />
                        {peer}
                        {peer === me && <span className="you">you</span>}
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

            <section className="side">
                <Chat peer={selected} messages={selected ? (chats[selected] ?? []) : []} onSend={sendChat} />
                <div className="stream">
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
                </div>
            </section>
        </div>
    )
}
