import { EventEmitter } from 'events'
import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'
import { v4 as uuidv4 } from 'uuid'
import { RpcIdentity } from './Auth.js'
import { FrameCodec } from './Codec.js'

/**
 * Upper bound on the framed header, in bytes, including the delimiter.
 *
 * It has to fit the largest header this library builds: two 128-character peer names, a timestamp,
 * a sequence number, a hop count, a 24-character nonce and an 88-character Ed25519 signature come
 * to roughly 470 bytes. The old value of 256 was under that, and since the receiver stopped looking
 * for the delimiter at the limit, every frame with a header past it was dropped without a word -
 * signed frames from peers whose names were merely descriptive, at around 34 characters each.
 */
export const MAX_HEADER_LENGTH = 1024
export const HEADER_DELIMITER = '$'

const CHAR = { openBrace: 0x7b, closeBrace: 0x7d, quote: 0x22, backslash: 0x5c, delimiter: 0x24 } as const

/**
 * Index of the delimiter that ends the header, or -1 when there is no header to be found.
 *
 * Deliberately not indexOf('$'): the header is JSON, and a peer name containing a '$' puts one
 * inside a quoted string where it is data rather than punctuation. Splitting on the first one cut
 * the header mid-string, and the JSON.parse that followed threw - on the MQTT path, into an
 * unhandled rejection. Reading with JSON's own quoting rules makes the split unambiguous, so a name
 * can never reshape the frame it travels in.
 *
 * Scans code units rather than decoded text because every character it looks for is ASCII, and
 * UTF-8 never produces those bytes inside a multi-byte sequence. A payload cut mid-character
 * therefore cannot confuse it, which the previous decode-the-first-256-bytes approach could.
 */
const findHeaderEnd = (at: (index: number) => number, length: number) => {
    if (length === 0 || at(0) !== CHAR.openBrace) return -1
    const limit = Math.min(length, MAX_HEADER_LENGTH)
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < limit; index++) {
        const code = at(index)
        if (inString) {
            if (escaped) escaped = false
            else if (code === CHAR.backslash) escaped = true
            else if (code === CHAR.quote) inString = false
            continue
        }
        if (code === CHAR.quote) inString = true
        else if (code === CHAR.openBrace) depth++
        else if (code === CHAR.closeBrace && --depth === 0) {
            // The delimiter has to be the very next byte, or this is not a framed message.
            const delimiter = index + 1
            return delimiter < limit && at(delimiter) === CHAR.delimiter ? delimiter : -1
        }
    }
    return -1
}

/**
 * Lifecycle events emitted by transports. Transports are EventEmitters, so anything above them
 * can react to the link coming and going rather than discovering it via a call timeout.
 *
 * connected/disconnected are emitted by client-side transports on every transition, including
 * reconnects. peerGone is emitted by server-side transports when an identified peer's connection
 * drops, and peerOnline when one announces itself, which is how a peer is discovered at all.
 * rejected is emitted when an inbound frame fails an authentication check. unroutable is emitted
 * when a frame cannot be delivered to its target. peerDisplaced is emitted when a new connection
 * announces a name another live connection already holds, and takes the route over.
 */
export const TransportEvent = {
    connected: 'connected',
    disconnected: 'disconnected',
    peerOnline: 'peerOnline',
    peerGone: 'peerGone',
    peerDisplaced: 'peerDisplaced',
    rejected: 'rejected',
    unroutable: 'unroutable',
    transportError: 'transportError'
} as const

export interface IGenericModule<I = unknown, IP = unknown, O = unknown, OP = unknown> {
    readyFlag: boolean
    pipe(target: IGenericModule): void
    receive(message: I, source: string, target?: string): Promise<void>
    receivePayload(payload: IP, source: string, target?: string): Promise<void>
    send(message: O, source: string, target?: string): Promise<void>
    sendPayload(payload: OP, messageType: MessageType, source: string, target?: string): Promise<void>
    ready(): Promise<boolean>
    getName(): string
    targetExists(name: string, level?: number): IGenericModule | undefined
    isTransport(): boolean
    close(): Promise<void>
}

/**
 * Which module a peer name was last seen on, so a reply can be routed back out of the transport
 * its request arrived on.
 *
 * This was a static on GenericModule, which meant every client and server in one process shared a
 * single map keyed by names supplied by remote peers. Two graphs using the same peer name routed
 * into each other's transports, entries were never removed, and it grew for the life of the
 * process. One registry is now shared by one connected set of modules and nothing wider.
 */
export class PeerRegistry {
    private peers = new Map<string, IGenericModule>()

    constructor(
        /** Upper bound, since the keys come off the wire. Least recently seen entries go first. */
        public maxPeers = 10000
    ) {}

    set(source: string, module: IGenericModule) {
        // Re-inserting moves the entry to the end, which is what makes eviction least-recent-first.
        this.peers.delete(source)
        this.peers.set(source, module)
        while (this.peers.size > this.maxPeers) {
            const oldest = this.peers.keys().next()
            if (oldest.done) break
            this.peers.delete(oldest.value)
        }
    }

    get(source: string) {
        return this.peers.get(source)
    }
    delete(source: string) {
        return this.peers.delete(source)
    }
    clear() {
        this.peers.clear()
    }
    get size() {
        return this.peers.size
    }
    /** Every peer currently routed through one module, which is how a bridge lists what it can reach. */
    namesFor(module: IGenericModule) {
        const result: string[] = []
        for (const [name, carrier] of this.peers) if (carrier === module) result.push(name)
        return result
    }
    names() {
        return [...this.peers.keys()]
    }
}

/**
 * A module that owns its wire format. RpcClient and RpcServer drive these directly rather than
 * through a converter, so a transport whose framing is structured can see the message itself.
 */
export type Transport = GenericModule<Message, unknown, Message, unknown> & { codec: FrameCodec }

export interface MessageHeader {
    source: string
    target: string
    time: number
    seq: number
    /** How many relays this frame has already passed through. Absent means none. */
    hops?: number
    /** Present on signed frames: single-use value that makes a captured frame unreplayable. */
    nonce?: string
    /** Present on signed frames: base64 signature over the fields above plus the payload. */
    sig?: string
}

export class GenericModule<I = unknown, IP = unknown, O = unknown, OP = unknown> extends EventEmitter implements IGenericModule<I, IP, O, OP> {
    destinations: { id: string; target: IGenericModule }[] = []
    /**
     * Shared with the other modules in this graph by usePeerRegistry(). A module built on its own
     * gets a private one, so it still routes correctly without leaking into anyone else's.
     */
    peerRegistry = new PeerRegistry()
    readyFlag = false
    seq = 0

    constructor(
        public name: string,
        sources?: IGenericModule<unknown, unknown, I, IP>[]
    ) {
        super()
        if (!name) this.name = uuidv4()
        if (sources) {
            sources.forEach((src) => {
                src.pipe(this)
            })
        }
    }
    async ready() {
        while (!this.readyFlag) await new Promise((res) => setTimeout(res, 10))
        return true
    }
    async open() {}
    async close() {}
    /**
     * Build the header a frame will carry. Separate from framing so a transport that signs can
     * see the exact field values before they are serialised, and add its signature to them.
     */
    buildHeader(source: string, target: string, extra?: Partial<MessageHeader>): MessageHeader {
        return { source, target, time: Date.now(), seq: this.seq++, ...extra }
    }

    prependHeader(source: string, target: string, message: string | Uint8Array): string | Uint8Array {
        return this.frameMessage(this.buildHeader(source, target), message)
    }

    /**
     * Throws when the header will not fit the frame, rather than emitting one no receiver can read.
     * The sender is the only party that can do anything about an over-long peer name, and it learns
     * nothing from a frame that leaves correctly and is discarded at the far end.
     */
    frameMessage(header: MessageHeader, message: string | Uint8Array): string | Uint8Array {
        const headerText = JSON.stringify(header) + HEADER_DELIMITER
        const headerBuffer = stringToUint8Array(headerText)
        if (headerBuffer.length > MAX_HEADER_LENGTH)
            throw new Error(
                `message header is ${headerBuffer.length} bytes, over the ${MAX_HEADER_LENGTH} byte limit ` +
                    `(source '${header.source}', target '${header.target}') - shorten the peer names`
            )
        if (typeof message === 'string') return headerText + message
        const result = new Uint8Array(headerBuffer.length + message.length)
        result.set(headerBuffer, 0)
        result.set(message, headerBuffer.length)
        return result
    }

    /**
     * Split a frame into its header and payload. Never throws: every frame here came off the
     * network, and one malformed frame from one peer must not take down a process serving the rest.
     * The third element says why nothing was extracted, so a dropped frame can be diagnosed instead
     * of merely disappearing.
     */
    extractHeader(message: string | Uint8Array): [MessageHeader | undefined, string | Uint8Array, string?] {
        const isText = typeof message === 'string'
        const end = isText
            ? findHeaderEnd((index) => message.charCodeAt(index), message.length)
            : findHeaderEnd((index) => message[index], message.length)
        if (end < 0) return [undefined, '', 'no msgrpc header']

        const headerText = isText ? message.substring(0, end) : uint8ArrayToString(message.subarray(0, end))
        let header: MessageHeader
        try {
            header = JSON.parse(headerText) as MessageHeader
        } catch (e) {
            return [undefined, '', `unparsable header: ${String(e)}`]
        }
        if (!header || typeof header !== 'object') return [undefined, '', 'header is not an object']
        if (typeof header.target !== 'string' || !header.target) return [undefined, '', 'header names no target']
        if (typeof header.source !== 'string' || !header.source) return [undefined, '', 'header names no source']

        const start = end + HEADER_DELIMITER.length
        // Copied rather than viewed: the MQTT path hands us a view over a pooled Node Buffer, which
        // is reused for the next packet the moment this one returns.
        const payload: string | Uint8Array = isText ? message.substring(start) : message.slice(start)
        this.setKnownSource(header.source)
        return [header, payload]
    }

    getName(): string {
        return this.name
    }

    targetExists(name: string, level?: number) {
        let result: IGenericModule | undefined
        if (this.name === name) {
            result = this as IGenericModule
        }
        const knownPeer = this.peerRegistry.get(name)
        if (knownPeer) result = knownPeer
        if (!result) {
            this.destinations.map((dest) => {
                if (!result && !dest.target.isTransport() && dest.target.targetExists(name, (level ? level : 0) + 1)) result = dest.target
            })
        }
        return result
    }
    pipe(target: IGenericModule<O, OP, unknown, unknown>) {
        const id = uuidv4()
        this.destinations.push({ id, target })
        return () => {
            this.destinations = this.destinations.filter((el) => el.id !== id)
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async receive(message: I, source: string, target: string) {
        return
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async receivePayload(message: IP, source: string, target: string) {
        return
    }

    async send(message: O, source: string, target: string) {
        await Promise.all(
            this.destinations.map(async (dest) => {
                return await dest.target.receive(message, source, target)
            })
        )
    }
    setKnownSource(source: string) {
        this.peerRegistry.set(source, this)
    }

    /** Route peer lookups for this module through a registry shared with the rest of its graph. */
    usePeerRegistry(registry: PeerRegistry) {
        this.peerRegistry = registry
        return this
    }
    /**
     * The authenticated identity bound to a peer name, for transports that authenticate.
     * Undefined means this transport cannot vouch for the peer, not that the peer is untrusted.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getIdentity(source: string): RpcIdentity | undefined {
        return undefined
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async sendPayload(payload: OP, messageType: MessageType, source: string, target: string) {}
    isTransport() {
        return false
    }
}

export enum MessageType {
    RequestMessage = 'REQUEST',
    ResponseMessage = 'RESPONSE',
    ErrorMessage = 'ERROR',
    EventMessage = 'EVENT',
    UnknownMessage = 'UNKNOWN'
}

export interface Payload {}

export class Message<P = Payload> {
    type?: MessageType
    payload?: P
}

const makeMessage = <M extends Message<MP>, MP extends Payload>(payload: MP, source: string, target: string | undefined, messageType: MessageType): M => {
    const result = new Message()
    result.type = messageType ? messageType : MessageType.UnknownMessage
    result.payload = payload
    return result as M
}

export class MessageModule<I extends Message<IP>, IP extends Payload, O extends Message<OP>, OP extends Payload> extends GenericModule<I, IP, O, OP> {
    constructor(
        public override name: string,
        sources?: IGenericModule<Message, unknown, I, IP>[]
    ) {
        super(name)
        if (!name) this.name = uuidv4()
        if (sources) {
            sources.forEach((src) => {
                src.pipe(this)
            })
        }
    }

    override pipe(target: IGenericModule<O, OP, Message, unknown>) {
        const id = uuidv4()
        this.destinations.push({ id, target })
        return () => {
            this.destinations = this.destinations.filter((el) => el.id !== id)
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override receive(message: I, source: string, target: string): Promise<void> {
        return Promise.resolve()
    }

    override async send(message: O, source: string, target?: string) {
        await Promise.all(
            this.destinations.map(async (dest) => {
                return await dest.target.receive(message, source, target)
            })
        )
    }
    override async sendPayload(payload: OP, messageType: MessageType, source: string, target?: string) {
        const message = makeMessage<O, OP>(payload, this.name, target, messageType)
        await this.send(message, source, target)
    }
}
