import * as mqtt from 'mqtt'

import { GenericModule, IGenericModule } from '../RPC/Core.js'

export class MqttTransport extends GenericModule<string | Uint8Array, unknown, string | Uint8Array, unknown> {
    client?: mqtt.MqttClient
    connected = false

    constructor(
        name: string,
        public url: string,
        public topic?: string,
        sources?: IGenericModule<unknown, unknown, string, unknown>[]
    ) {
        super(name, sources)
        if (!this.topic) this.topic = this.name
        this.open()
    }

    topicName(target: string) {
        const result = 'emellio_v0.0/' + target
        return result
    }

    async open() {
        this.client = mqtt.connect(this.url)
        this.client.on('message', async (topic, messageBuffer) => {
            const message = new Uint8Array(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength)
            const [header, payload] = this.extractHeader(message)
            if (header && this.targetExists(header.target)) await this.send(payload, header.source, header.target)
        })
        this.client.on('connect', () => {
            this.connected = true
            this.client?.subscribe(this.topicName(this.topic!))
        })
        this.client.on('close', () => {
            this.connected = false
        })
        this.readyFlag = true
    }

    async receive(message: string | Uint8Array, source: string, target: string) {
        if (typeof message === 'string') this.client?.publish(this.topicName(target), this.prependHeader(source, target, message) as string)
        else {
            const messageArray = this.prependHeader(source, target, message) as Uint8Array
            const buffer = Buffer.from(messageArray.buffer, messageArray.byteOffset, messageArray.byteLength)
            this.client?.publish(this.topicName(target), buffer)
        }
    }

    isTransport() {
        return true
    }
}
