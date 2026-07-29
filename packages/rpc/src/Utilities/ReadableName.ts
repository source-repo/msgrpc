import { wordlist } from '@scure/bip39/wordlists/english.js'

/**
 * Names a peer can be read out over a radio.
 *
 * A peer name is not decoration: it is what a caller addresses, what presence lists, what a log
 * line blames and, over MQTT, the broker's client id. A UUID satisfies none of that - two of them
 * in a peer list are indistinguishable at a glance, and nobody types one correctly.
 *
 * The words come from the BIP-39 English list, which is the useful part of that specification here:
 * 2048 words chosen to be unambiguous in their first four letters, with no pairs that sound alike.
 * The rest of BIP-39 - 128 to 256 bits of entropy with a checksum - is for seed phrases and does
 * not apply; three words is 2048^3, about 8.6 billion, which is ample for naming peers on a bus and
 * short enough to say out loud.
 *
 * Hyphenated rather than spaced, so a name is a single MQTT topic segment and survives a log line,
 * a URL and a shell argument unquoted.
 */

/** Words available. Exported so a caller sizing its own name space does not have to guess. */
export const readableWordCount = wordlist.length

const randomIndexes = (count: number) => {
    // WebCrypto rather than Math.random: available in Node and the browser, and a name that
    // collides is a peer that cannot be addressed.
    const values = new Uint32Array(count)
    crypto.getRandomValues(values)
    // Rejection-free and unbiased enough: 2^32 is a whole multiple of 2048.
    return [...values].map((value) => value % wordlist.length)
}

/**
 * A fresh name, three words by default. Two would be 4 million, which starts to collide on a busy
 * bus; four is not noticeably safer and is longer to say.
 */
export const readableName = (words = 3) => randomIndexes(words).map((index) => wordlist[index]).join('-')

/**
 * The same, with a prefix saying what the peer is: `console-brisk-otter-cable`. Names are what a
 * peer list shows, and a role is worth more there than another word of entropy.
 */
export const readableNameFor = (role: string, words = 3) => `${role}-${readableName(words)}`

/**
 * The same name every time for the same seed. A peer that wants to be recognisable across restarts
 * - a page identified by the console it is attached to, say - derives its name instead of drawing
 * one, and the network sees the same peer come back rather than a stranger.
 *
 * FNV-1a per word, which is not a cryptographic hash and does not need to be: this decides what to
 * call something, and a caller wanting unguessable names should be drawing them at random anyway.
 */
export const readableNameFrom = (seed: string, words = 3) => {
    const chosen: string[] = []
    for (let word = 0; word < words; word++) {
        let hash = 0x811c9dc5 ^ word
        for (let index = 0; index < seed.length; index++) {
            hash ^= seed.charCodeAt(index)
            hash = Math.imul(hash, 0x01000193) >>> 0
        }
        chosen.push(wordlist[hash % wordlist.length])
    }
    return chosen.join('-')
}
