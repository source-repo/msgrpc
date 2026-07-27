import { EventEmitter } from 'events'
import { stringToUint8Array, uint8ArrayToString } from 'uint8array-extras'
import { v4 as uuidv4 } from 'uuid'
import { RpcIdentity } from './Auth.js'

export const MAX_HEADER_LENGTH = 256
export const HEADER_DELIMITER = '$'

/**
 * Lifecycle events emitted by transports. Transports are EventEmitters, so anything above them
 * can react to the link coming and going rather than discovering it via a call timeout.
 *
 * connected/disconnected are emitted by client-side transports on every transition, including
 * reconnects. peerGone is emitted by server-side transports when an identified peer's connection
 * drops. rejected is emitted when an inbound frame fails an authentication check. unroutable is
 * emitted when a frame cannot be delivered to its target.
 */
export const TransportEvent = {
    connected: 'connected',
    disconnected: 'disconnected',
    peerGone: 'peerGone',
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
}

export interface MessageHeader {
    source: string
    target: string
    time: number
    seq: number
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

    frameMessage(header: MessageHeader, message: string | Uint8Array): string | Uint8Array {
        let result: string | Uint8Array
        if (typeof message === 'string') {
            result = JSON.stringify(header) + HEADER_DELIMITER + message
        } else {
            const headerBuffer = stringToUint8Array(JSON.stringify(header) + HEADER_DELIMITER)
            result = new Uint8Array(headerBuffer.length + message.length)
            result.set(headerBuffer, 0)
            result.set(message, headerBuffer.length)
        }
        return result
    }
    extractHeader(message: string | Uint8Array): [MessageHeader | undefined, string | Uint8Array] {
        let result: [MessageHeader | undefined, string | Uint8Array] = [undefined, '']
        if (typeof message === 'string') {
            let header: MessageHeader
            let nullPos = message.indexOf(HEADER_DELIMITER)
            if (nullPos > 0) {
                const headerText = message.substring(0, nullPos)
                if (headerText && headerText[0] === '{') {
                    header = JSON.parse(headerText)
                    if (header.target) {
                        const payload = message.slice(nullPos + HEADER_DELIMITER.length)
                        result = [header, payload]
                    } else nullPos = 0
                }
            } else nullPos = 0
        } else {
            const sMessage = uint8ArrayToString(message.subarray(0, Math.min(MAX_HEADER_LENGTH, message.length)))
            let header: MessageHeader
            let nullPos = sMessage.indexOf(HEADER_DELIMITER)
            if (nullPos > 0) {
                const headerText = sMessage.substring(0, nullPos)
                if (headerText && headerText[0] === '{') {
                    header = JSON.parse(headerText) as MessageHeader
                    if (header.target) {
                        const payload = new Uint8Array(message.length - nullPos - HEADER_DELIMITER.length)
                        payload.set(message.subarray(nullPos + HEADER_DELIMITER.length))
                        result = [header, payload]
                    } else nullPos = 0
                }
            } else nullPos = 0
        }
        if (result[0]) this.setKnownSource(result[0].source)
        return result
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
