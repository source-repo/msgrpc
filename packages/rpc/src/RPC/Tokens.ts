import { RpcAuthenticator, RpcIdentity } from './Auth.js'

/**
 * Bearer tokens for a socket.io transport: the smallest thing that turns a bus anyone can join into
 * one only its own peers can.
 *
 * Signing (Signing.ts) answers a different question. It proves a *frame* came from a peer, which is
 * what MQTT needs, because there is no connection for anyone to have authenticated. A socket.io bus
 * does have one, and a token presented once at the handshake pins it - after which the transport
 * refuses any frame whose source is not the name that token resolved to. That check is the point,
 * and it is what a shared password cannot do.
 *
 * So: **one token per peer, not one token for the bus.** A token that maps to a name is evidence of
 * who is calling. A single token everyone knows is evidence only that the caller is inside the
 * fence, and any holder can then claim to be the peer whose commands matter. `createTokenAuthenticator`
 * takes a map for that reason and has no single-secret form.
 *
 * Tokens are bearer credentials: whoever has one is that peer. They belong in a secret store or an
 * environment variable, never in the image, the repository or the command line.
 */

/**
 * What a token entitles its holder to be. A bare string is the peer name it may use; the object
 * form adds roles for an `RpcAuthorizer` to read.
 */
export type TokenGrant = string | { name: string; roles?: string[] }

const grantToIdentity = (grant: TokenGrant): RpcIdentity =>
    typeof grant === 'string' ? { name: grant } : { name: grant.name, ...(grant.roles ? { roles: grant.roles } : {}) }

/** The handshake payload this expects. `RpcClient`'s `credentials` and a connect transport's are passed through verbatim. */
interface TokenCredentials {
    token?: unknown
}

/**
 * Accept peers presenting a token this map knows, as the peer that token names.
 *
 * ```typescript
 * new RpcServer({
 *     transports: [{ port: defaultWebSocketPort }],
 *     authenticate: createTokenAuthenticator({ [process.env.PLANT_TOKEN!]: 'plantServer' })
 * })
 * ```
 *
 * The peer presents it as `credentials: { token }`, and its `name` must be the one the token maps
 * to - the transport drops frames that claim any other source, so a mismatch shows up as every call
 * timing out rather than as a refusal. Worth getting right in configuration rather than debugging.
 *
 * An empty or blank token is refused at construction. It would otherwise sit in the map matching
 * every peer that presented no credentials at all, which is the one mistake here that looks like it
 * is working.
 */
export const createTokenAuthenticator = (tokens: { [token: string]: TokenGrant }): RpcAuthenticator => {
    // Copied into a Map at construction so a later mutation of the caller's object cannot widen who
    // is admitted, and so lookup is by hash of the whole token rather than a comparison that could
    // return early on the first wrong character.
    const grants = new Map<string, RpcIdentity>()
    for (const [token, grant] of Object.entries(tokens)) {
        if (!token.trim()) throw new Error('createTokenAuthenticator: a blank token would admit any peer presenting none')
        const identity = grantToIdentity(grant)
        if (!identity.name) throw new Error('createTokenAuthenticator: a token must name the peer it admits')
        grants.set(token, identity)
    }
    if (!grants.size) throw new Error('createTokenAuthenticator: no tokens, so nothing could ever connect')

    return (credentials) => {
        const presented = (credentials as TokenCredentials | undefined)?.token
        if (typeof presented !== 'string') return undefined
        // Returned by value: an authorizer that mutated the identity it was handed would otherwise
        // change what every later connection with the same token is granted.
        const identity = grants.get(presented)
        return identity ? { ...identity, ...(identity.roles ? { roles: [...identity.roles] } : {}) } : undefined
    }
}
