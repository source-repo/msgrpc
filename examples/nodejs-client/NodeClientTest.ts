// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { RpcClient } from '../../src/RpcClient.js'
//import { MqttTransport } from '../../src/Transports/Mqtt.js'
import { ITestRpc } from '../nodejs-server/ITestRpc.js'

const main = async () => {
    if (process.env.START_DELAY) await new Promise((res) => setTimeout(res, parseInt(process.env.START_DELAY!)))
    for (;;) {
        try {
            const client = new RpcClient('http://localhost:3000')
            await client.ready()
            const proxy = await client.proxy<ITestRpc>('testRpc')
            const proxyHello = await client.proxy<{ hello: (arg: string) => string }>('MyRpc')

            await proxy.remote?.on('hejsan', (...args: unknown[]) => {
                console.log('Event hejsan: ' + args)
            })

            const newInstance = await client.manageRpc?.createRpcInstance('TestRpc', undefined, 1000)
            if (newInstance) {
                const newInstanceRpc = await client.proxy<ITestRpc>(newInstance)
                const sum = await newInstanceRpc.remote?.add(5, 6)
                console.log('Sum: ' + sum)
                for (;;) {
                    // Should output Hello World!
                    const response = await proxyHello.remote?.hello('Hello')
                    console.log('Response: ' + response)
                    try {
                        const answer = await proxy.remote?.add(1000, 2000)
                        console.log('proxy3 Add ' + answer)
                        const b = new Uint8Array(50)
                        b[0] = 33
                        //const buf = await proxy.extendBuffer(b)
                        //console.log(buf)
                        await new Promise((res) => setTimeout(res, 1000))
                    } catch (e) {
                        console.log('Exception: ', e)
                    }
                }
            }
        } catch (e) {
            console.log(e)
        }
        await new Promise((res) => setTimeout(res, 5000))
    }
}

main()
