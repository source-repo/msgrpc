import * as mqtt from 'mqtt'

import { stringToUint8Array, uint8ArrayToBase64 } from 'uint8array-extras'
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
/** MQTT 5 reason code 0x8E, sent to the peer whose session a new connection has just claimed. */
const SESSION_TAKEN_OVER = 0x8e

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
    /**
     * MQTT 5 only. Join a shared subscription group so several processes can serve one peer name,
     * with the broker distributing requests among them.
     *
     * Only the request channel is shared. A reply has to reach the requester waiting for it, and an
     * event its particular subscriber, so sharing those would hand them to an arbitrary replica.
     */
    sharedGroup?: string
    /**
     * Distinguishes this replica's broker connection from its siblings'. A broker permits one
     * connection per client id, and replicas share a peer name, so without this they would
     * disconnect each other in a loop. Defaults to a random suffix.
     */
    replicaId?: string
    /**
     * MQTT 5 only: how long the broker keeps this peer's session after it disconnects. Bounds the
     * queueing that makes a restart lossless, without leaving session state behind forever.
     * Defaults to an hour for a persistent session and a minute otherwise.
     */
    sessionExpirySeconds?: number
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
    readonly sharedGroup?: string
    readonly replicaId: string
    readonly sessionExpirySeconds: number
    /** A replica must not speak for the whole group; see the constructor. */
    readonly announcePresence: boolean
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
        this.sharedGroup = options.sharedGroup
        this.replicaId = options.replicaId ?? uint8ArrayToBase64(globalThis.crypto.getRandomValues(new Uint8Array(6)))
        // A replica keeps no session: its share of the queue would never be drained if it stayed
        // down, and the broker would hold messages for a process that is not coming back.
        this.sessionExpirySeconds = options.sessionExpirySeconds ?? (this.sharedGroup ? 0 : this.persistentSession ? 3600 : 60)
        // Presence describes one connection. A replica's will would announce the whole shared name
        // as offline when a single process stops, and its siblings' retained 'online' would fight
        // with it. Replicas therefore observe presence without announcing their own.
        this.announcePresence = this.presence && !this.sharedGroup
        this.mqttOptions = options.mqtt ?? {}
        this.sign = options.sign
        this.verify = options.verify
        this.replayGuard = new ReplayGuard(options.maxClockSkew ?? 60000, options.maxTrackedNonces ?? 5000)

        // Rejected at construction rather than at publish time, so a misconfigured peer fails
        // loudly instead of quietly subscribing to more than it should.
        if (!isSafeTopicPrefix(this.prefix)) throw new Error(`MqttTransport: unsafe topic prefix '${this.prefix}'`)
        if (!isSafeTopicSegment(this.name)) throw new Error(`MqttTransport: unsafe peer name '${this.name}'`)
        if (!isSafeTopicSegment(this.topic)) throw new Error(`MqttTransport: unsafe topic '${this.topic}'`)
        if (this.sharedGroup !== undefined && !isSafeTopicSegment(this.sharedGroup))
            throw new Error(`MqttTransport: unsafe shared group '${this.sharedGroup}'`)
        if (this.sharedGroup && this.protocol !== 5) throw new Error('MqttTransport: shared subscriptions need protocol 5')
        // Deferred by a microtask so whatever constructs this transport can finish wiring it
        // before the link comes up. A resumed MQTT session is delivered its queued messages the
        // instant it connects, and a frame arriving before the RPC handler is piped in would find
        // no target and be dropped. A fresh session never exposes this, because nothing arrives
        // that early.
        queueMicrotask(() => void this.open().catch((e) => this.emit(TransportEvent.transportError, e)))
    }

    /**
     * The broker connection, or an error saying there is none.
     *
     * Publishing used to go through `this.client?.publishAsync(...)`, which resolves to undefined
     * when the transport is closed or has not opened yet - so an outgoing call was dropped on the
     * floor and its caller learned nothing until the call timed out. A frame that cannot be sent is
     * a failure worth reporting at once.
     */
    private requireClient() {
        if (!this.client) throw new Error(`MqttTransport '${this.name}': no connection to ${this.url}`)
        return this.client
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
            clientId: this.sharedGroup ? `msgrpc-${this.name}-${this.replicaId}` : `msgrpc-${this.name}`,
            protocolVersion: this.protocol,
            ...this.mqttOptions,
            // MQTT 5 bounds a retained session with an expiry, so a client can queue across a blip
            // without leaving state on the broker forever. 3.1.1 has no expiry, so it stays with
            // the blunt choice between queueing forever and not queueing at all.
            clean: this.mqttOptions.clean ?? (this.sharedGroup ? true : this.protocol === 5 ? false : !this.persistentSession),
            ...(this.protocol === 5
                ? { properties: { sessionExpiryInterval: this.sessionExpirySeconds, ...this.mqttOptions.properties } }
                : {}),
            will: this.announcePresence
                ? { topic: this.presenceTopic(this.name), payload: Buffer.from(PRESENCE_OFFLINE), qos: this.qos, retain: true }
                : this.mqttOptions.will
        })
        // Both listeners catch: an async listener's rejection is unhandled by construction, and
        // Node's default is to end the process on one. A single malformed frame from one peer -
        // or a stray JSON payload published to the rpc topic by any tool that can reach the broker
        // - would otherwise take down a server answering everybody else.
        this.client.on('message', (topic, messageBuffer, packet) =>
            void this.onBrokerMessage(topic, messageBuffer, packet).catch((e) =>
                this.emit(TransportEvent.rejected, { source: 'unknown', reason: `failed to handle message on '${topic}': ${String(e)}`, error: e })
            )
        )
        // mqtt.js reconnects on its own and re-emits 'connect', so subscriptions are renewed on
        // every transition.
        this.client.on('connect', () => void this.onConnect().catch((e) => this.emit(TransportEvent.transportError, e)))
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
        // A name collision on MQTT needs no detection of its own: the clientId is derived from the
        // peer name, so a second peer using it makes the broker hand the session over and tell the
        // incumbent why. Same outcome as socket.io - the newcomer takes the address - reported from
        // the other end, because here it is the displaced peer that finds out rather than a server.
        this.client.on('disconnect', (packet) => {
            if (packet?.reasonCode === SESSION_TAKEN_OVER) this.warnAboutDisplacement()
        })
    }

    /** Said once: mqtt.js reconnects on its own, and two peers sharing a name take turns forever. */
    private warnedAboutDisplacement = false
    private warnAboutDisplacement() {
        this.emit(TransportEvent.peerDisplaced, this.name)
        if (this.warnedAboutDisplacement) return
        this.warnedAboutDisplacement = true
        console.warn(
            `msgrpc: '${this.name}' was disconnected because another connection claimed its broker session, which means a second peer is running under this name. ` +
                'Both will keep taking the connection from each other, and calls to either will reach whichever holds it. Give them distinct names.'
        )
    }

    private async onConnect() {
        this.connected = true
        try {
            if (this.protocol === 5) {
                for (const channel of this.channels) {
                    const topic = this.channelTopic(channel, this.topic)
                    // Only requests are shared: replies and events must reach one specific peer.
                    const filter = channel === 'req' && this.sharedGroup ? `$share/${this.sharedGroup}/${topic}` : topic
                    await this.client?.subscribeAsync(filter, { qos: this.qos })
                }
            } else await this.client?.subscribeAsync(this.rpcTopic(this.topic), { qos: this.qos })
            if (this.presence) {
                // Observed even by replicas, which still need to know when their own peers depart.
                await this.client?.subscribeAsync(this.presenceTopic('+'), { qos: this.qos })
                if (this.announcePresence) await this.client?.publishAsync(this.presenceTopic(this.name), PRESENCE_ONLINE, { qos: this.qos, retain: true })
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
            if (!peer || peer === this.name) return
            // Presence this transport published on a proxied peer's behalf comes straight back to
            // it. Acting on it would register that peer as living on the broker and break the route
            // home, since it actually lives on whichever transport asked for the forwarding.
            if (this.proxied.has(peer)) return
            const state = messageBuffer.toString()
            if (state === PRESENCE_OFFLINE) {
                this.peerIdentities.delete(peer)
                this.emit(TransportEvent.peerGone, peer)
            } else if (state === PRESENCE_ONLINE) {
                // Retained, so a subscriber learns about every peer already online the moment it
                // subscribes. That is the whole of peer discovery.
                // Registered as well as announced: presence is how this transport knows a peer
                // exists, and a bridge has to be able to route to it without having heard from it
                // first. Without this a peer discovered over the broker was visible but unreachable.
                this.setKnownSource(peer)
                this.emit(TransportEvent.peerOnline, peer)
            }
            return
        }
        if (this.protocol === 5) return await this.receiveV5(topic, messageBuffer, packet)
        const frame = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
        const [header, payload, reason] = this.extractHeader(frame)
        if (!header) {
            // Reported rather than dropped in silence. Anything at all can be published to an rpc
            // topic, and "the calls just time out" is the hardest kind of problem to diagnose.
            this.emit(TransportEvent.rejected, { source: 'unknown', reason: reason ?? 'no msgrpc header' })
            return
        }
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
        await this.deliver(message, header.source, header.target)
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
            version: values[MR.contractVersion],
            body: decoded
        })
        if (!message) {
            this.emit(TransportEvent.rejected, { source, reason: `unrecognised frame kind '${values[MR.kind]}'` })
            return
        }
        this.setKnownSource(source)
        // The addressee is in the topic under the MQTT 5 layout. It is this peer for everything it
        // subscribed to for itself, and someone else for a topic it watches on their behalf.
        await this.deliver(message, source, this.topicAddressee(topic) ?? this.name)
    }

    /** The peer a topic addresses: <prefix>/<channel>/<peer>. */
    private topicAddressee(topic: string) {
        if (!topic.startsWith(`${this.prefix}/`)) return undefined
        const rest = topic.slice(this.prefix.length + 1)
        const slash = rest.indexOf('/')
        return slash < 0 ? undefined : rest.slice(slash + 1)
    }

    /**
     * Hand a decoded frame to this peer's own handler, or on to whichever transport carries its
     * addressee. The second case is a bridge: this transport is subscribed to a topic belonging to
     * a peer that lives on another link, and its job is to pass the frame along unchanged - the
     * source and any signature stay as the original sender wrote them.
     */
    private async deliver(message: Message, source: string, target: string) {
        if (target !== this.name) {
            const carrier = this.peerRegistry.get(target)
            if (carrier && carrier !== (this as unknown as IGenericModule) && carrier.isTransport()) {
                await carrier.receive(message, source, target)
                return
            }
        }
        if (this.targetExists(target)) {
            await this.send(message, source, target)
            return
        }
        this.emit(TransportEvent.unroutable, { source, target })
    }

    /** Peers this transport collects answers for, so the subscriptions are made once and dropped once. */
    private readonly proxied = new Set<string>()

    private async watchOnBehalfOf(peer: string) {
        if (this.proxied.has(peer) || peer === this.name || !isSafeTopicSegment(peer)) return
        this.proxied.add(peer)
        try {
            if (this.protocol === 5) {
                for (const channel of ['rsp', 'evt'] as Channel[]) await this.client?.subscribeAsync(this.channelTopic(channel, peer), { qos: this.qos })
            } else await this.client?.subscribeAsync(this.rpcTopic(peer), { qos: this.qos })
            // Presence for it too. A server drops a departed peer's event subscriptions when its
            // presence goes offline, and a peer that only exists on the other side of this bridge
            // has no other way to say it left - its subscriptions would sit there forever, with
            // every emit producing a frame nobody collects.
            if (this.presence) await this.client?.publishAsync(this.presenceTopic(peer), PRESENCE_ONLINE, { qos: this.qos, retain: true })
        } catch (e) {
            this.proxied.delete(peer)
            this.emit(TransportEvent.transportError, e)
        }
    }

    /** Stop collecting for a peer that has gone, so a departed browser leaves no subscription behind. */
    async stopWatchingFor(peer: string) {
        if (!this.proxied.delete(peer)) return
        try {
            if (this.presence) {
                // Offline first, so a server holding its subscriptions releases them, then cleared
                // so the peer leaves no retained state behind - the same pair this transport
                // publishes for itself on a clean shutdown.
                await this.client?.publishAsync(this.presenceTopic(peer), PRESENCE_OFFLINE, { qos: this.qos, retain: true })
                await this.client?.publishAsync(this.presenceTopic(peer), '', { qos: this.qos, retain: true })
            }
            if (this.protocol === 5) {
                for (const channel of ['rsp', 'evt'] as Channel[]) await this.client?.unsubscribeAsync(this.channelTopic(channel, peer))
            } else await this.client?.unsubscribeAsync(this.rpcTopic(peer))
        } catch (e) {
            this.emit(TransportEvent.transportError, e)
        }
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
        // Publishing for a peer that is not this one means acting as its gateway onto the broker.
        // Its replies and events are addressed to it, on topics this transport does not otherwise
        // watch, so they have to be subscribed to or the call can only ever time out.
        if (source !== this.name) await this.watchOnBehalfOf(source)
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
        await this.requireClient().publishAsync(this.rpcTopic(target), payload, { qos: this.qos })
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
        if (frame.version) userProperties[MR.contractVersion] = frame.version

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

        await this.requireClient().publishAsync(topic, Buffer.from(body), {
            qos: this.qos,
            properties: {
                contentType: codec.contentType,
                payloadFormatIndicator: codec.contentType === jsonCodec.contentType,
                correlationData: frame.correlation ? Buffer.from(correlationToBytes(frame.correlation)!) : undefined,
                // Only a request expects an answer, and only a request should expire.
                ...(frame.channel === 'req'
                    ? { responseTopic: this.channelTopic('rsp', source), messageExpiryInterval: this.requestExpirySeconds }
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
        // Peers this transport was standing in for go with it. Its own will covers its own name;
        // nothing covers theirs, so a bridge that is killed does leave their presence retained.
        if (this.presence && client.connected)
            for (const peer of [...this.proxied]) {
                this.proxied.delete(peer)
                try {
                    await client.publishAsync(this.presenceTopic(peer), PRESENCE_OFFLINE, { qos: this.qos, retain: true })
                    await client.publishAsync(this.presenceTopic(peer), '', { qos: this.qos, retain: true })
                } catch {
                    // Going away regardless.
                }
            }
        if (this.announcePresence && client.connected) {
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
