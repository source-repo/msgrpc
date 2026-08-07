import { readFileSync } from 'node:fs'
import { openAiGrants, validateAiGrants, type RpcAiGrants } from '@source-repo/rpc'

/**
 * The AI grants document, read from a file rather than assembled from flags.
 *
 * A path and not a set of options, for the reason the document exists at all: it is declarative
 * data with a revision, so that a console can render it and a reviewer can diff it. Something built
 * out of `--grant ai.tool.write --to bench --until …` would be neither - there would be nothing to
 * diff, and the revision would have nowhere to live.
 *
 * Not a secret, either, which is why it is only ever a path and never written inline in a task
 * file the way `sign` and `auth` may be. The revision field is there so policy can be replaced on
 * its own cadence; burying the document inside another file that changes for unrelated reasons
 * takes that away.
 */
export const loadAiGrants = (path: string): RpcAiGrants => {
    let document: unknown
    try {
        document = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (e) {
        throw new Error(`cannot read grants from ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    try {
        // validateAiGrants throws with the reason. A node that starts holding an unreadable security
        // policy is the failure the document exists to prevent, so this is never softened into a
        // warning: the operator meant to grant something, and carrying on with nothing granted would
        // be a quiet answer to a loud problem.
        return validateAiGrants(document)
    } catch (e) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
}

const describeEntry = (entry: { to?: string[]; roles?: string[]; expiresAt?: number; maxGeneration?: number }) => {
    const bounds = [
        entry.to?.length ? `to ${entry.to.join(', ')}` : undefined,
        entry.roles?.length ? `roles ${entry.roles.join(', ')}` : undefined,
        // Said out loud because it is the one an operator is most likely to have meant to set and
        // not set: an unbounded grant is a real choice and should not read like an oversight.
        entry.expiresAt === undefined ? 'no expiry' : `until ${new Date(entry.expiresAt).toISOString()}`,
        entry.maxGeneration === undefined ? undefined : `generation ${entry.maxGeneration}`
    ].filter(Boolean)
    return bounds.length ? bounds.join(', ') : 'every AI principal of that provenance'
}

/**
 * What this node has open, in the order a person would ask it.
 *
 * Printed at startup because closed-by-default means "it is running" and "it can do something" are
 * separately true, and an operator who has just written a grants file is entitled to see whether
 * the thing they wrote is the thing that took effect. An expired grant is simply absent here, which
 * is the honest answer and not the same as it having been removed from the file.
 */
export const grantLines = (grants: RpcAiGrants | undefined, now = Date.now()): string[] => {
    if (!grants) return ['no grants document, so AI principals may observe and nothing else']
    const open = openAiGrants(grants, now)
    if (!open.length) return [`grants revision ${grants.revision}: nothing open, so AI principals may observe and nothing else`]
    return [`grants revision ${grants.revision}:`, ...open.map(({ grant, ...entry }) => `  ${grant} — ${describeEntry(entry)}`)]
}
