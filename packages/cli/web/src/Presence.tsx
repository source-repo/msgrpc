import { PeerChange } from './types'

/**
 * Who has come and gone.
 *
 * A peer that flaps is one of the commonest faults on a plant and the hardest to catch in the act:
 * the console showed it as a dot that changed colour and then forgot, so a device dropping every
 * thirty seconds looked exactly like one that was simply up. The console keeps the history and
 * hands it over when a page connects, so opening the console after the trouble still shows it.
 */

/** How many times a peer has to come back before its coming back is the interesting part. */
const FLAPPING = 3

export const Presence = ({ changes, onClear }: { changes: PeerChange[]; onClear: () => void }) => {
    // Counted over what is held rather than over all time: the buffer is the window, and a peer
    // that appears in it repeatedly is doing so recently.
    const arrivals = new Map<string, number>()
    for (const change of changes) if (change.state === 'online') arrivals.set(change.peer, (arrivals.get(change.peer) ?? 0) + 1)
    const flapping = [...arrivals.entries()].filter(([, count]) => count >= FLAPPING).sort((a, b) => b[1] - a[1])

    return (
        <div className="presence">
            <header>
                <h1>Presence</h1>
                {changes.length > 0 && (
                    <button className="toggle" onClick={onClear}>
                        clear
                    </button>
                )}
            </header>

            {flapping.length > 0 && (
                <div className="flapping">
                    {flapping.map(([peer, count]) => (
                        <p key={peer}>
                            <span className="mono">{peer}</span> has arrived {count} times
                        </p>
                    ))}
                </div>
            )}

            {changes.length === 0 && <p className="muted">Nobody has arrived or left since this console started.</p>}
            {changes.map((change, index) => (
                <div key={`${change.at}-${index}`} className={`coming ${change.state}`}>
                    <time>{new Date(change.at).toLocaleTimeString()}</time>
                    <span className="mark">{change.state === 'online' ? '+' : '−'}</span>
                    <span className="mono">{change.peer}</span>
                    {change.link && change.link !== 'this console' && <span className="muted link">{change.link}</span>}
                </div>
            ))}
        </div>
    )
}
