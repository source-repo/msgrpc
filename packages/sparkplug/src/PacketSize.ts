export const DEFAULT_SPARKPLUG_MAX_PACKET_BYTES = 1024 * 1024
export const MAXIMUM_SPARKPLUG_PACKET_BYTES = 268_435_455

const textEncoder = new TextEncoder()

/** Upper bound for MQTT 3.1.1 and 5: maximum remaining-length header plus MQTT 5 property length. */
export function sparkplugMqttPacketBytes(topic: string, payload: Uint8Array, qos: 0 | 1): number {
    const topicBytes = textEncoder.encode(topic).length
    return 1 + 4 + 2 + topicBytes + (qos === 0 ? 0 : 2) + 1 + payload.length
}

export function assertSparkplugPacketFits(options: {
    readonly topic: string
    readonly payload: Uint8Array
    readonly qos: 0 | 1
    readonly maxPacketBytes: number
}): number {
    const packetBytes = sparkplugMqttPacketBytes(options.topic, options.payload, options.qos)
    if (packetBytes > options.maxPacketBytes)
        throw new Error(
            `Sparkplug packet for ${options.topic} is ${packetBytes} bytes, exceeding maxPacketBytes ${options.maxPacketBytes}; one snapshot must fit one MQTT packet`
        )
    return packetBytes
}
