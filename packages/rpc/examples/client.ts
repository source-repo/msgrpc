import { RpcClient } from '@source-repo/rpc'
import type { Plant } from './PlantService.js'

const client = new RpcClient(process.env.BROKER ?? 'mqtt://localhost:1883', {
    name: 'exampleClient',
    defaultTarget: 'plantServer'
})
await client.ready()

const plant = await client.proxy<Plant>('plant')
await plant.on('alarm', (message: string, severity: number) => console.log(`alarm(${severity}): ${message}`))

console.log('setpoint now:', await plant.readSetpoint())
console.log('writing 1200:', await plant.writeSetpoint(1200))
// Refused by the schema before it reaches the method.
await plant.writeSetpoint(9999).catch((e) => console.log('refused:', e.message))

await new Promise((resolve) => setTimeout(resolve, 1000))
await client.close()
