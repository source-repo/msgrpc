import test from 'ava'
import { assertSparkplugPacketFits, sparkplugMqttPacketBytes } from './PacketSize.js'

test('MQTT packet estimates include a conservative header, UTF-8 topic bytes and QoS packet ID', (t) => {
    const payload = new Uint8Array(10)

    t.is(sparkplugMqttPacketBytes('spBv1.0/DDATA/plant-a/edge-01/pump-7', payload, 0), 54)
    t.is(sparkplugMqttPacketBytes('spBv1.0/DDATA/plänt-a/edge-01/pump-7', payload, 1), 57)
})

test('packet limits fail closed before MQTT handoff', (t) => {
    const options = { topic: 'spBv1.0/DDATA/plant-a/edge-01/pump-7', payload: new Uint8Array(10), qos: 0 as const, maxPacketBytes: 53 }

    t.throws(() => assertSparkplugPacketFits(options), { message: /54 bytes.*maxPacketBytes 53.*one snapshot/ })
})
