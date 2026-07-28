import { SocketIoServerTransport, RpcServer, MqttTransport } from '../../src/index.js'
import { ITestRpc } from './ITestRpc.js'
import EventEmitter from 'events'
import http from 'http'

let port = 3000
if (process.argv[2]) port = parseInt(process.argv[2])

export class TestRpc extends EventEmitter implements ITestRpc {
    constructor(public base: number = 0) {
        super()
    }
    async add(a: number, b: number) {
        console.log(`TestRpc.add ${a} ${b} base: ${this.base}`)
        return this.base + a + b
    }
    async extendBuffer(b: Uint8Array) {
        const result = new Uint8Array(1000)
        result.set(b, 10)
        return result
    }
    triggerEvent() {
        this.emit('hejsan', 1, 2, 3, 4)
    }
}

export class DataProvider {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getList(...args: unknown[]) {
        return { value: 'abc', data: [] }
    }
}

const main = async () => {
    let name = 'rpcServer1'
    if (port !== 3000) name = 'rpcServer2'
    const server = http.createServer()
    for (;;) {
        try {
            const transport = new SocketIoServerTransport(name, server, port, false, [], {
                /*path: '/test'*/
            })
            const transport2 = new MqttTransport(name, 'mqtt://emqx-service:1883')
            //const transport2 = new MqttTransport(true, 'mqtt://localhost:1883', name)
            const testRpc = new TestRpc(10)

            const rpcServerConnection = new RpcServer({ transports: [transport, transport2] })

            // Expose a function
            rpcServerConnection.rpc?.manageRpc.exposeObject(
                {
                    hello: (arg: string) => {
                        console.log(arg)
                        return arg + ' world!'
                    }
                },
                'MyRpc'
            )

            rpcServerConnection.rpc?.manageRpc.exposeClassInstance(testRpc, 'testRpc')
            rpcServerConnection.rpc?.manageRpc.exposeClass(TestRpc)
            const dataProvider = new DataProvider()
            rpcServerConnection.rpc?.manageRpc.exposeClassInstance(dataProvider, 'dataProvider')

            server.listen(port, '127.0.0.1', () => {
                console.log(`Server listening on port ${port}`)
            })

            /*
            server.listen(port, () => {
                console.log(`Server listening on port ${port}`);
            });    */

            for (;;) {
                await new Promise((res) => setTimeout(res, 5000))
                rpcServerConnection.rpc?.manageRpc.logger?.log('Information', 'Hello')
                testRpc.emit('hejsan', 1, 2, 5)
                testRpc.emit('svejsan', Math.PI)
            }
        } catch (e) {
            console.log(e)
        }
        await new Promise((res) => setTimeout(res, 5000))
    }
}

main()
