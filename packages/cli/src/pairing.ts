import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The commissioning exchange: proving, in both directions, that each end holds the secret printed
 * on the device.
 *
 * This is the whole of the trust in enrolment, so it is deliberately small and has no network in
 * it. What it is not is a key agreement - the secret is shared out of band by being on a label, and
 * carries enough entropy that no PAKE is needed. That is the trade the QR code buys: nobody types
 * 128 bits, so there is no reason to ration them, and with a long secret an observer of the exchange
 * has nothing to attack offline. A short code here would be WPS PIN again.
 *
 * The authority relays this exchange and cannot forge either side of it. That is the point of
 * proving end-to-end rather than letting the authority vouch: a misconfigured or compromised
 * rendezvous can drop an enrolment, and cannot complete one.
 */

/** 32 bytes from the system generator. The label's secret, and the only thing that is secret here. */
export const commissioningSecret = () => randomBytes(32).toString('base64url')

/**
 * The device's public name for itself. On the label beside the secret, and in every log - so it is
 * generated separately rather than derived from the secret, which would make the label's public half
 * a function of its private one.
 */
export const deviceId = () => `dev-${randomBytes(9).toString('base64url')}`

/** Fresh per commissioning session, never reused: what stops a captured proof opening a second one. */
export const sessionNonce = () => randomBytes(16).toString('base64url')

/**
 * Who is proving what. The two directions carry different tags so that neither proof can be replayed
 * as the other - without this an authority in the middle could echo the console's own proof back to
 * it and pass for the device it never reached.
 */
export type PairingDirection = 'claim' | 'accept'

export interface PairingTranscript {
    /** The device being enrolled, as its label names it. */
    deviceId: string
    /** This attempt, so a proof cannot be carried into another session with the same device. */
    sessionId: string
    /** The node's contribution to the exchange, chosen before it knew who would claim it. */
    nodeNonce: string
    /** The claimant's, so neither end alone decides what gets signed. */
    claimNonce: string
}

/**
 * NUL between the fields, and written as an escape - never the byte, which would make this file
 * binary to grep and every other tool that sniffs content. It separates rather than any printable
 * character because it cannot occur in a base64url nonce or a device id, so no choice of one field
 * can forge the boundary of the next.
 */
const transcriptBytes = (direction: PairingDirection, transcript: PairingTranscript) =>
    [
        // Versioned, so a later exchange that means something different cannot be satisfied by a
        // proof made for this one.
        'source-rpc/pairing/1',
        direction,
        transcript.deviceId,
        transcript.sessionId,
        transcript.nodeNonce,
        transcript.claimNonce
    ].join('\u0000')

/** The proof one end sends. HMAC over the transcript, keyed by the secret on the label. */
export const pairingProof = (secret: string, direction: PairingDirection, transcript: PairingTranscript) =>
    createHmac('sha256', secret).update(transcriptBytes(direction, transcript)).digest('base64url')

/**
 * Whether a proof is the one this transcript and secret produce.
 *
 * Constant-time, because the alternative leaks how much of a forged proof was right, and an attacker
 * who can ask repeatedly - which a rendezvous lets them do - can walk a comparison byte by byte.
 * Length is compared first because `timingSafeEqual` throws on a mismatch rather than returning
 * false, and that throw would itself be the fast path an attacker measures.
 */
export const pairingProofValid = (secret: string, direction: PairingDirection, transcript: PairingTranscript, offered: string) => {
    const expected = Buffer.from(pairingProof(secret, direction, transcript), 'utf8')
    const given = Buffer.from(offered, 'utf8')
    return expected.length === given.length && timingSafeEqual(expected, given)
}
