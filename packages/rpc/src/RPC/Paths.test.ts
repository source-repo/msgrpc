import test from 'ava'
import { rpcPath, rpcRoot, rpcWrites, type RpcPathNode, type RpcPathOf, type RpcPathValue, type RpcPathWriter, type RpcTypedPath } from './Paths.js'

/**
 * Typed paths: the half of a generic setter that a string cannot check. What is proven here is the
 * runtime shape; the compile-time half is proven by the fact that the type errors below are
 * commented out rather than caught, since a test that compiles cannot assert that something does
 * not.
 */

interface Zone {
    temperature: number
    setpoint: number
}

interface Reading {
    value: number
    quality: 'good' | 'bad'
}

interface OvenState {
    temperature: number
    mode: 'idle' | 'heating'
    zones: { top: Zone; bottom: Zone }
    readings: { [tag: string]: Reading }
    history?: Zone[]
}

const state = rpcRoot<OvenState>()

test('a path is the properties that were read from the root', (t) => {
    t.deepEqual(rpcPath(state.mode), ['mode'])
    t.deepEqual(rpcPath(state.zones.top.setpoint), ['zones', 'top', 'setpoint'])
})

test('a record key and an array index are ordinary segments', (t) => {
    t.deepEqual(rpcPath(state.readings['flue.temp'].quality), ['readings', 'flue.temp', 'quality'])
    t.deepEqual(rpcPath(state.history![2].temperature), ['history', '2', 'temperature'])
})

test('the type at the end of a path is recoverable, which is what checks the value written there', (t) => {
    // Compile-time assertions: each fails to compile if the phantom member stops carrying the type.
    const setpoint: RpcPathValue<RpcPathOf<OvenState>['zones']['top']['setpoint']> = 180
    const mode: RpcPathValue<RpcPathOf<OvenState>['mode']> = 'heating'
    t.is(setpoint, 180)
    t.is(mode, 'heating')

    // @ts-expect-error a string is not a setpoint, and the path knows it
    const wrong: RpcPathValue<RpcPathOf<OvenState>['zones']['top']['setpoint']> = 'hot'
    t.is(String(wrong), 'hot')

    // @ts-expect-error `sepoint` is not a field, so the path does not exist to be taken
    t.deepEqual(rpcPath(state.zones.top.sepoint), ['zones', 'top', 'sepoint'])
})

test('the path carries its type, so a signature can check what is written and type what is read', (t) => {
    // The point of RpcTypedPath: these signatures are what a generic setter and getter would have.
    // `NoInfer` on the value is load-bearing - without it the value is a second inference site for
    // V, so passing a wrong one widens V to include it and the check quietly evaporates.
    const write = <V>(_path: RpcTypedPath<V>, _value: NoInfer<V>) => undefined
    const read = <V>(_path: RpcTypedPath<V>): V => undefined as V

    write(rpcPath(state.zones.top.setpoint), 180)
    write(rpcPath(state.mode), 'heating')
    // @ts-expect-error the path ends at a number, so a word is not a value for it
    write(rpcPath(state.zones.top.setpoint), 'hot')
    // @ts-expect-error `boiling` is not one of the modes the state declares
    write(rpcPath(state.mode), 'boiling')

    // Read back with no cast: the answer is typed by where it came from.
    const setpoint: number = read(rpcPath(state.zones.top.setpoint))
    const quality: 'good' | 'bad' = read(rpcPath(state.readings['flue.temp'].quality))
    void setpoint
    void quality

    // A hand-written path still passes, and degrades to unknown rather than erroring.
    write(['zones', 'top', 'setpoint'], 'anything at all')
    t.pass()
})

test('RpcPathWriter is that signature, ready to hand to proxy<T>()', (t) => {
    // The shape a caller asks for. The served method is concrete - `set(path: string[], value:
    // unknown)` - because extract has to describe it in a runtime type language and refuses
    // `NoInfer<V>` outright. This is the compile-time half, recovered on the calling side.
    const writer = { set: async () => undefined } as unknown as RpcPathWriter

    void writer.set(rpcPath(state.zones.top.setpoint), 180)
    void writer.set(rpcPath(state.mode), 'heating')
    // @ts-expect-error the path ends at a number, so a word is not a value for it
    void writer.set(rpcPath(state.zones.top.setpoint), 'hot')
    // @ts-expect-error `boiling` is not one of the modes the state declares
    void writer.set(rpcPath(state.mode), 'boiling')

    t.pass()
})

test('something that is not a path from a root is refused rather than sending an empty one', (t) => {
    t.throws(() => rpcPath('zones.top.setpoint' as unknown as RpcPathNode<number>), { message: /expects a property of an rpcRoot/ })
})

test('a draft collects assignments in order, as one list for one call', (t) => {
    const writes = rpcWrites<OvenState>((state) => {
        state.zones.top.setpoint = 180
        state.mode = 'heating'
        state.readings['flue.temp'].quality = 'bad'
    })

    t.deepEqual(writes, [
        { path: ['zones', 'top', 'setpoint'], value: 180 },
        { path: ['mode'], value: 'heating' },
        { path: ['readings', 'flue.temp', 'quality'], value: 'bad' }
    ])
})

test('two writes to one path stay two writes, in order - collapsing them is the receiver\'s business', (t) => {
    const writes = rpcWrites<OvenState>((state) => {
        state.mode = 'heating'
        state.mode = 'idle'
    })
    t.deepEqual(writes, [
        { path: ['mode'], value: 'heating' },
        { path: ['mode'], value: 'idle' }
    ])
})

test('a draft that writes nothing sends nothing', (t) => {
    t.deepEqual(rpcWrites<OvenState>(() => undefined), [])
})
