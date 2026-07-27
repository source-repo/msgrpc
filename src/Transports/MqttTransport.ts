import * as mqtt from 'mqtt'

import { stringToUint8Array } from 'uint8array-extras'
import { GenericModule, IGenericModule, Message, MessageHeader, TransportEvent } from '../RPC/Core.js'
import { FrameCodec, jsonCodec, msgPackCodec } from '../RPC/Codec.js'
import type { IPublishPacket } from 'mqtt-packet'
import { MessageSigner, MessageVerifier, RpcIdentity } from '../RPC/Auth.js'
import { canonicalSignedBytes, canonicalSignedBytesV5, createNonce, ReplayGuard } from '../RPC/Signing.js'
import {
    Channel,
    correlationToBytes,
    correlationToString,
    FRAME_VERSION,
    fromInboundFrame,
    MR,
    readControlProperties,
    toOutboundFrame
} from './Mqtt5Frame.js'

/** v1 is the $-header layout; v2 is the MQTT 5 property layout, so the two never share a topic. */
export const defaultTopicPrefix = { 4: 'msgrpc/v1', 5: 'msgrpc/v2' } as const

const PRESENCE_ONLINE = 'online'
const PRESENCE_OFFLINE = 'offline'

/**
 * Wildcards, control characters and (unless this is a multi-level prefix) the level separator.
 * Any of these would let a name change the shape of the topic it is interpolated into.
 */
const hasUnsafeTopicCharacter = (value: string, allowSeparator: boolean) => {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) return true
        if (character === '#' || character === '+') return true
        if (!allowSeparator && character === '/') return true
    }
    return false
}

/**
 * A peer name is interpolated into a topic, so it must not be able to change that topic's shape.
 * A peer named '#' would otherwise subscribe to every other peer's traffic, and one named '+'
 * would do the same one level down.
 */
export const isSafeTopicSegment = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 128 && !hasUnsafeTopicCharacter(value, false)

/** A prefix may span levels, so '/' is allowed inside it, but wildcards still are not. */
export const isSafeTopicPrefix = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !hasUnsafeTopicCharacter(value, true) &&
    !value.startsWith('/') &&
    !value.endsWith('/')

export interface MqttTransportOptions {
    /** Topic namespace. Traffic lives under <prefix>/rpc/<peer> and <prefix>/presence/<peer>. */
    prefix?: string
    /** Peer name to subscribe as. Defaults to the transport's own name. */
    topic?: string
    /**
     * Quality of service for RPC traffic. Defaults to 1, at least once: QoS 0 drops messages
     * silently whenever the broker or link hiccups, which for RPC shows up as a call timeout.
     * At-least-once permits duplicate delivery, which the RPC server suppresses by request id.
     */
    qos?: 0 | 1 | 2
    /**
     * Publish a retained last will, so peers learn when this one disappears instead of holding
     * its event subscriptions forever. On by default.
     */
    presence?: boolean
    /**
     * Ask the broker to keep this client's session, queueing QoS > 0 messages while it is
     * disconnected. Worth enabling for servers, which should not lose requests across a restart.
     * Off by default: a persistent session for a short-lived peer lingers on the broker.
     */
    persistentSession?: boolean
    /** Broker connection options: credentials, TLS client certificates, clientId, keepalive. */
    mqtt?: mqtt.IClientOptions
    /** Sign every outgoing frame. See RPC/Signing.ts for ready-made HMAC and Ed25519 signers. */
    sign?: MessageSigner
    /**
     * Require and check a signature on every incoming frame. Unsigned, stale, replayed or
     * badly-signed frames are dropped before they reach the RPC layer, and a verified peer gains
     * a real identity that authorize() can act on.
     */
    verify?: MessageVerifier
    /** How far an incoming frame's timestamp may differ from local time. Default 60000 ms. */
    maxClockSkew?: number
    /** How many recent nonces to remember for replay detection. Default 5000. */
    maxTrackedNonces?: number
    /**
     * MQTT protocol version. 5 carries the reply address, correlation and method as packet
     * properties, so a peer with no msgrpc code can take part and standard tooling can read the
     * traffic. 4 (MQTT 3.1.1) keeps the older $-delimited header for brokers that need it.
     */
    protocol?: 4 | 5
    /** MQTT 5 only: request lifetime the broker enforces, so a stale request is never executed. */
    requestExpirySeconds?: number
    /** MQTT 5 only: which of this peer's channels to subscribe to. Defaults to all three. */
    channels?: Channel[]
}

export class MqttTransport extends GenericModule<Message, unknown, Message, unknown> {
    client?: mqtt.MqttClient
    connected = false
    /** Owned here rather than by a converter above, so the transport decides its own wire form. */
    codec: FrameCodec = msgPackCodec
    readonly prefix: string
    readonly topic: string
    readonly qos: 0 | 1 | 2
    readonly presence: boolean
    readonly persistentSession: boolean
    readonly mqttOptions: mqtt.IClientOptions
    readonly protocol: 4 | 5
    readonly requestExpirySeconds: number
    readonly channels: Channel[]
    readonly sign?: MessageSigner
    readonly verify?: MessageVerifier
    readonly replayGuard: ReplayGuard
    /** Peer name -> identity established by verifying that peer's signature. */
    peerIdentities = new Map<string, RpcIdentity>()
    /**
     * Correlation -> the contentType its request arrived in, so the reply goes back in the same
     * encoding. A third party that speaks JSON must not be answered in msgpack it cannot read.
     * Bounded, since the keys come off the wire.
     */
    private replyEncoding = new Map<string, string>()
    private maxTrackedReplies = 1000

    constructor(
        name: string,
        public url: string,
        options: MqttTransportOptions = {},
        sources?: IGenericModule<unknown, unknown, Message, unknown>[]
    ) {
        super(name, sources)
        this.protocol = options.protocol ?? 5
        this.requestExpirySeconds = options.requestExpirySeconds ?? 30
        this.channels = options.channels ?? ['req', 'rsp', 'evt']
        this.prefix = options.prefix ?? defaultTopicPrefix[this.protocol]
        this.topic = options.topic ?? this.name
        this.qos = options.qos ?? 1
        this.presence = options.presence ?? true
        this.persistentSession = options.persistentSession ?? false
        this.mqttOptions = options.mqtt ?? {}
        this.sign = options.sign
        this.verify = options.verify
        this.replayGuard = new ReplayGuard(options.maxClockSkew ?? 60000, options.maxTrackedNonces ?? 5000)

        // Rejected at construction rather than at publish time, so a misconfigured peer fails
        // loudly instead of quietly subscribing to more than it should.
        if (!isSafeTopicPrefix(this.prefix)) throw new Error(`MqttTransport: unsafe topic prefix '${this.prefix}'`)
        if (!isSafeTopicSegment(this.name)) throw new Error(`MqttTransport: unsafe peer name '${this.name}'`)
        if (!isSafeTopicSegment(this.topic)) throw new Error(`MqttTransport: unsafe topic '${this.topic}'`)
        this.open()
    }

    rpcTopic(peer: string) {
        return `${this.prefix}/rpc/${peer}`
    }
    channelTopic(channel: Channel, peer: string) {
        return `${this.prefix}/${channel}/${peer}`
    }
    presenceTopic(peer: string) {
        return `${this.prefix}/presence/${peer}`
    }
    private get presenceRoot() {
        return `${this.prefix}/presence/`
    }

    override async open() {
        // Idempotent for the same reason as the socket.io client transport: the constructor opens
        // and RpcClient.init() opens again, which would leave a second broker connection behind.
        if (this.client) return
        this.client = mqtt.connect(this.url, {
            // A stable clientId is what lets the broker recognise this peer across a reconnect.
            // It used to be random per connection, so no session could ever be resumed.
            clientId: `msgrpc-${this.name}`,
            protocolVersion: this.protocol,
            ...this.mqttOptions,
            clean: this.mqttOptions.clean ?? !this.persistentSession,
            will: this.presence
                ? { topic: this.presenceTopic(this.name), payload: Buffer.from(PRESENCE_OFFLINE), qos: this.qos, retain: true }
                : this.mqttOptions.will
        })
        this.client.on('message', (topic, messageBuffer, packet) => void this.onBrokerMessage(topic, messageBuffer, packet))
        // mqtt.js reconnects on its own and re-emits 'connect', so subscriptions are renewed on
        // every transition.
        this.client.on('connect', () => void this.onConnect())
        this.client.on('close', () => {
            const wasConnected = this.connected
            this.connected = false
            this.readyFlag = false
            if (wasConnected) this.emit(TransportEvent.disconnected, 'close')
        })
        // Without a listener here Node throws on the emitter's unhandled 'error', so a rejected
        // broker connection would take the process down. Not re-emitted as 'error' for the same
        // reason.
        this.client.on('error', (e) => this.emit(TransportEvent.transportError, e))
    }

    private async onConnect() {
        this.connected = true
        try {
            if (this.protocol === 5) {
                for (const channel of this.channels) await this.client?.subscribeAsync(this.channelTopic(channel, this.topic), { qos: this.qos })
            } else await this.client?.subscribeAsync(this.rpcTopic(this.topic), { qos: this.qos })
            if (this.presence) {
                await this.client?.subscribeAsync(this.presenceTopic('+'), { qos: this.qos })
                await this.client?.publishAsync(this.presenceTopic(this.name), PRESENCE_ONLINE, { qos: this.qos, retain: true })
            }
        } catch (e) {
            this.emit(TransportEvent.transportError, e)
        }
        // Only now is inbound traffic actually reachable. Announcing earlier would let a client
        // replay its subscriptions before this transport could receive the answers.
        this.readyFlag = true
        this.emit(TransportEvent.connected)
    }

    private async onBrokerMessage(topic: string, messageBuffer: Buffer, packet?: IPublishPacket) {
        if (this.presence && topic.startsWith(this.presenceRoot)) {
            const peer = topic.slice(this.presenceRoot.length)
            // Retained presence means a late subscriber also learns about peers that already left.
            if (peer && peer !== this.name && messageBuffer.toString() === PRESENCE_OFFLINE) {
                this.peerIdentities.delete(peer)
                this.emit(TransportEvent.peerGone, peer)
            }
            return
        }
        if (this.protocol === 5) return await this.receiveV5(topic, messageBuffer, packet)
        const frame = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
        const [header, payload] = this.extractHeader(frame)
        if (!header) return
        if (!isSafeTopicSegment(header.source)) {
            // Replies are addressed by source, so an unsafe one cannot be answered anyway.
            this.emit(TransportEvent.rejected, { source: header.source, reason: 'unsafe peer name' })
            return
        }
        if (this.verify) {
            const rejection = await this.verifyFrame(header, payload)
            if (rejection) {
                this.emit(TransportEvent.rejected, { source: header.source, reason: rejection })
                return
            }
        }
        let message: Message
        try {
            message = this.codec.decode(payload as Uint8Array) as Message
        } catch (e) {
            this.emit(TransportEvent.rejected, { source: header.source, reason: `undecodable frame: ${String(e)}` })
            return
        }
        if (this.targetExists(header.target)) await this.send(message, header.source, header.target)
    }

    private async receiveV5(topic: string, messageBuffer: Buffer, packet?: IPublishPacket) {
        const properties = packet?.properties
        const control = readControlProperties(properties?.userProperties)
        if ('duplicate' in control) {
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: `repeated control property ${control.duplicate}` })
            return
        }
        const values = control.values
        const source = values[MR.source]
        if (!isSafeTopicSegment(source)) {
            this.emit(TransportEvent.rejected, { source, reason: 'missing or unsafe peer name' })
            return
        }
        const body = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
        const correlation = correlationToString(properties?.correlationData)

        if (this.verify) {
            const rejection = await this.verifyV5(topic, values, correlation, body)
            if (rejection) {
                this.emit(TransportEvent.rejected, { source, reason: rejection })
                return
            }
        }

        let decoded: unknown
        try {
            decoded = messageBuffer.length ? this.codecFor(properties?.contentType).decode(body) : undefined
        } catch (e) {
            this.emit(TransportEvent.rejected, { source, reason: `undecodable payload: ${String(e)}` })
            return
        }
        // Recorded before dispatch so the reply can mirror it.
        if (correlation) this.rememberReplyEncoding(correlation, properties?.contentType)
        const message = fromInboundFrame({
            kind: values[MR.kind],
            correlation,
            path: values[MR.path],
            method: values[MR.method],
            event: values[MR.event],
            code: values[MR.code],
            body: decoded
        })
        if (!message) {
            this.emit(TransportEvent.rejected, { source, reason: `unrecognised frame kind '${values[MR.kind]}'` })
            return
        }
        this.setKnownSource(source)
        // The reply address is this peer's own name under the MQTT 5 layout, so route on it.
        if (this.targetExists(this.name)) await this.send(message, source, this.name)
    }

    private rememberReplyEncoding(correlation: string, contentType: string | undefined) {
        if (!contentType || contentType === this.codec.contentType) return
        this.replyEncoding.set(correlation, contentType)
        while (this.replyEncoding.size > this.maxTrackedReplies) {
            const oldest = this.replyEncoding.keys().next()
            if (oldest.done) break
            this.replyEncoding.delete(oldest.value)
        }
    }

    private takeReplyEncoding(correlation: string) {
        const contentType = this.replyEncoding.get(correlation)
        if (!contentType) return undefined
        this.replyEncoding.delete(correlation)
        return this.codecFor(contentType)
    }

    /** A peer may speak JSON while this one defaults to msgpack; contentType says which. */
    private codecFor(contentType: string | undefined) {
        if (contentType && contentType !== this.codec.contentType) return contentType === jsonCodec.contentType ? jsonCodec : msgPackCodec
        return this.codec
    }

    private async verifyV5(topic: string, values: { [key: string]: string }, correlation: string | undefined, body: Uint8Array) {
        const signature = values[MR.signature]
        const nonce = values[MR.nonce]
        const timestamp = Number(values[MR.timestamp])
        if (!signature || !nonce) return 'unsigned'
        if (!this.replayGuard.accept(nonce, timestamp)) return 'stale or replayed'
        const source = values[MR.source]
        const canonical = canonicalSignedBytesV5({
            version: values[MR.version] ?? FRAME_VERSION,
            topic,
            source,
            kind: values[MR.kind] ?? '',
            path: values[MR.path] ?? '',
            methodOrEvent: values[MR.method] ?? values[MR.event] ?? '',
            correlation: correlation ?? '',
            timestamp,
            nonce,
            payload: body
        })
        let identity
        try {
            identity = await this.verify!(canonical, signature, { source })
        } catch {
            return 'verifier error'
        }
        if (!identity) return 'bad signature'
        if (identity.name !== source) return 'identity does not match source'
        this.peerIdentities.set(source, identity)
        return undefined
    }

    /**
     * Returns a reason to reject, or undefined when the frame is authentic. Every check is a
     * separate failure mode worth naming, because "message dropped" with no reason is the hardest
     * kind of problem to diagnose on a plant network.
     */
    private async verifyFrame(header: MessageHeader, payload: string | Uint8Array): Promise<string | undefined> {
        // An unsigned frame is not a valid frame once verification is on, or signing would be
        // trivially bypassed by omitting the signature.
        if (!header.sig || !header.nonce) return 'unsigned'
        if (!this.replayGuard.accept(header.nonce, header.time)) return 'stale or replayed'
        const canonical = canonicalSignedBytes({
            source: header.source,
            target: header.target,
            time: header.time,
            seq: header.seq,
            nonce: header.nonce,
            payload: typeof payload === 'string' ? stringToUint8Array(payload) : payload
        })
        let identity: RpcIdentity | undefined
        try {
            identity = await this.verify!(canonical, header.sig, { source: header.source })
        } catch {
            // A verifier that throws rejects, for the same reason an authorizer that throws denies.
            return 'verifier error'
        }
        if (!identity) return 'bad signature'
        // The same pinning rule the socket.io transport applies: a key authorises one name, so a
        // peer cannot sign frames claiming to come from someone else.
        if (identity.name !== header.source) return 'identity does not match source'
        this.peerIdentities.set(header.source, identity)
        return undefined
    }

    override async receive(message: Message, source: string, target: string) {
        if (!isSafeTopicSegment(target)) {
            this.emit(TransportEvent.unroutable, { source, target, reason: 'unsafe peer name' })
            return
        }
        if (this.protocol === 5) return await this.publishV5(message, source, target)
        const body = this.codec.encode(message)
        const header = this.buildHeader(source, target, this.sign ? { nonce: createNonce() } : undefined)
        if (this.sign) {
            const canonical = canonicalSignedBytes({
                source: header.source,
                target: header.target,
                time: header.time,
                seq: header.seq,
                nonce: header.nonce!,
                payload: body
            })
            header.sig = await this.sign(canonical, { source: header.source })
        }
        const framed = this.frameMessage(header, body)
        const payload = typeof framed === 'string' ? framed : Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength)
        // Awaited, so at QoS > 0 a publish that never reaches the broker surfaces as a failed call
        // rather than a silent drop followed by a timeout.
        await this.client?.publishAsync(this.rpcTopic(target), payload, { qos: this.qos })
    }

    /** Maps an RPC message onto the MQTT 5 packet layout. See docs/mqtt5-frame-spec.md. */
    private async publishV5(message: Message, source: string, target: string) {
        const frame = toOutboundFrame(message)
        if (!frame) {
            this.emit(TransportEvent.unroutable, { source, target, reason: 'no MQTT 5 representation for this message' })
            return
        }
        const topic = this.channelTopic(frame.channel, target)
        // A reply mirrors the encoding its request used; anything else uses this peer's own.
        const replyCodec = frame.channel === 'rsp' && frame.correlation ? this.takeReplyEncoding(frame.correlation) : undefined
        const codec = replyCodec ?? this.codec
        const body = codec.encode(frame.body)
        const userProperties: { [key: string]: string } = {
            [MR.version]: FRAME_VERSION,
            [MR.source]: source,
            [MR.kind]: frame.kind
        }
        if (frame.path) userProperties[MR.path] = frame.path
        if (frame.method) userProperties[MR.method] = frame.method
        if (frame.event) userProperties[MR.event] = frame.event
        if (frame.code) userProperties[MR.code] = frame.code

        if (this.sign) {
            const nonce = createNonce()
            const timestamp = Date.now()
            const canonical = canonicalSignedBytesV5({
                version: FRAME_VERSION,
                topic,
                source,
                kind: frame.kind,
                path: frame.path ?? '',
                methodOrEvent: frame.method ?? frame.event ?? '',
                correlation: frame.correlation ?? '',
                timestamp,
                nonce,
                payload: body
            })
            userProperties[MR.nonce] = nonce
            userProperties[MR.timestamp] = String(timestamp)
            userProperties[MR.signature] = await this.sign(canonical, { source })
        }

        await this.client?.publishAsync(topic, Buffer.from(body), {
            qos: this.qos,
            properties: {
                contentType: codec.contentType,
                payloadFormatIndicator: codec.contentType === jsonCodec.contentType,
                correlationData: frame.correlation ? Buffer.from(correlationToBytes(frame.correlation)!) : undefined,
                // Only a request expects an answer, and only a request should expire.
                ...(frame.channel === 'req'
                    ? { responseTopic: this.channelTopic('rsp', this.name), messageExpiryInterval: this.requestExpirySeconds }
                    : {}),
                userProperties
            }
        })
    }

    override async close() {
        // GenericModule.close() is a no-op, so without this the broker connection stayed open and
        // kept reconnecting after the transport was discarded.
        const client = this.client
        this.client = undefined
        this.connected = false
        this.readyFlag = false
        if (!client) return
        if (this.presence && client.connected) {
            const topic = this.presenceTopic(this.name)
            try {
                // A graceful goodbye, so peers release this one's subscriptions immediately instead
                // of waiting for the broker to notice the connection is gone and publish the will.
                await client.publishAsync(topic, PRESENCE_OFFLINE, { qos: this.qos, retain: true })
                // Then clear the retained value. A peer that left cleanly has no state for a later
                // subscriber to clean up, and leaving one behind per peer name accumulates on the
                // broker forever. An ungraceful death keeps its retained will, which is the point.
                await client.publishAsync(topic, '', { qos: this.qos, retain: true })
            } catch {
                // Going away regardless; the will covers it.
            }
        }
        await client.endAsync()
    }

    override getIdentity(source: string) {
        return this.peerIdentities.get(source)
    }

    override isTransport() {
        return true
    }
}
