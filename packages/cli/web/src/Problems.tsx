import { NetworkProblem } from './types'

/**
 * What has gone wrong on the console's links.
 *
 * The transports have always emitted these four and nothing ever listened, so a call that never
 * came back looked the same as a network with nothing on it. Between them they cover every way an
 * answer fails to arrive: a frame refused before the RPC layer, one with nowhere to go, a name two
 * peers are both answering to, and a link that failed underneath.
 *
 * Unlike the traffic tap there is nothing to switch on. These cost nothing when nothing is wrong,
 * and the ones worth reading are usually from before anyone thought to look - so the console keeps
 * a bounded history and hands it over when the page asks.
 */

/** What each kind actually means for whoever is looking at a call that did not come back. */
const MEANING: { [kind: string]: string } = {
    rejected: 'refused before it reached the RPC layer',
    unroutable: 'nowhere to deliver it',
    peerDisplaced: 'two peers are answering to one name',
    transportError: 'the link itself failed'
}

export const Problems = ({ problems, onClear }: { problems: NetworkProblem[]; onClear: () => void }) => (
    <div className="problems">
        <header>
            <h1>Problems</h1>
            {problems.length > 0 && (
                <button className="toggle" onClick={onClear}>
                    clear
                </button>
            )}
        </header>
        {problems.length === 0 && (
            <p className="muted">
                Nothing refused, undeliverable or displaced. This is where a call that never comes back says why.
            </p>
        )}
        {problems.map((problem, index) => (
            <div key={`${problem.at}-${index}`} className={`problem ${problem.kind}`}>
                <div className="problem-head">
                    <time>{new Date(problem.at).toLocaleTimeString()}</time>
                    <span className="kind">{problem.kind}</span>
                    <span className="muted link">on {problem.link}</span>
                </div>
                <div className="problem-body">
                    {problem.peer && (
                        <code className="mono">
                            {problem.peer}
                            {problem.target ? ` → ${problem.target}` : ''}
                        </code>
                    )}
                    <p>{problem.reason ?? MEANING[problem.kind] ?? ''}</p>
                </div>
            </div>
        ))}
    </div>
)
