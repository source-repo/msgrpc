import * as mqtt from 'mqtt'

import { stringToUint8Array, uint8ArrayToBase64 } from 'uint8array-extras'
import { GenericModule, IGenericModule, Message, MessageHeader, TransportEvent, type RelayedFrame } from '../RPC/Core.js'
import { FrameCodec, jsonCodec, msgPackCodec } from '../RPC/Codec.js'
import type { IPublishPacket } from 'mqtt-packet'
import { MessageSigner, MessageVerifier, RpcIdentity } from '../RPC/Auth.js'
import { canonicalSignedBytes, canonicalSignedBytesV5, createNonce, ReplayGuard } from '../RPC/Signing.js'
import { refuseDelivery } from '../RPC/Undeliverable.js'
import {
    Channel,
    correlationToBytes,
    correlationToString,
    FRAME_VERSION,
    fromInboundFrame,
    isRequestKind,
    MR,
    readControlProperties,
    SUPPORTED_FRAME_VERSIONS,
    toOutboundFrame
} from './Mqtt5Frame.js'
import { isUsableShape } from './Presence.js'

/** v1 is the $-header layout; v2 is the MQTT 5 property layout, so the two never share a topic. */
export const defaultTopicPrefix = { 4: 'msgrpc/v1', 5: 'msgrpc/v2' } as const

const PRESENCE_ONLINE = 'online'
const PRESENCE_OFFLINE = 'offline'
/** MQTT 5 reason code 0x8E, sent to the peer whose session a new connection has just claimed. */
const SESSION_TAKEN_OVER = 0x8e
/** A connection that lasts this long was doing its job, whatever ended it afterwards. */
const STABLE_CONNECTION_MS = 5000
/** How many connections must die young in a row before it stops looking like bad luck. */
const SUSPICIOUS_RECONNECTS = 3

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

/**
 * A topic something may be published to. Spans levels, but wildcards are only meaningful in a
 * subscription and `$` opens the broker's own namespace, so neither belongs in a destination that
 * arrived from somewhere else.
 */
export const isSafeTopicName = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !hasUnsafeTopicCharacter(value, true) && !value.startsWith('$')

export interface MqttTransportOptions {
    /** Topic namespace. Traffic lives under <prefix>/rpc/<peer> and <prefix>/presence/<peer>. */
    prefix?: string
    /** Peer name to subscribe as. Defaults to the transport's own name. */
    topic?: string
    /**
     * Watch every peer's traffic instead of this one's, and report it rather than acting on it.
     *
     * There is no broker of ours on an MQTT network to hook the way a socket.io one can be, so the
     * observation happens at the subscription: `<prefix>/rpc/+` under the 3.1.1 layout, and each of
     * `<prefix>/{req,rsp,evt}/+` under MQTT 5. Everything decoded is emitted as
     * `TransportEvent.relayed` and nothing is delivered - a tap answers no calls and runs no
     * methods.
     *
     * **Give this its own transport rather than adding it to a working one.** A peer subscribed to
     * both its own topic and the wildcard covering it has overlapping subscriptions, and a broker
     * is permitted to deliver a matching message once per subscription - which for a request means
     * running the method twice. A separate instance is a separate client id and a separate session,
     * so the two never overlap. It follows that a tap needs a name of its own, and `presence: false`
     * unless it should appear in everyone's peer list.
     *
     * Frames are reported without checking signatures: a tap holds no key for a conversation it is
     * not part of, and what is on the wire is what it exists to show.
     */
    tap?: boolean
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
    /**
     * Connect to an `mqtts://` or `wss://` broker without checking its certificate. Deliberately
     * unsafe and named so: it accepts any certificate at all, so anything able to answer on the
     * broker's address can read and rewrite everything this peer sends. For a development broker
     * with a self-signed certificate; a plant should carry its own CA in `mqtt.ca` instead.
     */
    allowInsecureTls?: boolean
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
    /**
     * MQTT 5 only: how long the broker holds a request that names no deadline of its own.
     *
     * A request from an RPC client carries the time its caller will still wait, and the expiry is
     * taken from that instead - the two used to be independent, so a client that gave up after ten
     * seconds could have its request delivered and executed twenty seconds later. This remains the
     * answer for a request that says nothing, which is any third-party caller not sending `mr-ttl`.
     */
    requestExpirySeconds?: number
    /**
     * MQTT 5 only: decide whether a request may have its reply published where it asks.
     *
     * A request names a Response Topic and that is where the answer goes, which means a caller
     * chooses a topic this peer then publishes to. Unset, the rule is that the topic must sit under
     * this transport's own prefix - the boundary broker ACLs are usually drawn on. Supply this to
     * widen it, or to narrow it to exactly the peer's own reply topic.
     */
    allowResponseTopic?: (topic: string, source: string) => boolean
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
    readonly allowResponseTopic?: (topic: string, source: string) => boolean
    readonly tap: boolean
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
     * Correlation -> where a request asked for its reply and in what encoding it arrived, so the
     * answer goes back where it was asked for and in a form the caller can read. A third party that
     * speaks JSON must not be answered in msgpack, and one that subscribed to a topic of its own
     * choosing must not be answered on a topic we invented for it. Bounded, since the keys come off
     * the wire.
     */
    private pendingReplies = new Map<string, { contentType?: string; topic?: string }>()
    private maxTrackedReplies = 1000
    /** Resolves the sweep below; undefined once it has fired. The timer is the quiescence gap. */
    private sweepLanded?: () => void
    private readonly sweep = new Promise<void>((resolve) => (this.sweepLanded = resolve))
    private sweepQuiet?: ReturnType<typeof setTimeout>

    /**
     * Resolved when the retained presence burst has been read: the broker sends everything
     * retained under <prefix>/presence/+ immediately after the subscription is granted, so a short
     * silence after the grant is the only end-marker MQTT has - there is no "that was everyone"
     * packet. The gap restarts on each presence message and first arms when the subscribe is
     * acknowledged, so an empty network settles after one quiet gap and a full one after its burst.
     *
     * Resolved once and stays resolved, and a transport that observes no presence at all settles
     * immediately - nothing is coming. This is a heuristic with an honest name: a broker that takes
     * longer than the gap to deliver a retained message loses the race, which is what the bounded
     * wait in peersSettled() is for.
     */
    presenceSettled(): Promise<void> {
        if (!this.presence) this.settleSweep()
        return this.sweep
    }

    /** How long the presence topic must stay silent before the retained burst counts as delivered. */
    private static readonly SWEEP_QUIET_MS = 250

    private settleSweep() {
        const landed = this.sweepLanded
        this.sweepLanded = undefined
        if (this.sweepQuiet) clearTimeout(this.sweepQuiet)
        this.sweepQuiet = undefined
        landed?.()
    }

    private armSweepQuiet() {
        if (!this.sweepLanded) return
        if (this.sweepQuiet) clearTimeout(this.sweepQuiet)
        this.sweepQuiet = setTimeout(() => this.settleSweep(), MqttTransport.SWEEP_QUIET_MS)
        // A process whose work is done must not be held open by a discovery timer.
        this.sweepQuiet.unref?.()
    }

    /** The description hash this peer announces. See PresenceAnnouncement.shape. */
    private shape?: string

    /**
     * The retained 'online', with the shape riding as an MQTT 5 user property rather than in the
     * payload. The payload has to stay the exact string every deployed peer compares against -
     * changing it would make this peer invisible to them - and properties are what MQTT 5 has for
     * exactly this: data beside the message that old readers never look at. MQTT 3.1.1 has no
     * properties, so there the shape simply does not travel and caches age out as they do today.
     */
    private async publishPresence() {
        await this.client?.publishAsync(this.presenceTopic(this.name), PRESENCE_ONLINE, {
            qos: this.qos,
            retain: true,
            ...(this.protocol === 5 && this.shape ? { properties: { userProperties: { shape: this.shape } } } : {})
        })
    }

    /**
     * Set what this peer's surface hashes to, republishing the retained announcement if the change
     * happens on a live connection - retained, so even a peer that subscribes next week learns the
     * current hash with the presence itself.
     */
    announceShape(shape: string) {
        if (this.shape === shape) return
        this.shape = shape
        if (this.connected && this.announcePresence) void this.publishPresence().catch((e) => this.emit(TransportEvent.transportError, e))
    }

    /** Checked and deduplicated before anyone hears about it - see TransportEvent.peerShape. */
    private noteShape(peer: string, shape: unknown) {
        if (!isUsableShape(shape)) return
        if (this.peerRegistry.noteShape(peer, shape)) this.emit(TransportEvent.peerShape, peer, shape)
    }

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
        this.tap = options.tap ?? false
        this.persistentSession = options.persistentSession ?? false
        this.sharedGroup = options.sharedGroup
        this.allowResponseTopic = options.allowResponseTopic
        this.replicaId = options.replicaId ?? uint8ArrayToBase64(globalThis.crypto.getRandomValues(new Uint8Array(6)))
        // A replica keeps no session: its share of the queue would never be drained if it stayed
        // down, and the broker would hold messages for a process that is not coming back.
        this.sessionExpirySeconds = options.sessionExpirySeconds ?? (this.sharedGroup ? 0 : this.persistentSession ? 3600 : 60)
        // Presence describes one connection. A replica's will would announce the whole shared name
        // as offline when a single process stops, and its siblings' retained 'online' would fight
        // with it. Replicas therefore observe presence without announcing their own.
        this.announcePresence = this.presence && !this.sharedGroup
        this.mqttOptions = options.allowInsecureTls ? { rejectUnauthorized: false, ...options.mqtt } : (options.mqtt ?? {})
        if (options.allowInsecureTls && /^(mqtts|wss|ssl|tls):/.test(this.url))
            console.warn(
                `source-rpc: '${name}' is connecting to ${this.url} with allowInsecureTls, so the broker's certificate is not checked. ` +
                    "Anything able to answer on that address can read and rewrite this peer's traffic. Use it for a development broker, not a plant."
            )
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
            if (wasConnected) {
                this.noteConnectionLength()
                this.emit(TransportEvent.disconnected, 'close')
            }
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

    private connectedSince = 0
    /** Consecutive connections that did not survive long enough to be doing anything useful. */
    private shortConnections = 0

    /**
     * The 3.1.1 half of collision reporting, which has to be inferred rather than read.
     *
     * MQTT 5 says why it disconnected you; 3.1.1 has no reason codes, so a session taken over looks
     * exactly like the link dropping. What it does not look like is a *stable* connection: two
     * peers sharing a client id evict each other on sight, so both sit in a reconnect loop where no
     * connection outlives the next one's arrival. A blip reconnects once and stays.
     *
     * Reported as a suspicion rather than a fact, because a network flapping this hard would look
     * the same - and either way it is worth saying out loud.
     */
    private noteConnectionLength() {
        const lifetime = Date.now() - this.connectedSince
        this.shortConnections = lifetime < STABLE_CONNECTION_MS ? this.shortConnections + 1 : 0
        if (this.shortConnections >= SUSPICIOUS_RECONNECTS) this.warnAboutFlapping()
    }

    private warnedAboutFlapping = false
    private warnAboutFlapping() {
        if (this.warnedAboutFlapping) return
        this.warnedAboutFlapping = true
        console.warn(
            `source-rpc: '${this.name}' has lost its broker connection ${this.shortConnections} times in a row without staying up. ` +
                'The usual cause is a second peer running under this name, since both use the same client id and evict each other. ' +
                'MQTT 3.1.1 gives no reason for a disconnect, so this is a guess - MQTT 5 would say so outright.'
        )
    }

    /** Said once: mqtt.js reconnects on its own, and two peers sharing a name take turns forever. */
    private warnedAboutDisplacement = false
    private warnAboutDisplacement() {
        this.emit(TransportEvent.peerDisplaced, this.name)
        if (this.warnedAboutDisplacement) return
        this.warnedAboutDisplacement = true
        console.warn(
            `source-rpc: '${this.name}' was disconnected because another connection claimed its broker session, which means a second peer is running under this name. ` +
                'Both will keep taking the connection from each other, and calls to either will reach whichever holds it. Give them distinct names.'
        )
    }

    private async onConnect() {
        this.connected = true
        this.connectedSince = Date.now()
        try {
            // A tap watches every peer's channel rather than its own, and only that: subscribing to
            // both would overlap, and a broker may deliver a message once per matching subscription.
            const watched = this.tap ? '+' : this.topic
            if (this.protocol === 5) {
                for (const channel of this.channels) {
                    const topic = this.channelTopic(channel, watched)
                    // Only requests are shared: replies and events must reach one specific peer.
                    const filter = channel === 'req' && this.sharedGroup && !this.tap ? `$share/${this.sharedGroup}/${topic}` : topic
                    await this.client?.subscribeAsync(filter, { qos: this.qos })
                }
            } else await this.client?.subscribeAsync(this.rpcTopic(watched), { qos: this.qos })
            if (this.presence) {
                // Observed even by replicas, which still need to know when their own peers depart.
                await this.client?.subscribeAsync(this.presenceTopic('+'), { qos: this.qos })
                if (this.announcePresence) await this.publishPresence()
                // The subscribe is acknowledged, so the retained burst is on its way - the quiet
                // gap that ends it starts counting now, not at connect.
                this.armSweepQuiet()
            }
        } catch (e) {
            // Including a failed presence subscribe: no burst is coming, so nothing to wait for.
            this.settleSweep()
            this.emit(TransportEvent.transportError, e)
        }
        // Only now is inbound traffic actually reachable. Announcing earlier would let a client
        // replay its subscriptions before this transport could receive the answers.
        this.readyFlag = true
        this.emit(TransportEvent.connected)
    }

    private async onBrokerMessage(topic: string, messageBuffer: Buffer, packet?: IPublishPacket) {
        if (this.presence && topic.startsWith(this.presenceRoot)) {
            // Still mid-burst: push the quiet gap back. Every presence message counts, including
            // this transport's own name and tombstones, because each one proves the broker is
            // still delivering retained state.
            this.armSweepQuiet()
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
                // The shape rides beside the payload as a user property - see publishPresence.
                // Noted before peerOnline, so a listener reacting to the arrival already finds the
                // hash in the registry when it looks.
                const announced = packet?.properties?.userProperties?.shape
                if (announced !== undefined) this.noteShape(peer, Array.isArray(announced) ? announced[0] : announced)
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
        // Before the signature check and instead of delivery: a tap holds no key for a conversation
        // it is not part of, and it must not act on what it is only watching.
        if (this.tap) return this.report(payload as Uint8Array, header.source, this.topicAddressee(topic) ?? header.target)
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
        // An unknown content type used to fall back to msgpack, which is a guess about how to read
        // bytes somebody else chose - and the guess decides what the values mean.
        const declared = properties?.contentType
        if (declared && declared !== msgPackCodec.contentType && declared !== jsonCodec.contentType) {
            this.emit(TransportEvent.rejected, { source, reason: `unknown content type '${declared}'` })
            return
        }
        const body = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
        const correlation = correlationToString(properties?.correlationData)
        // Only a request may say where its answer goes; a reply or an event carrying the property is
        // saying nothing this peer acts on. Read before the policy is applied, because the signature
        // covers what arrived either way.
        const responseTopic = isRequestKind(values[MR.kind]) ? properties?.responseTopic : undefined
        // The policy is about publishing there, so it applies to a peer that will answer and not to
        // a tap, whose job is to show what is on the wire rather than to have opinions about it.
        if (responseTopic !== undefined && !this.tap) {
            const refusal = this.refuseResponseTopic(responseTopic, source)
            if (refusal) {
                // Refused rather than quietly answered on the derived topic: a caller that named a
                // topic is waiting on that topic, and a reply it never sees is a call that hangs.
                this.emit(TransportEvent.rejected, { source, reason: refusal })
                return
            }
        }

        if (this.verify) {
            const rejection = await this.verifyV5({ topic, responseTopic, values, correlation, body, contentType: properties?.contentType })
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
        // Recorded before dispatch so the reply can mirror it. Not for a tap, which replies to
        // nothing and would otherwise keep a note about every request on the network.
        if (correlation && !this.tap) this.rememberReply(correlation, properties?.contentType, responseTopic)
        const message = fromInboundFrame({
            kind: values[MR.kind],
            correlation,
            path: values[MR.path],
            method: values[MR.method],
            event: values[MR.event],
            code: values[MR.code],
            version: values[MR.contractVersion],
            ttl: this.remainingTtl(values[MR.ttl], properties?.messageExpiryInterval),
            idempotencyKey: values[MR.idempotencyKey],
            body: decoded
        })
        if (!message) {
            this.emit(TransportEvent.rejected, { source, reason: `unrecognised frame kind '${values[MR.kind]}'` })
            return
        }
        // Watched rather than acted on: see the note in the v1 path above.
        if (this.tap) {
            if (this.listenerCount(TransportEvent.relayed))
                this.emit(TransportEvent.relayed, { source, target: this.topicAddressee(topic) ?? this.name, message } satisfies RelayedFrame)
            return
        }
        this.setKnownSource(source)
        // The addressee is in the topic under the MQTT 5 layout. It is this peer for everything it
        // subscribed to for itself, and someone else for a topic it watches on their behalf.
        await this.deliver(message, source, this.topicAddressee(topic) ?? this.name)
    }

    /**
     * A frame this transport is only watching, decoded and announced.
     *
     * The v1 layout carries no properties, so the payload has to be decoded here before anything can
     * be said about it - which is also the only work a tap does per frame, and it is skipped
     * entirely when nothing is listening.
     */
    private report(payload: Uint8Array, source: string, target: string) {
        if (!this.listenerCount(TransportEvent.relayed)) return
        let message: Message
        try {
            message = this.codec.decode(payload) as Message
        } catch (e) {
            this.emit(TransportEvent.rejected, { source, reason: `undecodable frame: ${String(e)}` })
            return
        }
        this.emit(TransportEvent.relayed, { source, target, message } satisfies RelayedFrame)
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
        await refuseDelivery(this, message, source, target, 'TransportError', `no route to '${target}'`)
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

    /**
     * A reason to refuse a response topic, or undefined to publish the answer there.
     *
     * The topic comes from whoever sent the request, and this peer is the one that will publish to
     * it, so without a rule a caller could have a server publish anywhere the broker's ACLs let it -
     * over another peer's presence, into `$SYS`, or onto a retained topic something else reads. The
     * default rule is the transport's own prefix, since that is the boundary an operator already
     * draws ACLs on.
     */
    private refuseResponseTopic(topic: string, source: string) {
        if (!isSafeTopicName(topic)) return `unusable response topic '${String(topic).slice(0, 64)}'`
        if (this.allowResponseTopic) return this.allowResponseTopic(topic, source) ? undefined : `response topic '${topic}' is not allowed here`
        return topic.startsWith(`${this.prefix}/`) ? undefined : `response topic '${topic}' is outside '${this.prefix}/'`
    }

    /**
     * What is left of the caller's stated budget.
     *
     * MQTT 5 requires a server to hand on the Message Expiry Interval it received minus the time
     * the message spent waiting in it, so for a request that was queued this is the caller's budget
     * with the queueing already deducted - measured by the broker, with no clock of ours entering
     * into it. Taken as an upper bound only: expiry is whole seconds and a broker of unknown
     * quality set it, so it may shorten what the caller signed and never lengthen it.
     */
    private remainingTtl(stated: string | undefined, expirySeconds: number | undefined) {
        if (stated === undefined) return undefined
        const ttl = Number(stated)
        if (!Number.isFinite(ttl) || ttl < 0) return undefined
        if (typeof expirySeconds !== 'number' || !Number.isFinite(expirySeconds)) return ttl
        return Math.min(ttl, Math.max(0, expirySeconds) * 1000)
    }

    /**
     * Seconds the broker should hold a request: what its caller said it would wait, rounded up.
     *
     * Clamped to the four-byte field MQTT gives it - about 136 years - because the ttl comes from
     * whatever number a caller set as its timeout, and a value that does not fit would be a packet
     * the broker refuses rather than a request that waits a long time.
     */
    private expiryFor(ttl: number | undefined) {
        if (ttl === undefined || !Number.isFinite(ttl) || ttl <= 0) return this.requestExpirySeconds
        return Math.min(Math.max(1, Math.ceil(ttl / 1000)), 0xffffffff)
    }

    private rememberReply(correlation: string, contentType: string | undefined, topic: string | undefined) {
        // Only what differs from what would be derived anyway, so an ordinary exchange between two
        // of our own peers adds nothing to this map.
        const encoding = contentType && contentType !== this.codec.contentType ? contentType : undefined
        if (!encoding && !topic) return
        this.pendingReplies.set(correlation, { contentType: encoding, topic })
        while (this.pendingReplies.size > this.maxTrackedReplies) {
            const oldest = this.pendingReplies.keys().next()
            if (oldest.done) break
            this.pendingReplies.delete(oldest.value)
        }
    }

    /** One request, one answer: taking it also forgets it. */
    private takeReply(correlation: string) {
        const pending = this.pendingReplies.get(correlation)
        if (pending) this.pendingReplies.delete(correlation)
        return pending
    }

    /** A peer may speak JSON while this one defaults to msgpack; contentType says which. */
    private codecFor(contentType: string | undefined) {
        if (contentType && contentType !== this.codec.contentType) return contentType === jsonCodec.contentType ? jsonCodec : msgPackCodec
        return this.codec
    }

    private async verifyV5(frame: {
        topic: string
        responseTopic?: string
        values: { [key: string]: string }
        correlation?: string
        body: Uint8Array
        contentType?: string
    }) {
        const { topic, values, correlation, body, contentType } = frame
        const signature = values[MR.signature]
        const nonce = values[MR.nonce]
        const timestamp = Number(values[MR.timestamp])
        if (!signature || !nonce) return 'unsigned'
        // The version gate belongs here rather than on the receive path, and the distinction is the
        // whole design of this change. An unsigned frame's version says nothing about security, and
        // refusing one would break plain MQTT 5 peers written against version 1 - which is a feature
        // worth keeping. A *signed* frame announcing version 1 is different: version 1 left the
        // content type, the error code and the contract version out of the signature, so accepting
        // one would leave exactly the hole this closes, and let a sender choose the weaker form.
        const announced = values[MR.version] ?? FRAME_VERSION
        if (!SUPPORTED_FRAME_VERSIONS.has(announced)) return `signed frame version '${announced}', which this build does not accept`
        if (!this.replayGuard.accept(nonce, timestamp)) return 'stale or replayed'
        const source = values[MR.source]
        const canonical = canonicalSignedBytesV5({
            version: values[MR.version] ?? FRAME_VERSION,
            topic,
            responseTopic: frame.responseTopic ?? '',
            source,
            kind: values[MR.kind] ?? '',
            path: values[MR.path] ?? '',
            methodOrEvent: values[MR.method] ?? values[MR.event] ?? '',
            correlation: correlation ?? '',
            // Rebuilt from what arrived, so tampering with any of them fails the signature rather
            // than changing how the payload is read, where the answer is sent, what the caller does
            // about a failure, or whether a command that is already too late still runs.
            contentType: contentType ?? '',
            code: values[MR.code] ?? '',
            contractVersion: values[MR.contractVersion] ?? '',
            ttl: values[MR.ttl] ?? '',
            idempotencyKey: values[MR.idempotencyKey] ?? '',
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
        // A reply goes where its request asked and in the encoding it arrived in; anything else goes
        // to the addressee's own channel in this peer's own encoding.
        const pending = frame.channel === 'rsp' && frame.correlation ? this.takeReply(frame.correlation) : undefined
        const topic = pending?.topic ?? this.channelTopic(frame.channel, target)
        const codec = pending?.contentType ? this.codecFor(pending.contentType) : this.codec
        const body = codec.encode(frame.body)
        // Where this peer wants its own answer. Named explicitly rather than left to the far end to
        // derive, and signed below, because the far end now publishes to it.
        const responseTopic = frame.channel === 'req' ? this.channelTopic('rsp', source) : undefined
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
        if (frame.ttl !== undefined) userProperties[MR.ttl] = String(frame.ttl)
        if (frame.idempotencyKey) userProperties[MR.idempotencyKey] = frame.idempotencyKey

        if (this.sign) {
            const nonce = createNonce()
            const timestamp = Date.now()
            const canonical = canonicalSignedBytesV5({
                version: FRAME_VERSION,
                topic,
                responseTopic: responseTopic ?? '',
                source,
                kind: frame.kind,
                path: frame.path ?? '',
                methodOrEvent: frame.method ?? frame.event ?? '',
                correlation: frame.correlation ?? '',
                contentType: codec.contentType,
                code: frame.code ?? '',
                contractVersion: frame.version ?? '',
                ttl: frame.ttl !== undefined ? String(frame.ttl) : '',
                idempotencyKey: frame.idempotencyKey ?? '',
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
                // Only a request expects an answer, and only a request should expire. The expiry is
                // the caller's own remaining time, so the broker stops holding the request at the
                // moment the caller stops waiting for it - the two used to be set independently,
                // and a request outlived its caller's patience by twenty seconds by default.
                ...(responseTopic ? { responseTopic, messageExpiryInterval: this.expiryFor(frame.ttl) } : {}),
                userProperties
            }
        })
    }

    override async close() {
        // A waiter on the sweep must not outlive the transport.
        this.settleSweep()
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
