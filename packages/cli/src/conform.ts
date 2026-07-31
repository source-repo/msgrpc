import { SCHEMA_VERSION, namespaceProblems, type Incompatibility, type NamespaceSchema, type RpcSchema, type ServerDescription } from '@source-repo/rpc'
import { awaitPeer, connectNetwork, type ConnectedNetwork, type NetworkOptions } from './network.js'
import { signatureOf } from './verbs.js'

/**
 * Checking a device rather than a build.
 *
 * `check` compares source against a stored contract, which catches a change before it ships. What it
 * cannot answer is the question asked on site: the contract says this device offers
 * `writeSetpoint(value, mode?)` - is that what the box on the wall is actually running? A peer that
 * describes itself can be asked, and the answer runs through the same comparison the server applies
 * to a caller declaring an older version, so a device behind its own contract is reported in exactly
 * the words a stale caller would have been.
 */

/** The one namespace nobody's own contract covers; every server that describes itself has it. */
const INTROSPECTION = 'msgrpc'

/**
 * A live peer's self-description as a schema the compatibility check can read.
 *
 * The two are nearly the same information in different shapes - describe() returns lists because a
 * console renders them in order, a schema uses dictionaries because dispatch looks methods up by
 * name.
 */
export const schemaFromDescription = (description: ServerDescription): RpcSchema => ({
    schema: SCHEMA_VERSION,
    ...(description.version ? { version: description.version } : {}),
    types: description.types ?? {},
    namespaces: Object.fromEntries(
        description.namespaces.map((namespace) => [
            namespace.name,
            {
                ...(namespace.version ? { version: namespace.version } : {}),
                methods: Object.fromEntries(
                    namespace.methods.map((method) => [
                        method.name,
                        {
                            params: method.params ?? [],
                            ...(method.paramNames ? { paramNames: method.paramNames } : {}),
                            ...(method.rest ? { rest: method.rest } : {}),
                            ...(method.returns ? { returns: method.returns } : {})
                        }
                    ])
                ),
                events: Object.fromEntries(namespace.events.map((event) => [event.name, { params: event.params ?? [] }]))
            } satisfies NamespaceSchema
        ])
    )
})

/** Whether a peer publishes enough of a contract for a comparison to mean anything. */
const describesItsMethods = (namespace: ServerDescription['namespaces'][number]) =>
    namespace.methods.length === 0 || namespace.methods.some((method) => !!method.params)

export interface ConformanceProblem extends Incompatibility {
    namespace: string
}

export interface ConformanceReport {
    peer: string
    /** True when the peer serves its methods without a published contract, so nothing was compared. */
    undescribed: string[]
    problems: ConformanceProblem[]
    /** Namespaces the stored contract has and the peer does not serve at all. */
    missing: string[]
    checked: string[]
}

const describe = async (connected: ConnectedNetwork, peer: string) => {
    const proxy = await connected.network.proxy<{ describe(): Promise<ServerDescription> }>(INTROSPECTION, peer)
    return await proxy.describe()
}

/**
 * Compares what a peer says it serves with the contract callers were built against.
 *
 * The stored contract is the caller's side and the device is the current side, which is the same
 * orientation `check` uses against source - so "argument 0 narrowed" means the same thing here as
 * it does in CI, and means it about the box rather than the branch.
 */
export const checkPeerOn = async (connected: ConnectedNetwork, options: { peer: string; stored: RpcSchema; wait?: number }): Promise<ConformanceReport> => {
    {
        if (!(await awaitPeer(connected, options.peer, options.wait ?? 5000)))
            throw Object.assign(new Error(`${options.peer} did not appear within ${options.wait ?? 5000} ms`), { code: 'ClassNotFound' })
        const description = await describe(connected, options.peer)
        const live = schemaFromDescription(description)
        const types = { ...options.stored.types, ...live.types }

        const report: ConformanceReport = { peer: options.peer, undescribed: [], problems: [], missing: [], checked: [] }
        for (const [name, stored] of Object.entries(options.stored.namespaces)) {
            if (name === INTROSPECTION) continue
            const served = description.namespaces.find((namespace) => namespace.name === name)
            if (!served) {
                report.missing.push(name)
                continue
            }
            // A peer running without a schema describes its method names and nothing else. Comparing
            // that would report every argument as removed, which is a statement about the peer's
            // configuration rather than about its contract - so it is said plainly instead.
            if (!describesItsMethods(served)) {
                report.undescribed.push(name)
                continue
            }
            report.checked.push(name)
            report.problems.push(...namespaceProblems(stored, live.namespaces[name], types).map((problem) => ({ ...problem, namespace: name })))
        }
        return report
    }
}

/** The same, opening a connection of its own - what the command line wants. */
export const checkPeer = async (options: NetworkOptions & { peer: string; stored: RpcSchema; wait?: number }): Promise<ConformanceReport> => {
    const connected = await connectNetwork(options)
    try {
        return await checkPeerOn(connected, options)
    } finally {
        await connected.close()
    }
}

export interface PeerDifference {
    namespace: string
    /** The method or event, or undefined when a whole namespace is on one side only. */
    member?: string
    /** How it reads on each side; absent means it is not there at all. */
    left?: string
    right?: string
}

/**
 * What two live peers offer differently - the "why does cell 3 behave differently from cell 2"
 * question, which is usually answered by one of them running last season's firmware.
 *
 * Signatures are compared as they read rather than structurally, because the answer is going to be
 * read by a person standing in front of two cabinets.
 */
export const diffPeersOn = async (connected: ConnectedNetwork, options: { left: string; right: string; wait?: number }) => {
    {
        for (const peer of [options.left, options.right])
            if (!(await awaitPeer(connected, peer, options.wait ?? 5000)))
                throw Object.assign(new Error(`${peer} did not appear within ${options.wait ?? 5000} ms`), { code: 'ClassNotFound' })

        const [left, right] = await Promise.all([describe(connected, options.left), describe(connected, options.right)])
        const differences: PeerDifference[] = []

        const namespaces = [...new Set([...left.namespaces.map((n) => n.name), ...right.namespaces.map((n) => n.name)])].sort()
        for (const name of namespaces) {
            if (name === INTROSPECTION) continue
            const here = left.namespaces.find((namespace) => namespace.name === name)
            const there = right.namespaces.find((namespace) => namespace.name === name)
            if (!here || !there) {
                differences.push({ namespace: name, ...(here ? { left: 'served' } : {}), ...(there ? { right: 'served' } : {}) })
                continue
            }
            if (here.version !== there.version)
                differences.push({ namespace: name, member: 'contract version', left: here.version ?? 'none', right: there.version ?? 'none' })

            const members = [...new Set([...here.methods.map((m) => m.name), ...there.methods.map((m) => m.name)])].sort()
            for (const member of members) {
                const a = here.methods.find((method) => method.name === member)
                const b = there.methods.find((method) => method.name === member)
                const one = a ? signatureOf(a) : undefined
                const other = b ? signatureOf(b) : undefined
                if (one !== other) differences.push({ namespace: name, member, ...(one ? { left: one } : {}), ...(other ? { right: other } : {}) })
            }

            const events = [...new Set([...here.events.map((e) => e.name), ...there.events.map((e) => e.name)])].sort()
            for (const event of events) {
                const a = here.events.some((entry) => entry.name === event)
                const b = there.events.some((entry) => entry.name === event)
                if (a !== b) differences.push({ namespace: name, member: `event ${event}`, ...(a ? { left: 'emitted' } : {}), ...(b ? { right: 'emitted' } : {}) })
            }
        }

        return { left: options.left, right: options.right, differences }
    }
}

/** The same, opening a connection of its own - what the command line wants. */
export const diffPeers = async (options: NetworkOptions & { left: string; right: string; wait?: number }) => {
    const connected = await connectNetwork(options)
    try {
        return await diffPeersOn(connected, options)
    } finally {
        await connected.close()
    }
}
