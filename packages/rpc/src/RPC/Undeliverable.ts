import { Message, MessageType, TransportEvent } from './Core.js'
import { RpcCallInstanceMethodPayload, RpcErrorCode, RpcErrorPayload, RpcMessageType } from './Messages.js'

/**
 * Telling a caller that its request went nowhere, rather than letting it wait out its timeout.
 *
 * A frame arrives addressed to a peer this one cannot reach - never connected, gone away, refused
 * by the relay rule, or round too many hops. Emitting `unroutable` reports that to whoever is
 * watching *here*, which is useful and helps the caller not at all: its request is gone, nothing is
 * coming back, and the only thing that ever settles it is its own timeout. That is the same
 * "dropped in silence" this library has closed twice already - once where a send could not be
 * encoded, once where a switch had no route - and this is the last of the three.
 *
 * The answer travels back the way the request came, so it needs no route of its own beyond the link
 * it arrived on.
 */

/** The little of a transport this needs: its name, its events, and its outbound path. */
interface AnswersUndeliverable {
    name: string
    emit(event: string, payload?: unknown): boolean
    receive(message: Message, source?: string, target?: string): Promise<void>
}

/**
 * Report an undeliverable frame and, when somebody is waiting on it, answer them.
 *
 * `code` is what the caller will see. `TransportError` for a frame that could not be carried, which
 * says the method certainly did not run - this peer never handed it on. `Forbidden` where a relay
 * rule refused it, since that is a decision rather than a failure.
 */
export const refuseDelivery = async (
    transport: AnswersUndeliverable,
    message: Message,
    source: string,
    target: string,
    code: RpcErrorCode,
    reason: string
) => {
    transport.emit(TransportEvent.unroutable, { source, target, reason })

    // Only a request has anybody waiting on it. Answering a reply would invent a conversation, and
    // answering an undeliverable answer would send it straight back here - which is how two peers
    // that cannot reach each other keep each other busy forever.
    if (message.type !== MessageType.RequestMessage) return
    const id = (message.payload as RpcCallInstanceMethodPayload | undefined)?.id
    if (!id) return

    const payload: RpcErrorPayload = {
        type: RpcMessageType.error,
        id,
        code,
        // Named, because a caller several hops from the trouble otherwise learns only that
        // something between here and there said no.
        error: { name: 'RpcError', message: `${transport.name}: ${reason}` }
    }
    const answer = new Message()
    answer.type = MessageType.ErrorMessage
    answer.payload = payload

    try {
        await transport.receive(answer, transport.name, source)
    } catch {
        // The sender cannot be reached either, so there is nothing further to try and its own
        // timeout is what is left - exactly where it stood before this existed.
    }
}
