import test from 'ava'
import { decodeHostStatePayload, deviceTopic, encodeHostStatePayload, hostStateTopic, nodeTopic, parseSparkplugTopic } from './Types.js'

test('topics are built in the Sparkplug namespace', (t) => {
    t.is(nodeTopic('NBIRTH', { groupId: 'plant-a', edgeNodeId: 'edge-01' }), 'spBv1.0/NBIRTH/plant-a/edge-01')
    t.is(deviceTopic('DDATA', { groupId: 'plant-a', edgeNodeId: 'edge-01', deviceId: 'pump-7' }), 'spBv1.0/DDATA/plant-a/edge-01/pump-7')
    t.is(hostStateTopic('primary-host'), 'spBv1.0/STATE/primary-host')
})

test('unsafe topic segments are rejected at the producer boundary', (t) => {
    t.throws(() => nodeTopic('NBIRTH', { groupId: 'plant/a', edgeNodeId: 'edge-01' }), { message: /groupId/ })
    t.throws(() => nodeTopic('NBIRTH', { groupId: 'plant-a', edgeNodeId: '+' }), { message: /edgeNodeId/ })
})

test('topics parse back to their addresses', (t) => {
    t.deepEqual(parseSparkplugTopic('spBv1.0/NBIRTH/plant-a/edge-01'), {
        namespace: 'spBv1.0',
        type: 'NBIRTH',
        groupId: 'plant-a',
        edgeNodeId: 'edge-01'
    })
    t.deepEqual(parseSparkplugTopic('spBv1.0/DDATA/plant-a/edge-01/pump-7'), {
        namespace: 'spBv1.0',
        type: 'DDATA',
        groupId: 'plant-a',
        edgeNodeId: 'edge-01',
        deviceId: 'pump-7'
    })
    t.deepEqual(parseSparkplugTopic('spBv1.0/STATE/primary-host'), {
        namespace: 'spBv1.0',
        type: 'STATE',
        hostId: 'primary-host'
    })
})

test('Host STATE payloads encode and decode as Sparkplug JSON', (t) => {
    const bytes = encodeHostStatePayload({ online: true, timestamp: 1234 })

    t.deepEqual(decodeHostStatePayload('primary-host', bytes), {
        hostId: 'primary-host',
        online: true,
        timestamp: 1234
    })
})

test('Host STATE payloads must carry boolean online', (t) => {
    t.throws(() => decodeHostStatePayload('primary-host', new TextEncoder().encode('{}')), { message: /boolean online/ })
    t.throws(() => decodeHostStatePayload('primary-host', new TextEncoder().encode('not json')), { instanceOf: SyntaxError })
})
