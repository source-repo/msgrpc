import { readableNameFor } from '@source-repo/rpc'

/**
 * The name this page answers to on the network.
 *
 * Random, because a peer name is an address and anything derived from the URL collides by
 * construction: every browser pointed at one console derives the same name, and then two pages
 * answer to it and each other's replies go to whichever the console registered last. That is not
 * something the page can detect - localStorage is per profile, so it cannot see the other browser.
 *
 * Kept in sessionStorage, which is per tab and survives its reloads: a reload comes back as the
 * same peer rather than leaving a stranger in everyone's list, and a second tab is simply a
 * different peer with a different name.
 *
 * `?name=` overrides it, the page's version of the CLI's --name, for when a page should be
 * recognisable in a peer list rather than merely unique.
 */

const NAME = 'msgrpc-page-name'

export const pageName = () => {
    const asked = new URLSearchParams(window.location.search).get('name')?.trim()
    if (asked) return asked
    let name = sessionStorage.getItem(NAME)
    if (!name) sessionStorage.setItem(NAME, (name = readableNameFor('page')))
    return name
}
