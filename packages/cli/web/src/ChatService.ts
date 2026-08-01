import { rpc, rpcNamespace, type RpcInvocationHandle } from '@source-repo/rpc'

/**
 * Chat is here to be a service the page *hosts*, not a feature the console offers.
 *
 * Everything else in this app calls outwards: the page is a client of the console, which is the
 * ordinary direction. A page exposing a namespace that another peer calls is the opposite one, and
 * it is the part of the design least likely to be exercised by accident - a browser cannot listen,
 * so it can only be reached by dialling out and being relayed to. Two consoles on one bus, a page
 * on each, and a message crossing between them tests dial-out serving, presence propagation and
 * relaying in a way no amount of calling the console can.
 *
 * Kept apart from the component so the contract can be extracted from a file with no JSX in it, and
 * so the marks below are the only thing describing what a peer may call.
 */

export interface ChatMessage {
    from: string
    text: string
    at: number
    mine: boolean
}

/** What a page exposes to its peers. The other side calls `say`; nothing here is console-specific. */
@rpcNamespace('chat')
export class ChatService {
    constructor(private readonly onMessage: (from: string, text: string) => void) {}

    @rpc({ injectInvocation: true })
    async say(from: string, text: string, invocation: RpcInvocationHandle) {
        // Filed under who actually called, never under the parameter: `from` is a claim anyone
        // holding a CLI can type, which the first field trial demonstrated by routing a reply into
        // another peer's chat log. The handle's source is what the transport routed - pinned where
        // a transport authenticates - and the parameter survives only as the wire contract's
        // display field for peers older than the handle.
        const caller = invocation.context.identity?.name ?? invocation.context.source
        this.onMessage(String(caller), String(text))
        return 'delivered'
    }

    /** So a peer can show who it is talking to before saying anything. */
    @rpc
    async who() {
        return { app: 'source-rpc console', kind: 'browser page' }
    }
}
