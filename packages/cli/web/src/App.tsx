import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcServer, TransportEvent, type RpcSchema } from '@source-repo/rpc'
import { pageName } from './peerName'
import { Chat } from './Chat'
import { ChatMessage, ChatService } from './ChatService'
// Extracted from ChatService by `npm run contract` and committed. A page is the one peer nobody can
// read the source of at runtime, so shipping its contract is what lets another console show
// `say(from: string, text: string)` instead of `say(…)`.
import chatContract from './chat.types.json'
import { ComponentPanel } from './ComponentPanel'
import { StructurePanel } from './StructurePanel'
import { MethodPanel } from './MethodPanel'
import { Traffic, TRAFFIC_KEPT } from './Traffic'
import { Problems } from './Problems'
import { Presence } from './Presence'
import { ConsoleService, DescribedEvent, NetworkProblem, PeerChange, PeerRole, PeerStructure, ServerDescription, StreamedEvent, TappedFrame, fetchConsoleName, socketPath, typeText } from './types'

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

/** How many times the page will try the handshake again before giving up and saying so. */
const RECONNECT_ATTEMPTS = 3

const useConsole = () => {
    const [service, setService] = useState<ConsoleService | null>(null)
    const [me, setMe] = useState('')
    const [status, setStatus] = useState('connecting')
    const events = useRef<((event: StreamedEvent) => void) | null>(null)
    const peerChange = useRef<((peer: string, state: string, change: PeerChange) => void) | null>(null)
    const said = useRef<((from: string, text: string) => void) | null>(null)
    const frames = useRef<((frame: TappedFrame) => void) | null>(null)
    const problems = useRef<((problem: NetworkProblem) => void) | null>(null)
    const peer = useRef<RpcServer | null>(null)

    useEffect(() => {
        let server: RpcServer | undefined
        let attempts = 0
        let cancelled = false
        /**
         * Closed on the way out of the page as well as on unmount.
         *
         * React's cleanup does not run when a document is torn down by a navigation, so a page that
         * was navigated away from left its connection for the console to reap on a timeout - and in
         * the meantime it is still a peer, still in everyone's list, and still being sent the events
         * it subscribed to. Five stale pages after five reloads is the ordinary shape of a debugging
         * session. `pagehide` covers navigation, tab close and the back/forward cache, where
         * `unload` is unreliable and increasingly ignored.
         */
        const leaving = () => void server?.close()
        window.addEventListener('pagehide', leaving)

        const connect = async () => {
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
                    // Origin in the url, mount point in the path - see socketPath. Together they
                    // are where this page came from, so a proxied console reaches its own server.
                    transports: [{ connect: window.location.origin, path: socketPath() }],
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
                await proxy.on('event', (event: unknown) => events.current?.(event as StreamedEvent))
                await proxy.on('peer', (change: unknown) => {
                    const coming = change as PeerChange
                    peerChange.current?.(coming.peer, coming.state, coming)
                })
                // Subscribed once, whether or not anything is tapping: the console emits nothing
                // here until a tap is started, and re-subscribing per tap would drop frames in the
                // gap between the two calls.
                await proxy.on('frame', (frame: unknown) => frames.current?.(frame as TappedFrame))
                await proxy.on('problem', (problem: unknown) => problems.current?.(problem as NetworkProblem))
                const remote = proxy as ConsoleService
                // The console does the waiting: it holds the broker link, enforces --timeout, and
                // its answer says what went wrong. A browser giving up first would replace that
                // diagnosis with a bare 'Timeout' at almost exactly the same moment.
                const { callTimeout } = await remote.peers()
                if (callTimeout) server.caller.callTimeout = callTimeout + 5000
                setService(remote)
                setStatus('connected')
            } catch (e) {
                if (cancelled) return
                // Retried rather than left dead. The handshake occasionally times out on a page
                // loaded moments after the last one, and until now that left the console showing an
                // error and no peers with a manual reload as the only way out - which is a poor
                // answer when the page is the thing you opened to find out what was wrong.
                await server?.close().catch(() => undefined)
                server = undefined
                if (++attempts <= RECONNECT_ATTEMPTS) {
                    setStatus(`cannot reach the console, trying again (${attempts}/${RECONNECT_ATTEMPTS})`)
                    await new Promise((wait) => setTimeout(wait, attempts * 1000))
                    if (!cancelled) await connect()
                    return
                }
                setStatus(`cannot reach the console: ${(e as Error).message}`)
            }
        }
        void connect()
        return () => {
            cancelled = true
            window.removeEventListener('pagehide', leaving)
            void server?.close()
        }
    }, [])

    return { service, status, me, events, peerChange, said, frames, problems, peer }
}

/**
 * Saves what is on screen as jsonl, which is the shape `msgrpc record` writes and `jq` reads. Built
 * here rather than fetched, so it works on a plant network with no route to anywhere.
 */
const download = (rows: unknown[], filename: string) => {
    const blob = new Blob([rows.map((row) => JSON.stringify(row)).join('\n') + '\n'], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
}

/** Which of the side panel's three views is showing. */
type SideTab = 'chat' | 'events' | 'traffic' | 'problems' | 'presence'

export const App = () => {
    const { service, status, me, events, peerChange, said, frames, problems, peer } = useConsole()
    const [chats, setChats] = useState<{ [peer: string]: ChatMessage[] }>({})
    /**
     * Messages that have arrived and not been looked at, per peer.
     *
     * Without this a message changes nothing on screen at all: the log is keyed by the peer selected
     * in the sidebar and the chat tab is one of five, so unless you already had that exact peer
     * selected with that tab open, a peer could say hello and you would never learn it had. Traffic
     * and problems have carried a count since they were written; chat was the one that let its
     * arrivals pass in silence.
     */
    const [unread, setUnread] = useState<{ [peer: string]: number }>({})
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
    const [network, setNetwork] = useState<{ broker?: string; hub?: string; prefix?: string }>({})
    const [roles, setRoles] = useState<{ [peer: string]: PeerRole }>({})
    const [structure, setStructure] = useState<{ [peer: string]: PeerStructure }>({})
    const [comings, setComings] = useState<PeerChange[]>([])
    const [eventFilter, setEventFilter] = useState('')
    const [eventsPaused, setEventsPaused] = useState(false)

    const refreshPeers = useCallback(async () => {
        if (!service) return
        const state = await service.peers()
        setPeers(state.peers)
        setWatching(new Set(state.watching))
        setLinks(state.links ?? {})
        setNetwork(state.network ?? {})
        setRoles(state.roles ?? {})
        setStructure(state.structure ?? {})
    }, [service])

    // The tab is where two consoles are told apart when both are open, so it carries the peer name
    // rather than a title that is the same on every one of them.
    useEffect(() => {
        if (me) document.title = me
    }, [me])

    useEffect(() => {
        said.current = (from, text) => {
            setChats((current) => ({ ...current, [from]: [...(current[from] ?? []), { from, text, at: Date.now(), mine: false }] }))
            // Counted unconditionally and cleared below when it is genuinely on screen. Deciding it
            // here would mean reading `tab` and `selected` out of a closure this effect installs
            // once, so every message after the first would be judged against a stale view.
            setUnread((current) => ({ ...current, [from]: (current[from] ?? 0) + 1 }))
        }
    }, [said])

    // What you are looking at is not unread. An effect rather than something folded into `select`
    // and the tab buttons, because a message can arrive while its own chat is already open, and
    // that one has to clear too. Returning `current` unchanged when there is nothing to clear is
    // what keeps this from setting state on every render for ever.
    useEffect(() => {
        if (tab !== 'chat' || !selected) return
        setUnread((current) => (current[selected] ? { ...current, [selected]: 0 } : current))
    }, [tab, selected, chats])

    /** Calls the peer's own chat service - the page at the other end, not the console. */
    const sendChat = async (text: string) => {
        if (!peer.current || !selected) return 'not connected'
        setChats((current) => ({ ...current, [selected]: [...(current[selected] ?? []), { from: me, text, at: Date.now(), mine: true }] }))
        try {
            const proxy = await peer.current.proxy<{ say: (from: string, text: string) => Promise<string> }>('chat', selected)
            await proxy.say(me, text)
            return undefined
        } catch (e) {
            // Most often the peer is not running this console, so it exposes no chat namespace.
            return `${selected} did not take it: ${(e as { code?: string; message?: string }).message ?? String(e)}`
        }
    }

    useEffect(() => {
        void refreshPeers()
        // Paused stops the buffer filling rather than only the list rendering, the same way the
        // traffic tab does - a paused pane on a busy network should stay as it was.
        events.current = (event) => {
            if (eventsPaused) return
            setStream((current) => [event, ...current].slice(0, 500))
        }
        peerChange.current = (peer, state, change) => {
            if (state === 'reshaped') {
                // The peer is still here - its surface changed and the console has dropped what it
                // cached. Not a coming or a going, so the presence history is left alone; what
                // matters is that an open panel stops showing the old shape without a reselection.
                void refreshPeers()
                if (service && peer === selected) void service.describe(peer).then(setDescribed).catch(() => undefined)
                return
            }
            setOffline((current) => {
                const next = new Set(current)
                if (state === 'offline') next.add(peer)
                else next.delete(peer)
                return next
            })
            setComings((current) => [change, ...current].slice(0, 200))
            void refreshPeers()
        }
    }, [service, refreshPeers, events, peerChange, eventsPaused, selected])

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
        if (service) void service.presence().then(({ changes }) => setComings(changes)).catch(() => undefined)
    }, [service, problems])

    const select = async (peer: string) => {
        setSelected(peer)
        setDescribed(null)
        if (!service) return
        setDescribed(await service.describe(peer))
        await refreshPeers()
    }

    /** Every event in one namespace, in one click - the usual first move on an unfamiliar peer. */
    const watchAll = async (namespace: string, events: DescribedEvent[]) => {
        if (!service || !selected) return
        for (const event of events) {
            if (watching.has(`${selected}/${namespace}/${event.name}`)) continue
            const answer = await service.watch(selected, namespace, event.name)
            if (answer.watching) setWatching((current) => new Set(current).add(`${selected}/${namespace}/${event.name}`))
        }
        setDescribed(await service.describe(selected))
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
    const unreadTotal = Object.values(unread).reduce((total, count) => total + count, 0)

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
                {/*
                 * A tree over what the descriptions have taught so far: a peer whose host root is
                 * attached under another renders beneath it, place beside the name. A peer with no
                 * declared structure - or whose parent is not here - sits at the root, which is
                 * where an unknown belongs. The tree grows as the network is used, like the roles.
                 */}
                {(() => {
                    const known = new Set(peers)
                    const roots = peers.filter((name) => {
                        const parent = structure[name]?.parent
                        return !parent || parent === name || !known.has(parent)
                    })
                    const entry = (name: string, depth: number, seen: Set<string>) => (
                        <div key={name}>
                            <button
                                className={`peer${name === selected ? ' selected' : ''}`}
                                style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
                                onClick={() => void select(name)}
                            >
                                <span className={`dot${offline.has(name) ? ' off' : ''}`} />
                                <span className="peer-lines">
                                    <span>
                                        {name}
                                        {name === me && <span className="you">you</span>}
                                        {/* Which peer to select. The tab count says a message is
                                            waiting; without this you would have to click through
                                            every peer to find out whose. */}
                                        {unread[name] > 0 && <span className="count">{unread[name]}</span>}
                                        {/* Learned from a description already made, so peers label
                                            themselves as the network is used rather than by
                                            describing everything on sight. */}
                                        {roles[name] && <span className={`role ${roles[name]}`}>{roles[name] === 'undescribed' ? 'no contract' : roles[name]}</span>}
                                        {/* Which link it was found on. On a plant with the devices
                                            on a broker and the HMIs on a hub, that is the first
                                            thing worth knowing about a peer. */}
                                        {links[name] && links[name] !== 'this console' && <span className="link">{links[name]}</span>}
                                    </span>
                                    {(structure[name]?.place || structure[name]?.label) && (
                                        <span className="peer-place">
                                            {structure[name]?.place?.join(' / ') ?? ''}
                                            {structure[name]?.label ? `  ${structure[name].label}` : ''}
                                        </span>
                                    )}
                                </span>
                            </button>
                            {/* The visited set is the cycle guard: two hosts each claiming the
                                other as parent must not recurse the sidebar to death. */}
                            {!seen.has(name) &&
                                peers
                                    .filter((child) => structure[child]?.parent === name && child !== name)
                                    .map((child) => entry(child, depth + 1, new Set([...seen, name])))}
                        </div>
                    )
                    return roots.map((name) => entry(name, 0, new Set()))
                })()}
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
                        <StructurePanel description={description} peers={peers} onSelectPeer={(other) => void select(other)} />
                        {description.namespaces.map((namespace) => (
                            <section key={namespace.name} className="namespace">
                                <h2>
                                    {namespace.name}
                                    {namespace.version && <span className="badge">@{namespace.version}</span>}
                                    <span className="muted mono">
                                        {namespace.className}
                                        {namespace.created ? ' · created at runtime' : ''}
                                    </span>
                                    {/* From the schema, never the class name above - which a bundle
                                        mangles while the extracted contract stays intact. */}
                                    {namespace.capabilities?.map((capability) => (
                                        <span key={capability} className="capability" title="implements this contract interface">
                                            {capability}
                                        </span>
                                    ))}
                                </h2>
                                {/* Observed by the page itself over its own peer link - the console
                                    relays nothing. Refreshing the description after subscribing is
                                    only so the observer count moves while you watch it. */}
                                {namespace.component && (
                                    <ComponentPanel
                                        peer={selected!}
                                        namespace={namespace.name}
                                        component={namespace.component}
                                        server={peer}
                                        onSubscribed={() => {
                                            if (service && selected) void service.describe(selected).then(setDescribed).catch(() => undefined)
                                        }}
                                    />
                                )}
                                {namespace.methods.map((method) => (
                                    <MethodPanel
                                        key={method.name}
                                        peer={selected!}
                                        namespace={namespace.name}
                                        method={method}
                                        types={description.types}
                                        service={service!}
                                        network={network}
                                    />
                                ))}
                                {namespace.events.length > 0 && (
                                    <div className="events">
                                        <h3>
                                            events
                                            {namespace.events.some((event) => !watching.has(`${selected}/${namespace.name}/${event.name}`)) && (
                                                <button className="toggle" onClick={() => void watchAll(namespace.name, namespace.events)}>
                                                    watch all
                                                </button>
                                            )}
                                        </h3>
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
                    {(['events', 'traffic', 'problems', 'presence', 'chat'] as const).map((name) => (
                        <button key={name} className={tab === name ? 'tab on' : 'tab'} onClick={() => setTab(name)}>
                            {name}
                            {name === 'traffic' && traffic.length > 0 && <span className="count">{traffic.length}</span>}
                            {name === 'problems' && trouble.length > 0 && <span className="count bad">{trouble.length}</span>}
                            {name === 'chat' && unreadTotal > 0 && <span className="count">{unreadTotal}</span>}
                        </button>
                    ))}
                </nav>

                {tab === 'chat' && <Chat peer={selected} messages={selected ? (chats[selected] ?? []) : []} onSend={sendChat} />}

                {tab === 'problems' && <Problems problems={trouble} onClear={() => setTrouble([])} />}

                {tab === 'presence' && <Presence changes={comings} onClear={() => setComings([])} />}

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
                            <div className="traffic-actions">
                                {stream.length > 0 && (
                                    <button className="toggle" onClick={() => download(stream, 'events.jsonl')} title="save what is here as jsonl">
                                        export
                                    </button>
                                )}
                                {stream.length > 0 && (
                                    <button className="toggle" onClick={() => setStream([])}>
                                        clear
                                    </button>
                                )}
                                <button className={eventsPaused ? 'toggle on' : 'toggle'} onClick={() => setEventsPaused(!eventsPaused)}>
                                    {eventsPaused ? 'paused' : 'pause'}
                                </button>
                            </div>
                        </header>
                        {stream.length > 0 && (
                            <input className="control" placeholder="filter by peer, event or payload" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} />
                        )}
                        {stream.length === 0 && <p className="muted">Watch an event to see it here.</p>}
                        {stream
                            .filter((event) => {
                                const search = eventFilter.trim().toLowerCase()
                                return !search || `${event.peer} ${event.namespace}.${event.event} ${JSON.stringify(event.args)}`.toLowerCase().includes(search)
                            })
                            .map((event, index) => (
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
