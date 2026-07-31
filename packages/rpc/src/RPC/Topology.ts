import { v4 as uuidv4 } from 'uuid'

/**
 * The topology core, federated: each host is the sole writer of its own components' outgoing
 * `parent` and `owner` edges, holds them with a version and per-link epochs, and mutates them
 * under compare-and-set. There is no plant-wide authority in this profile - the coordinated
 * TopologyAuthority of the adopted spec is a deferred adapter contract - and what that buys is
 * additivity: a host that declares nothing has a synthetic root and is done.
 *
 * `parent` is physical location, `owner` is logical scope, and identity depends on neither: a ref
 * is peer + instance, stable across reparenting, and paths are derived display data - never wire
 * addresses, never foreign keys. Ids address, labels display.
 */

export interface RpcRef {
    peer: string
    instance: string
}

export const sameRef = (a: RpcRef | null | undefined, b: RpcRef | null | undefined) => !!a && !!b && a.peer === b.peer && a.instance === b.instance

export interface RpcTopologyVersion {
    epoch: string
    revision: number
}

export interface RpcTopologyRecord {
    readonly ref: RpcRef
    /** Physical location. Local by invariant for everything but the host root. */
    readonly parent: RpcRef | null
    /** Logical scope. May reference any component anywhere. */
    readonly owner: RpcRef | null
    /** Changes whenever the parent link changes. */
    readonly parentEpoch: string
    /** Changes on every committed owner mutation - A to B and back is two new generations. */
    readonly ownerEpoch: string
    readonly version: RpcTopologyVersion
    /** Display only: free text from the project's own drawings, never unique, never an address. */
    readonly label?: string
}

/**
 * What a traversal found. A cycle is *detected invalid topology*, never tolerated topology: the
 * federated profile cannot prevent a cross-host cycle at commit, so the walk names it instead,
 * with the path - and anything authorization-shaped that depends on topology fails closed on it.
 */
export type RpcTopologyValidity =
    | { status: 'valid' }
    | { status: 'unresolved'; at: RpcRef }
    | { status: 'cycle'; path: RpcRef[] }
    | { status: 'depth-exceeded'; maxDepth: number }

/**
 * Which guarantees this host's topology actually offers, stated rather than implied - no
 * implementation may silently promise another's strength. Surfaced through describe().
 */
export interface RpcTopologyCapabilities {
    authorityScope: 'host'
    cycleGuarantee: 'detected'
    reverseIndex: 'eventual'
    deletion: 'tombstone'
    durability: 'volatile' | 'durable'
}

/**
 * Where a host keeps its records. Durable stores reload them on restart with every epoch intact -
 * a restart must never rotate an epoch, or every standing fence in the plant breaks at reboot.
 * The whole host is saved at once: a host has few records, and one atomic write is the version
 * whose correctness needs no argument.
 */
export interface TopologyStore {
    readonly durable: boolean
    load(): Promise<RpcTopologyRecord[] | undefined>
    save(records: RpcTopologyRecord[]): Promise<void>
}

/** The default store: nothing survives, and the capabilities record says so out loud. */
export class MemoryTopologyStore implements TopologyStore {
    readonly durable = false
    async load(): Promise<RpcTopologyRecord[] | undefined> {
        return undefined
    }
    async save(): Promise<void> {}
}

/** The synthetic root's reserved instance id - the `$` prefix marks it the library's, like $with. */
export const HOST_ROOT = '$host'

/** A legitimate but excessively deep plant is distinguishable from a cycle only by a visited set. */
const MAX_DEPTH = 128

/**
 * Control characters are refused in every id at the boundary. NUL is this library's reserved
 * separator precisely because no id can contain it - this is where that stops being convention.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is this regex's entire job
const CONTROL = /[\u0000-\u001f\u007f]/
const assertId = (value: string, what: string) => {
    if (!value) throw new Error(`topology: ${what} is empty`)
    if (CONTROL.test(value)) throw new Error(`topology: ${what} contains a control character, and ids never do`)
}

const assertLabel = (label: string | undefined) => {
    // Labels are free Unicode - `.,/[]()åäöÅÄÖ` and whatever the drawings say - but control
    // characters are display sabotage, not display.
    if (label !== undefined && CONTROL.test(label)) throw new Error('topology: a label contains a control character')
}

export interface RpcTopologyPatch {
    /** `undefined` means unchanged; `null` means detached. */
    parent?: RpcRef | null
    owner?: RpcRef | null
    label?: string
}

export interface RpcTopologyMutation {
    expectedVersion: RpcTopologyVersion
    reason?: string
}

/** The external-store shape the component channel already proved against useSyncExternalStore. */
export interface RpcTopologyExternalStore {
    getSnapshot(): RpcTopologyRecord | undefined
    subscribe(listener: () => void): () => void
}

export interface HostTopologyOptions {
    /** The host's declared physical place: a sequence of ids from the deployment, not the code. */
    place?: string[]
    label?: string
    store?: TopologyStore
}

export class HostTopology {
    private readonly records = new Map<string, RpcTopologyRecord>()
    private readonly listeners = new Map<string, Set<() => void>>()
    private readonly store: TopologyStore
    private loaded = false

    constructor(
        public readonly peer: string,
        private readonly options: HostTopologyOptions = {}
    ) {
        for (const segment of options.place ?? []) assertId(segment, `place segment '${segment}'`)
        assertLabel(options.label)
        this.store = options.store ?? new MemoryTopologyStore()
    }

    /**
     * Load or create the host's records. Durable records are adopted whole - epochs included,
     * which is the point of having them - and a fenced method elsewhere must not trust this
     * host's topology until this has completed, which is why the server awaits it in ready().
     */
    async init() {
        const restored = await this.store.load()
        if (restored) for (const record of restored) this.records.set(record.ref.instance, record)
        if (!this.records.has(HOST_ROOT))
            this.records.set(HOST_ROOT, {
                ref: { peer: this.peer, instance: HOST_ROOT },
                parent: null,
                owner: null,
                parentEpoch: uuidv4(),
                ownerEpoch: uuidv4(),
                version: { epoch: uuidv4(), revision: 0 },
                ...(this.options.label !== undefined ? { label: this.options.label } : {})
            })
        this.loaded = true
        await this.persist()
    }

    ref(instance: string): RpcRef {
        return { peer: this.peer, instance }
    }

    get(instance: string): RpcTopologyRecord | undefined {
        return this.records.get(instance)
    }

    /** Every record this host answers for, root included - what describe() reads. */
    all(): RpcTopologyRecord[] {
        return [...this.records.values()]
    }

    get place(): string[] | undefined {
        return this.options.place
    }

    capabilities(): RpcTopologyCapabilities {
        return {
            authorityScope: 'host',
            cycleGuarantee: 'detected',
            reverseIndex: 'eventual',
            deletion: 'tombstone',
            durability: this.store.durable ? 'durable' : 'volatile'
        }
    }

    /**
     * Declare a component's topology, once, by the code that stands the node up. Changing it
     * afterwards is update(), which demands the expected version - declaration is not mutation,
     * and letting a redeclaration silently rewrite edges would be CAS with the check filed off.
     */
    async declare(instance: string, links: { parent?: RpcRef | null; owner?: RpcRef | null; label?: string } = {}): Promise<RpcTopologyRecord> {
        this.assertLoaded()
        assertId(instance, `instance '${instance}'`)
        if (instance === HOST_ROOT) throw new Error(`topology: ${HOST_ROOT} is the synthetic root - set its links with updateHost()`)
        if (this.records.has(instance)) throw new Error(`topology: ${instance} is already declared - changes go through update() with the expected version`)
        assertLabel(links.label)
        const parent = links.parent === undefined ? this.ref(HOST_ROOT) : links.parent
        this.checkParent(instance, parent)
        this.checkOwner(instance, links.owner ?? null)
        const record: RpcTopologyRecord = {
            ref: this.ref(instance),
            parent,
            owner: links.owner ?? null,
            parentEpoch: uuidv4(),
            ownerEpoch: uuidv4(),
            version: { epoch: uuidv4(), revision: 0 },
            ...(links.label !== undefined ? { label: links.label } : {})
        }
        this.records.set(instance, record)
        await this.persist()
        this.notify(instance)
        return record
    }

    /** Change a declared component's links under compare-and-set. Every patched link rotates its epoch. */
    async update(instance: string, patch: RpcTopologyPatch, mutation: RpcTopologyMutation): Promise<RpcTopologyRecord> {
        this.assertLoaded()
        const current = this.records.get(instance)
        if (!current) throw new Error(`topology: ${instance} is not declared here`)
        if (current.version.epoch !== mutation.expectedVersion.epoch || current.version.revision !== mutation.expectedVersion.revision)
            throw new Error(`topology: ${instance} is at revision ${current.version.revision}, not ${mutation.expectedVersion.revision} - read it again and decide again`)
        assertLabel(patch.label)
        if (patch.parent !== undefined) {
            if (instance === HOST_ROOT) this.checkRootParent(patch.parent)
            else this.checkParent(instance, patch.parent)
        }
        if (patch.owner !== undefined) this.checkOwner(instance, patch.owner)
        const next: RpcTopologyRecord = {
            ...current,
            ...(patch.parent !== undefined ? { parent: patch.parent, parentEpoch: uuidv4() } : {}),
            // Rotated on every committed owner patch, same value or not: A to B and back to A is
            // two new generations, and a delayed command from the first A-era must stay dead.
            ...(patch.owner !== undefined ? { owner: patch.owner, ownerEpoch: uuidv4() } : {}),
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            version: { epoch: current.version.epoch, revision: current.version.revision + 1 }
        }
        this.records.set(instance, next)
        await this.persist()
        this.notify(instance)
        return next
    }

    /** The host root's links: its parent is the one permitted cross-host physical edge. */
    async updateHost(patch: RpcTopologyPatch, mutation: RpcTopologyMutation): Promise<RpcTopologyRecord> {
        return this.update(HOST_ROOT, patch, mutation)
    }

    /**
     * A non-root component's parent stays on this host - the invariant that keeps the physical
     * graph almost entirely host-local - and a local physical cycle is refused at commit, because
     * a single writer over local records can afford prevention where the cross-host graph cannot.
     */
    private checkParent(instance: string, parent: RpcRef | null) {
        if (parent === null) return
        assertId(parent.peer, 'parent peer')
        assertId(parent.instance, 'parent instance')
        if (parent.peer !== this.peer) throw new Error(`topology: ${instance} cannot have a remote physical parent - only the ${HOST_ROOT} root may, root to root`)
        if (parent.instance === instance) throw new Error(`topology: ${instance} cannot be its own parent`)
        const visited = new Set<string>([instance])
        let at: string | undefined = parent.instance
        while (at !== undefined) {
            if (visited.has(at)) throw new Error(`topology: parenting ${instance} under ${parent.instance} closes a physical cycle`)
            visited.add(at)
            const record: RpcTopologyRecord | undefined = this.records.get(at)
            at = record?.parent && record.parent.peer === this.peer ? record.parent.instance : undefined
        }
    }

    private checkRootParent(parent: RpcRef | null) {
        if (parent === null) return
        assertId(parent.peer, 'parent peer')
        assertId(parent.instance, 'parent instance')
        if (parent.peer === this.peer) throw new Error(`topology: the ${HOST_ROOT} root's parent is another host's root, not something on this host`)
        if (parent.instance !== HOST_ROOT) throw new Error(`topology: a host root's parent must be another host root - physical edges cross hosts only root to root`)
    }

    private checkOwner(instance: string, owner: RpcRef | null) {
        if (owner === null) return
        assertId(owner.peer, 'owner peer')
        assertId(owner.instance, 'owner instance')
        if (owner.peer === this.peer && owner.instance === instance) throw new Error(`topology: ${instance} cannot own itself`)
        // No cycle check: the owner may be anywhere, and the federated profile detects owner
        // cycles at derivation with a named path rather than pretending to prevent them here.
    }

    /**
     * The physical path as display segments, rooted at the host's declared place - or its peer id
     * when none was declared, so an undeclared host still reads as somewhere.
     */
    physicalPath(instance: string): { segments: string[]; validity: RpcTopologyValidity } {
        const root = this.options.place ?? [this.peer]
        const segments: string[] = []
        const visited = new Set<string>()
        let at: string | undefined = instance
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            if (at === undefined) return { segments, validity: { status: 'valid' } }
            if (at === HOST_ROOT) return { segments: [...root, ...segments], validity: { status: 'valid' } }
            if (visited.has(at)) return { segments, validity: { status: 'cycle', path: [...visited].map((name) => this.ref(name)) } }
            visited.add(at)
            const record: RpcTopologyRecord | undefined = this.records.get(at)
            if (!record) return { segments, validity: { status: 'unresolved', at: this.ref(at) } }
            segments.unshift(at)
            at = record.parent === null ? undefined : record.parent.peer === this.peer ? record.parent.instance : HOST_ROOT
        }
        return { segments, validity: { status: 'depth-exceeded', maxDepth: MAX_DEPTH } }
    }

    /**
     * The owner chain as far as this host can see it: local refs walked, a remote owner returned
     * as the continuation for whoever holds that host's records. The logical path defaults to
     * this chain; overriding a *displayed* path elsewhere never reparents ownership.
     */
    ownerChain(instance: string): { chain: RpcRef[]; continuesAt?: RpcRef; validity: RpcTopologyValidity } {
        const chain: RpcRef[] = []
        const visited = new Set<string>()
        let at: string | undefined = instance
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            if (at === undefined) return { chain, validity: { status: 'valid' } }
            if (visited.has(at)) return { chain, validity: { status: 'cycle', path: chain.slice(chain.findIndex((ref) => ref.instance === at)) } }
            visited.add(at)
            const record: RpcTopologyRecord | undefined = this.records.get(at)
            if (!record) return { chain, validity: { status: 'unresolved', at: this.ref(at) } }
            chain.push(record.ref)
            if (record.owner === null) return { chain, validity: { status: 'valid' } }
            if (record.owner.peer !== this.peer) return { chain, continuesAt: record.owner, validity: { status: 'valid' } }
            at = record.owner.instance
        }
        return { chain, validity: { status: 'depth-exceeded', maxDepth: MAX_DEPTH } }
    }

    /** A live view of one record, in the store shape useSyncExternalStore consumes directly. */
    externalStore(instance: string): RpcTopologyExternalStore {
        return {
            getSnapshot: () => this.records.get(instance),
            subscribe: (listener) => {
                let held = this.listeners.get(instance)
                if (!held) this.listeners.set(instance, (held = new Set()))
                held.add(listener)
                return () => held.delete(listener)
            }
        }
    }

    private notify(instance: string) {
        for (const listener of [...(this.listeners.get(instance) ?? [])]) {
            try {
                listener()
            } catch {
                // A subscriber's bug is not the topology's failure to report.
            }
        }
    }

    private assertLoaded() {
        // Records may be durable and not yet read. Mutating before load would fork the store's
        // truth; a fence checked before load would trust epochs that are about to be replaced.
        if (!this.loaded) throw new Error('topology: not loaded yet - await the server ready()')
    }

    /**
     * Acknowledged only after the store has the whole committed state - the normative durability
     * rule: a mutation that answered before persisting is a fence that a power cut un-fences.
     */
    private async persist() {
        await this.store.save(this.all())
    }
}
