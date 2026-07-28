import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcServer, TransportEvent, type RpcSchema } from '@source-repo/msgrpc'
import { pageName } from './peerName'
import { Chat } from './Chat'
import { ChatMessage, ChatService } from './ChatService'
// Extracted from ChatService by `npm run contract` and committed. A page is the one peer nobody can
// read the source of at runtime, so shipping its contract is what lets another console show
// `say(from: string, text: string)` instead of `say(…)`.
import chatContract from './chat.types.json'
import { MethodPanel } from './MethodPanel'
import { Traffic, TRAFFIC_KEPT } from './Traffic'
import { Problems } from './Problems'
import { ConsoleService, DescribedEvent, NetworkProblem, ServerDescription, StreamedEvent, TappedFrame, fetchConsoleName, typeText } from './types'

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
    const frames = useRef<((frame: TappedFrame) => void) | null>(null)
    const problems = useRef<((problem: NetworkProblem) => void) | null>(null)
    const peer = useRef<RpcServer | null>(null)

    useEffect(() => {
        let server: RpcServer | undefined
        void (async () => {
            try {
                // Ask who is serving this page before addressing it: the console's name is its own
                // name on the network, so it differs between instances.
                const consoleName = await fetchConsoleName()
                // Random per tab, kept across its reloads. See peerName: anything derived from the
                // URL gives every browser on this console the same name, and a name is an address.
                const name = pageName()
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
                // Subscribed once, whether or not anything is tapping: the console emits nothing
                // here until a tap is started, and re-subscribing per tap would drop frames in the
                // gap between the two calls.
                await proxy.remote!.on('frame', (frame: unknown) => frames.current?.(frame as TappedFrame))
                await proxy.remote!.on('problem', (problem: unknown) => problems.current?.(problem as NetworkProblem))
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

    return { service, status, me, events, peerChange, said, frames, problems, peer }
}

/** Which of the side panel's three views is showing. */
type SideTab = 'chat' | 'events' | 'traffic' | 'problems'

export const App = () => {
    const { service, status, me, events, peerChange, said, frames, problems, peer } = useConsole()
    const [chats, setChats] = useState<{ [peer: string]: ChatMessage[] }>({})
    const [peers, setPeers] = useState<string[]>([])
    const [offline, setOffline] = useState<Set<string>>(new Set())
    const [selected, setSelected] = useState<string | null>(null)
    const [described, setDescribed] = useState<ServerDescription | { error: string; code?: string } | null>(null)
    const [watching, setWatching] = useState<Set<string>>(new Set())
    const [stream, setStream] = useState<StreamedEvent[]>([])
    const [tab, setTab] = useState<SideTab>('events')
    const [traffic, setTraffic] = useState<TappedFrame[]>([])
    const [trafficPaused, setTrafficPaused] = useState(false)
    const [trouble, setTrouble] = useState<NetworkProblem[]>([])
    const [links, setLinks] = useState<{ [peer: string]: string }>({})

    const refreshPeers = useCallback(async () => {
        if (!service) return
        const state = await service.peers()
        setPeers(state.peers)
        setWatching(new Set(state.watching))
        setLinks(state.links ?? {})
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

    useEffect(() => {
        // Pausing stops the buffer filling rather than only the list rendering, so a paused tab on a
        // busy plant is actually paused - and what was on screen when it was paused stays there.
        frames.current = (frame) => {
            if (trafficPaused) return
            setTraffic((current) => [frame, ...current].slice(0, TRAFFIC_KEPT))
        }
    }, [frames, trafficPaused])

    useEffect(() => {
        problems.current = (problem) => setTrouble((current) => [problem, ...current].slice(0, 200))
        // Fetched as well as streamed: the console keeps what happened before this page was opened,
        // and on a network that is already misbehaving that is the part worth reading.
        if (service) void service.problems().then(({ problems: history }) => setTrouble(history)).catch(() => undefined)
    }, [service, problems])

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
                        {/* Which link it was found on. On a plant with the devices on a broker and
                            the HMIs on a hub, that is the first thing worth knowing about a peer. */}
                        {links[peer] && links[peer] !== 'this console' && <span className="link">{links[peer]}</span>}
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
                {/*
                 * Three views of one column rather than three stacked panes: traffic is a list that
                 * fills, and giving it a third of the height would make it useless on the network
                 * where it matters most.
                 */}
                <nav className="tabs">
                    {(['events', 'traffic', 'problems', 'chat'] as const).map((name) => (
                        <button key={name} className={tab === name ? 'tab on' : 'tab'} onClick={() => setTab(name)}>
                            {name}
                            {name === 'traffic' && traffic.length > 0 && <span className="count">{traffic.length}</span>}
                            {name === 'problems' && trouble.length > 0 && <span className="count bad">{trouble.length}</span>}
                        </button>
                    ))}
                </nav>

                {tab === 'chat' && <Chat peer={selected} messages={selected ? (chats[selected] ?? []) : []} onSend={sendChat} />}

                {tab === 'problems' && <Problems problems={trouble} onClear={() => setTrouble([])} />}

                {/* Always mounted, so switching tabs does not drop the tap. See Traffic's `hidden`. */}
                <Traffic
                    service={service}
                    selected={selected}
                    frames={traffic}
                    onClear={() => setTraffic([])}
                    paused={trafficPaused}
                    onPaused={setTrafficPaused}
                    hidden={tab !== 'traffic'}
                />

                {tab === 'events' && (
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
                )}
            </section>
        </div>
    )
}
