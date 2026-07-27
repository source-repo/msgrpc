import anyTest, { TestFn } from 'ava'
import { connectAsync } from 'mqtt'
import { MqttTransport, RpcClient, RpcServer } from './index.js'
import EventEmitter from 'events'

/**
 * End-to-end over a real MQTT broker. Needs one on localhost:1883 - docker-compose/ brings up
 * EMQX for this. Without a broker these tests skip rather than hang the suite.
 */
const BROKER_URL = process.env.MSGRPC_TEST_BROKER ?? 'mqtt://localhost:1883'

const brokerAvailable = async () => {
    try {
        const probe = await connectAsync(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0 })
        await probe.endAsync()
        return true
    } catch {
        return false
    }
}

interface Context {
    server?: RpcServer
    client?: RpcClient
    proxy?: TestRpc
    skipped: boolean
}

class TestRpc extends EventEmitter {
    constructor(public base: number = 0) {
        super()
    }
    async add(a: number, b: number) {
        return this.base + a + b
    }
    triggerEvent() {
        this.emit('hejsan', 1, 2, 3, 4)
    }
}

const test = anyTest as TestFn<Context>

test.serial.before(async (t) => {
    t.context = { skipped: !(await brokerAvailable()) }
    if (t.context.skipped) return

    t.context.server = new RpcServer({ name: 'mqttTestServer', transports: [new MqttTransport('mqttTestServer', BROKER_URL)] })
    t.context.server.exposeClassInstance(new TestRpc(10), 'testRpc')

    t.context.client = new RpcClient(undefined, {
        transport: new MqttTransport('mqttTestClient', BROKER_URL),
        defaultTarget: 'mqttTestServer'
    })
    await t.context.client.ready()
    t.context.proxy = (await t.context.client.proxy<TestRpc>('testRpc')).remote
})

test.serial('a call is answered over MQTT', async (t) => {
    if (t.context.skipped) {
        t.pass(`no MQTT broker at ${BROKER_URL} - skipped`)
        return
    }
    t.is(await t.context.proxy?.add(5, 6), 21)
})

test.serial.after.always(async (t) => {
    await t.context.client?.close()
    await t.context.server?.close()
})
