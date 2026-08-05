import test from 'ava'
import { SparkplugBirthDeathSequence, SparkplugSequence } from './Sequence.js'

test('Sparkplug seq wraps in the required 0..255 range', (t) => {
    const seq = new SparkplugSequence(254)
    t.is(seq.next(), 254)
    t.is(seq.next(), 255)
    t.is(seq.next(), 0)
    t.is(seq.peek(), 1)
})

test('bdSeq claims wrap independently from data seq', (t) => {
    const bdSeq = new SparkplugBirthDeathSequence(255)
    t.deepEqual(bdSeq.claimBirth(), { bdSeq: 255 })
    t.deepEqual(bdSeq.claimBirth(), { bdSeq: 0 })
})
