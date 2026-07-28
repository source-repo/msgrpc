import { readableNameFrom } from '@source-repo/msgrpc'

/**
 * The name this page answers to on the network.
 *
 * Derived from the console it is attached to, so a reload comes back as the same peer rather than
 * leaving a stranger in everyone's list, and pages on different consoles are plainly different.
 *
 * Two tabs on one console cannot share it. A peer name is an address: both would announce it, and a
 * call would reach whichever one the network last heard from - which looks like chat messages going
 * missing rather than like a name collision. So the second tab gets a suffix.
 *
 * Deciding which tab is the second one is the part that needs care. sessionStorage cannot answer it:
 * every tab has its own, so each one reads an empty store and concludes it is the first. The claim
 * has to live in localStorage, which every tab on the origin shares.
 */

const CLAIM = 'msgrpc-primary'
const TAB = 'msgrpc-tab'
/** How long a claim outlives its last heartbeat. A closed tab's name is free again after this. */
const CLAIM_TTL = 15000

interface Claim {
    tab: string
    at: number
}

/** Stable for the life of this tab, and kept across its reloads. */
const tabId = () => {
    let tab = sessionStorage.getItem(TAB)
    if (!tab) sessionStorage.setItem(TAB, (tab = Math.random().toString(36).slice(2, 6)))
    return tab
}

const readClaim = (): Claim | null => {
    try {
        const held = JSON.parse(localStorage.getItem(CLAIM) ?? 'null') as Claim | null
        return held && typeof held.tab === 'string' && typeof held.at === 'number' ? held : null
    } catch {
        // Someone else's key, or storage that is unavailable. Behave as if unclaimed.
        return null
    }
}

const writeClaim = (tab: string) => {
    try {
        localStorage.setItem(CLAIM, JSON.stringify({ tab, at: Date.now() } satisfies Claim))
    } catch {
        // Private browsing, or a full quota. The page still works; it just cannot hold the name.
    }
}

/**
 * Takes the unsuffixed name when no live tab holds it.
 *
 * The write-wait-reread settles two tabs opening at the same moment: both see the name free and
 * both write, but the later write wins and the earlier tab reads back someone else's id and yields.
 * Exactly one ends up primary either way.
 */
const claimPrimary = async (tab: string) => {
    const held = readClaim()
    if (held && held.tab !== tab && Date.now() - held.at < CLAIM_TTL) return false
    writeClaim(tab)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return readClaim()?.tab === tab
}

/**
 * Resolves to the name to announce, and a release to call when the page is done with it. Holding
 * the plain name means keeping the claim warm, so a tab that closes stops defending it.
 */
export const claimPeerName = async (host: string): Promise<{ name: string; release: () => void }> => {
    const tab = tabId()
    const base = readableNameFrom(host)
    if (!(await claimPrimary(tab))) return { name: `${base}-${tab}`, release: () => {} }

    const beat = setInterval(() => writeClaim(tab), CLAIM_TTL / 3)
    const release = () => {
        clearInterval(beat)
        // Frees the name now rather than after the TTL. React unmount does not run when a tab is
        // closed, which is exactly when the name should come free, so pagehide carries it instead.
        if (readClaim()?.tab === tab) localStorage.removeItem(CLAIM)
    }
    window.addEventListener('pagehide', release)
    return {
        name: base,
        release: () => {
            window.removeEventListener('pagehide', release)
            release()
        }
    }
}
