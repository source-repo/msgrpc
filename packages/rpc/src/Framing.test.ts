import test from 'ava'
import { stringToUint8Array } from 'uint8array-extras'
import { GenericModule, MAX_HEADER_LENGTH, MessageHeader } from './RPC/Core.js'
import { jsonCodec, msgPackCodec } from './RPC/Codec.js'

/**
 * The `$`-delimited framing, which every transport but MQTT 5 uses.
 *
 * The header is JSON and the payload follows a '$'. Splitting on the first '$' in the frame was
 * wrong in three separate ways, and all three showed up as traffic disappearing: a peer name
 * containing '$' cut the header mid-string, an unframed JSON payload containing one did the same
 * and threw where nothing caught it, and a header longer than the scan window was never found at all.
 */

const framer = (name = 'framer') => new GenericModule(name)
const header = (extra: Partial<MessageHeader> = {}): MessageHeader => ({ source: 'client', target: 'server', time: 1, seq: 0, ...extra })

test('a payload full of $ does not disturb the split', (t) => {
    const module = framer()
    const body = jsonCodec.encode({ params: ['$', 'price is $100', '$$$'] })
    const [parsed, payload] = module.extractHeader(module.frameMessage(header(), body))

    t.is(parsed?.source, 'client')
    t.deepEqual(jsonCodec.decode(payload as Uint8Array), { params: ['$', 'price is $100', '$$$'] })
})

test('a peer name containing $ survives the round trip', (t) => {
    // The delimiter used to be the first '$' anywhere in the frame, so this one landed inside the
    // quoted source and JSON.parse was handed '{"source":"sensor'.
    const module = framer()
    const body = msgPackCodec.encode({ hello: 'world' })

    for (const [source, target] of [
        ['sensor$1', 'server'],
        ['client', 'plant$north'],
        ['a$b$c', 'd$e$f']
    ]) {
        const [parsed, payload] = module.extractHeader(module.frameMessage(header({ source, target }), body))
        t.is(parsed?.source, source, `source '${source}' did not survive framing`)
        t.is(parsed?.target, target, `target '${target}' did not survive framing`)
        t.deepEqual(msgPackCodec.decode(payload as Uint8Array), { hello: 'world' })
    }
})

test('a peer name containing a quote or a backslash survives too', (t) => {
    // JSON escaping is what the scan has to honour: a '"' inside the name is written as '\"', and a
    // scanner that treated it as the end of the string would misjudge where the header stops.
    const module = framer()
    const source = 'we"ird\\$name'
    const [parsed] = module.extractHeader(module.frameMessage(header({ source }), msgPackCodec.encode({})))
    t.is(parsed?.source, source)
})

test('an unframed JSON payload containing $ is refused, not thrown on', (t) => {
    // Anything at all can be published to an MQTT rpc topic. This used to reach JSON.parse with a
    // truncated string and throw, and on the MQTT path that throw was an unhandled rejection.
    const module = framer()
    const [parsed, , reason] = module.extractHeader(stringToUint8Array('{"cmd":"pay","amount":"$5"}'))

    t.falsy(parsed)
    t.truthy(reason, 'a refused frame must say why')
})

test('garbage of every shape is refused rather than throwing', (t) => {
    const module = framer()
    const frames: (string | Uint8Array)[] = [
        new Uint8Array(0),
        stringToUint8Array('$'),
        stringToUint8Array('{'),
        stringToUint8Array('{"source":"a","targ'),
        stringToUint8Array('{"source":"a"}'), // no delimiter after the object
        stringToUint8Array('{"source":"a"}x'), // wrong byte where the delimiter belongs
        stringToUint8Array('not json at all$body'),
        msgPackCodec.encode({ a: '$$$' }),
        new Uint8Array([0xff, 0xfe, 0x24, 0x00, 0x24])
    ]
    for (const frame of frames) {
        // extractHeader must never throw, so a throw here fails the test by itself.
        const [parsed, , reason] = module.extractHeader(frame)
        t.falsy(parsed)
        t.truthy(reason)
    }
})

test('a header missing a source or a target is refused', (t) => {
    // The target is what the frame is routed on and the source is where the reply goes, so a frame
    // carrying neither cannot be acted on however well-formed its JSON is.
    const module = framer()
    for (const bad of ['{"source":"a"}$body', '{"target":"b"}$body', '{}$body', '[1,2]$body']) {
        const [parsed, , reason] = module.extractHeader(stringToUint8Array(bad))
        t.falsy(parsed, `${bad} should not have parsed`)
        t.truthy(reason)
    }
})

test('a long signed header is delivered rather than silently dropped', (t) => {
    // A nonce and an Ed25519 signature come to about 120 bytes on top of the names, so under the
    // old 256-byte scan window the delimiter was never reached and every such frame vanished at the
    // receiver - with no event, no error, and nothing but a call timeout to go on.
    const module = framer()
    const name = 'plant-controller-north-line-three-cell-seven-panel-a'
    const signed = header({ source: name, target: name, time: Date.now(), nonce: 'n'.repeat(24), sig: 'A'.repeat(88) })

    t.true(JSON.stringify(signed).length > 256, 'this test is pointless unless the header exceeds the old window')

    const [parsed] = module.extractHeader(module.frameMessage(signed, msgPackCodec.encode({ ok: true })))
    t.is(parsed?.source, name)
    t.is(parsed?.sig, 'A'.repeat(88))
})

test('a header that will not fit is refused at the sender', (t) => {
    // The sender is the only party that can do anything about it, and it learns nothing from a
    // frame that leaves correctly and is discarded at the far end.
    const module = framer()
    const huge = 'x'.repeat(MAX_HEADER_LENGTH)
    t.throws(() => module.frameMessage(header({ source: huge }), msgPackCodec.encode({})), { message: /over the \d+ byte limit/ })
})

test('the largest header the library can build still fits', (t) => {
    // Two peer names at the transport limit, a hop count, a nonce and an Ed25519 signature. If this
    // ever stops fitting, frames start disappearing again rather than failing loudly.
    const module = framer()
    const name = 'n'.repeat(128)
    const worst = header({ source: name, target: name, time: Date.now(), seq: Number.MAX_SAFE_INTEGER, hops: 8, nonce: 'n'.repeat(24), sig: 'A'.repeat(88) })
    t.notThrows(() => module.frameMessage(worst, msgPackCodec.encode({})))
})

test('a payload is copied out of the frame, not viewed into it', (t) => {
    // MQTT hands the transport a view over a pooled Node Buffer, which is reused for the next
    // packet the moment the handler returns.
    const module = framer()
    const body = msgPackCodec.encode({ value: 42 })
    const framed = module.frameMessage(header(), body) as Uint8Array
    const [, payload] = module.extractHeader(framed)

    framed.fill(0)
    t.deepEqual(msgPackCodec.decode(payload as Uint8Array), { value: 42 }, 'the payload aliased the frame buffer')
})
