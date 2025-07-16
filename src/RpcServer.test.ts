import anyTest, { TestFn } from 'ava'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import EventEmitter from 'events'

interface Context {
    server: RpcServer
    client: RpcClient
    proxy?: TestRpc
}

class TestRpc extends EventEmitter {
    constructor(public base: number = 0) {
        super()
    }
    async add(a: number, b: number) {
        console.log(`TestRpc.add ${a} ${b} base: ${this.base}`)
        return this.base + a + b
    }
    triggerEvent() {
        this.emit('hejsan', 1, 2, 3, 4)
    }
}

const test = anyTest as TestFn<Context>

test.serial.before((t) => {
    t.context.server = new RpcServer({ transports: [new MqttTransport('', 'mqtt://localhost:1883')] })
    const testRpc = new TestRpc(10)
    t.context.server.exposeClassInstance(testRpc, 'testRpc')
})

test.serial.before(async (t) => {
    t.context.client = new RpcClient(undefined, { transport: new MqttTransport('', 'mqtt://localhost:1883') })
    await t.context.client.ready()
    t.context.proxy = (await t.context.client.proxy<TestRpc>('testRpc')).remote
})

test('foo', (t) => {
    t.pass()
})

test('bar', async (t) => {
    const sum = await t.context.proxy?.add(5, 6)
    t.is(sum, 11)
})
