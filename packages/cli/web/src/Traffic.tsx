import { useEffect, useRef, useState } from 'react'
import { ConsoleService, TappedFrame } from './types'

/**
 * What the network is carrying between other peers - the traffic this console is not part of, which
 * on a real network is most of it.
 *
 * The console decides where the watching can happen (a broker's `bus` over socket.io, its own
 * subscription over MQTT) and says which it turned on. Nothing here needs to know the difference,
 * which is the point of asking the console rather than hunting for a broker from the browser.
 *
 * Off until switched on, because it costs something at the other end: a subscription to every
 * peer's topic, or a broker building a frame per message it forwards.
 */

const KINDS = ['POST', 'SUCCESS', 'ERROR', 'EVENT'] as const

/** How many frames the page keeps. A busy plant would otherwise fill the tab until it stopped. */
const KEPT = 500

const arrowFor = (kind: string) => (kind === 'POST' ? '→' : kind === 'EVENT' ? '⇒' : '←')

/** A frame's one-line title: the method it is about, however the kind carries that. */
const subjectOf = (frame: TappedFrame) => `${frame.namespace ?? '?'}.${frame.method ?? frame.event ?? '?'}`

const payloadOf = (frame: TappedFrame) => {
    if (frame.params !== undefined) return JSON.stringify(frame.params)
    if (frame.result !== undefined) return JSON.stringify(frame.result)
    return undefined
}

export const Traffic = ({
    service,
    selected,
    frames,
    onClear,
    paused,
    onPaused,
    hidden
}: {
    service: ConsoleService | null
    selected: string | null
    frames: TappedFrame[]
    onClear: () => void
    /** Held by the page rather than here: pausing has to stop the buffer filling, not just the list. */
    paused: boolean
    onPaused: (paused: boolean) => void
    /**
     * Hidden rather than unmounted when another tab is showing. Unmounting would drop the tap, so
     * glancing at the events pane and coming back would quietly have stopped the watching - and the
     * frames that crossed while you looked away would be the ones you were waiting for.
     */
    hidden: boolean
}) => {
    const [token, setToken] = useState<string | null>(null)
    const [sources, setSources] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const [problem, setProblem] = useState<string | null>(null)
    const [payloads, setPayloads] = useState(true)
    const [onlySelected, setOnlySelected] = useState(false)
    const [kinds, setKinds] = useState<string[]>([])
    const [text, setText] = useState('')
    const [expanded, setExpanded] = useState<Set<number>>(new Set())

    // Held so the cleanup below can drop the tap without depending on the current render's token,
    // which would tear the tap down on every state change.
    const held = useRef<string | null>(null)
    useEffect(() => {
        held.current = token
    }, [token])
    useEffect(
        () => () => {
            // Leaving the page should not leave a broker mirroring frames to nobody.
            if (held.current) void service?.untap(held.current)
        },
        [service]
    )

    const start = async () => {
        if (!service) return
        setBusy(true)
        setProblem(null)
        try {
            const filter = {
                payloads,
                ...(onlySelected && selected ? { peer: selected } : {}),
                ...(kinds.length ? { kinds } : {})
            }
            const started = await service.tap(filter)
            setToken(started.token)
            setSources(started.sources)
            // A tap that turned nothing on is the interesting case: a socket.io network whose broker
            // is older than this console has no bus to ask, and silence would read as a quiet plant.
            if (!started.sources.length) setProblem('Nothing here can watch traffic: no broker exposing a bus, and no MQTT link.')
        } catch (e) {
            setProblem((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const stop = async () => {
        if (!service || !token) return
        setBusy(true)
        try {
            await service.untap(token)
        } catch {
            // It expires on its own, so there is nothing useful to say and nothing to retry.
        } finally {
            setToken(null)
            setSources([])
            setBusy(false)
        }
    }

    const toggleKind = (kind: string) => setKinds((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]))

    const search = text.trim().toLowerCase()
    const shown = frames
        .filter((frame) => !search || `${frame.source} ${frame.target} ${subjectOf(frame)} ${payloadOf(frame) ?? ''}`.toLowerCase().includes(search))
        .slice(0, KEPT)

    return (
        <div className={hidden ? 'traffic hidden' : 'traffic'}>
            <header>
                <h1>Traffic</h1>
                <div className="traffic-actions">
                    {frames.length > 0 && (
                        <button className="toggle" onClick={onClear}>
                            clear
                        </button>
                    )}
                    {token && (
                        <button className={paused ? 'toggle on' : 'toggle'} onClick={() => onPaused(!paused)}>
                            {paused ? 'paused' : 'pause'}
                        </button>
                    )}
                    <button className={token ? 'toggle on' : 'toggle'} onClick={() => void (token ? stop() : start())} disabled={busy || !service}>
                        {busy ? '…' : token ? 'tapping' : 'tap'}
                    </button>
                </div>
            </header>

            {!token && (
                <div className="tap-setup">
                    <label className="checkbox">
                        <input type="checkbox" checked={payloads} onChange={(e) => setPayloads(e.target.checked)} />
                        arguments and results
                    </label>
                    <label className="checkbox">
                        <input type="checkbox" checked={onlySelected} disabled={!selected} onChange={(e) => setOnlySelected(e.target.checked)} />
                        only {selected ?? 'the selected peer'}
                    </label>
                    <div className="kinds">
                        {KINDS.map((kind) => (
                            <button key={kind} className={kinds.includes(kind) ? 'toggle on' : 'toggle'} onClick={() => toggleKind(kind)}>
                                {kind}
                            </button>
                        ))}
                        {kinds.length === 0 && <span className="muted">all kinds</span>}
                    </div>
                    <p className="muted">
                        Watches what other peers say to each other. It costs something at the other end, so it is off until asked and stops when this tab
                        does.
                    </p>
                </div>
            )}

            {problem && <p className="bad">{problem}</p>}
            {token && sources.length > 0 && (
                <p className="muted tap-where">
                    watching via <span className="mono">{sources.join(', ')}</span>
                    {paused && ' · paused'}
                </p>
            )}

            {token && (
                <input className="control" placeholder="filter by peer, method or payload" value={text} onChange={(e) => setText(e.target.value)} />
            )}

            {token && frames.length === 0 && <p className="muted">Nothing has crossed yet.</p>}
            {shown.map((frame, index) => {
                const payload = payloadOf(frame)
                const open = expanded.has(frame.at * 1000 + index)
                const key = frame.at * 1000 + index
                return (
                    <div key={`${frame.at}-${index}`} className={`frame ${frame.kind.toLowerCase()}`}>
                        <div className="frame-head">
                            <time>{new Date(frame.at).toLocaleTimeString()}</time>
                            <span className="arrow">{arrowFor(frame.kind)}</span>
                            <span className="mono peers">
                                {frame.source} → {frame.target}
                            </span>
                            <code>{subjectOf(frame)}</code>
                            {frame.ms !== undefined && <span className="muted ms">{frame.ms} ms</span>}
                            {frame.code && <span className="code">{frame.code}</span>}
                        </div>
                        {frame.error && <p className="frame-error">{frame.error}</p>}
                        {payload && (
                            <pre
                                className={open ? 'frame-payload open' : 'frame-payload'}
                                onClick={() =>
                                    setExpanded((current) => {
                                        const next = new Set(current)
                                        if (next.has(key)) next.delete(key)
                                        else next.add(key)
                                        return next
                                    })
                                }
                            >
                                {payload}
                            </pre>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

/** The page keeps at most this many frames; exported so App trims the same way. */
export const TRAFFIC_KEPT = KEPT
