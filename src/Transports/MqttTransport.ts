import * as mqtt from 'mqtt'

import { GenericModule, IGenericModule, TransportEvent } from '../RPC/Core.js'

export const defaultTopicPrefix = 'msgrpc/v1'

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
}

export class MqttTransport extends GenericModule<string | Uint8Array, unknown, string | Uint8Array, unknown> {
    client?: mqtt.MqttClient
    connected = false
    readonly prefix: string
    readonly topic: string
    readonly qos: 0 | 1 | 2
    readonly presence: boolean
    readonly persistentSession: boolean
    readonly mqttOptions: mqtt.IClientOptions

    constructor(
        name: string,
        public url: string,
        options: MqttTransportOptions = {},
        sources?: IGenericModule<unknown, unknown, string, unknown>[]
    ) {
        super(name, sources)
        this.prefix = options.prefix ?? defaultTopicPrefix
        this.topic = options.topic ?? this.name
        this.qos = options.qos ?? 1
        this.presence = options.presence ?? true
        this.persistentSession = options.persistentSession ?? false
        this.mqttOptions = options.mqtt ?? {}

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
            ...this.mqttOptions,
            clean: this.mqttOptions.clean ?? !this.persistentSession,
            will: this.presence
                ? { topic: this.presenceTopic(this.name), payload: Buffer.from(PRESENCE_OFFLINE), qos: this.qos, retain: true }
                : this.mqttOptions.will
        })
        this.client.on('message', (topic, messageBuffer) => void this.onBrokerMessage(topic, messageBuffer))
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
            await this.client?.subscribeAsync(this.rpcTopic(this.topic), { qos: this.qos })
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

    private async onBrokerMessage(topic: string, messageBuffer: Buffer) {
        if (this.presence && topic.startsWith(this.presenceRoot)) {
            const peer = topic.slice(this.presenceRoot.length)
            // Retained presence means a late subscriber also learns about peers that already left.
            if (peer && peer !== this.name && messageBuffer.toString() === PRESENCE_OFFLINE) this.emit(TransportEvent.peerGone, peer)
            return
        }
        const message = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
        const [header, payload] = this.extractHeader(message)
        if (!header) return
        if (!isSafeTopicSegment(header.source)) {
            // Replies are addressed by source, so an unsafe one cannot be answered anyway.
            this.emit(TransportEvent.rejected, { source: header.source, reason: 'unsafe peer name' })
            return
        }
        if (this.targetExists(header.target)) await this.send(payload, header.source, header.target)
    }

    override async receive(message: string | Uint8Array, source: string, target: string) {
        if (!isSafeTopicSegment(target)) {
            this.emit(TransportEvent.unroutable, { source, target, reason: 'unsafe peer name' })
            return
        }
        const framed = this.prependHeader(source, target, message)
        const payload = typeof framed === 'string' ? framed : Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength)
        // Awaited, so at QoS > 0 a publish that never reaches the broker surfaces as a failed call
        // rather than a silent drop followed by a timeout.
        await this.client?.publishAsync(this.rpcTopic(target), payload, { qos: this.qos })
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

    override isTransport() {
        return true
    }
}
