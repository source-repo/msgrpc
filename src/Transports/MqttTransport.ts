import * as mqtt from 'mqtt'

import { GenericModule, IGenericModule, TransportEvent } from '../RPC/Core.js'

export class MqttTransport extends GenericModule<string | Uint8Array, unknown, string | Uint8Array, unknown> {
    client?: mqtt.MqttClient
    connected = false

    constructor(
        name: string,
        public url: string,
        public topic?: string,
        sources?: IGenericModule<unknown, unknown, string, unknown>[],
        /**
         * Broker connection options. MQTT has no server-side handshake to authenticate against,
         * so peer trust comes from the broker: set username/password or TLS client certificates
         * here and restrict topics with broker ACLs. These used to be ignored entirely.
         */
        public mqttOptions: mqtt.IClientOptions = {}
    ) {
        super(name, sources)
        if (!this.topic) this.topic = this.name
        this.open()
    }

    topicName(target: string) {
        const result = 'emellio_v0.0/' + target
        return result
    }

    override async open() {
        // Idempotent for the same reason as the socket.io client transport: the constructor opens
        // and RpcClient.init() opens again, which would leave a second broker connection behind.
        if (this.client) return
        this.client = mqtt.connect(this.url, this.mqttOptions)
        this.client.on('message', async (topic, messageBuffer) => {
            const message = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
            const [header, payload] = this.extractHeader(message)
            if (header && this.targetExists(header.target)) await this.send(payload, header.source, header.target)
        })
        // mqtt.js reconnects on its own and re-emits 'connect', so the subscription is renewed on
        // every transition. readyFlag tracks the actual link: it used to be set unconditionally
        // below, which reported ready even when the broker was unreachable.
        this.client.on('connect', () => {
            this.connected = true
            this.readyFlag = true
            this.client?.subscribe(this.topicName(this.topic!))
            this.emit(TransportEvent.connected)
        })
        this.client.on('close', () => {
            const wasConnected = this.connected
            this.connected = false
            this.readyFlag = false
            if (wasConnected) this.emit(TransportEvent.disconnected, 'close')
        })
    }

    override async receive(message: string | Uint8Array, source: string, target: string) {
        if (typeof message === 'string') this.client?.publish(this.topicName(target), this.prependHeader(source, target, message) as string)
        else {
            const messageArray = this.prependHeader(source, target, message) as Uint8Array
            const buffer = Buffer.from(messageArray.buffer, messageArray.byteOffset, messageArray.byteLength)
            this.client?.publish(this.topicName(target), buffer)
        }
    }

    override async close() {
        // GenericModule.close() is a no-op, so without this the broker connection stayed open and
        // kept reconnecting after the transport was discarded.
        const client = this.client
        this.client = undefined
        this.connected = false
        this.readyFlag = false
        await client?.endAsync()
    }

    override isTransport() {
        return true
    }
}
