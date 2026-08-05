import type { DescribedNamespace, DescribedRef, ServerDescription } from './types'
import { namespaceDisplayName } from './displayName'

/**
 * The two structures, drawn from what describe() carries: the physical tree from the parent refs,
 * rooted at the host's declared place, and each node's logical owner beside it. Paths are derived
 * right here - refs and epochs travel, display is assembled at the point of display, which is the
 * whole of the "paths are derived data" rule.
 *
 * An owner on another peer renders as a link that selects that peer: the console's way of walking
 * a chain it only holds one host of.
 */

const refText = (ref: DescribedRef, home: string) => (ref.peer === home ? ref.instance : `${ref.peer}/${ref.instance}`)

const OwnerChip = ({ owner, home, peers, onSelectPeer }: { owner: DescribedRef; home: string; peers: string[]; onSelectPeer: (peer: string) => void }) => {
    const elsewhere = owner.peer !== home && peers.includes(owner.peer)
    return elsewhere ? (
        <button className="owner-chip link" onClick={() => onSelectPeer(owner.peer)} title={`owned by ${owner.peer}/${owner.instance} - select that peer`}>
            ⤳ {refText(owner, home)}
        </button>
    ) : (
        <span className="owner-chip" title="logical owner">
            ⤳ {refText(owner, home)}
        </span>
    )
}

const Node = ({
    namespace,
    childrenOf,
    home,
    peers,
    onSelectPeer
}: {
    namespace: DescribedNamespace
    childrenOf: (parent: string) => DescribedNamespace[]
    home: string
    peers: string[]
    onSelectPeer: (peer: string) => void
}) => (
    <li>
        <span className="node">
            <span className="entity-title compact">
                <span>{namespaceDisplayName(namespace)}</span>
                <span className="entity-id mono">{namespace.name}</span>
            </span>
            {namespace.topology?.owner && <OwnerChip owner={namespace.topology.owner} home={home} peers={peers} onSelectPeer={onSelectPeer} />}
        </span>
        {childrenOf(namespace.name).length > 0 && (
            <ul>
                {childrenOf(namespace.name).map((child) => (
                    <Node key={child.name} namespace={child} childrenOf={childrenOf} home={home} peers={peers} onSelectPeer={onSelectPeer} />
                ))}
            </ul>
        )}
    </li>
)

export const StructurePanel = ({ description, peers, onSelectPeer }: { description: ServerDescription; peers: string[]; onSelectPeer: (peer: string) => void }) => {
    const home = description.name
    const placed = description.namespaces.filter((namespace) => namespace.topology)
    if (!description.host && placed.length === 0) return null

    // Children keyed by the parent's instance id. The host prevents local physical cycles at
    // commit, so this cannot recurse forever - but records restored from an older store are
    // somebody else's promise, and the guard costs one Set.
    const seen = new Set<string>()
    const childrenOf = (parent: string) => {
        if (seen.has(parent)) return []
        seen.add(parent)
        return placed.filter((namespace) => namespace.topology!.parent?.instance === parent && namespace.topology!.parent?.peer === home)
    }

    const roots = placed.filter((namespace) => namespace.topology!.parent === null || namespace.topology!.parent.instance === '$host')
    const place = description.host?.place?.join(' / ') ?? home
    return (
        <div className="structure">
            <div className="structure-head">
                <span className="comp-label">structure</span>
                <span className="mono">{place}</span>
                {description.host?.label && <span className="node-label">{description.host.label}</span>}
                {description.host?.parent && (
                    <span className="muted">
                        attached under{' '}
                        {peers.includes(description.host.parent.peer) ? (
                            <button className="owner-chip link" onClick={() => onSelectPeer(description.host!.parent!.peer)}>
                                {description.host.parent.peer}
                            </button>
                        ) : (
                            <span className="mono">{description.host.parent.peer}</span>
                        )}
                    </span>
                )}
                {description.host && (
                    <span className="muted" title="which topology guarantees this host actually offers">
                        {description.host.capabilities.durability} · cycles {description.host.capabilities.cycleGuarantee}
                    </span>
                )}
            </div>
            {roots.length === 0 && <p className="muted">Nothing declares a place on this host yet.</p>}
            {roots.length > 0 && (
                <ul className="tree">
                    {roots.map((namespace) => (
                        <Node key={namespace.name} namespace={namespace} childrenOf={childrenOf} home={home} peers={peers} onSelectPeer={onSelectPeer} />
                    ))}
                </ul>
            )}
        </div>
    )
}
