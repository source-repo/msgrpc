import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcSchema, RpcServer } from '@source-repo/msgrpc'
import { History, Plant } from './PlantService.js'

/**
 * Run with:  node dist-examples/server.js  (or ts-node), broker on localhost:1883
 *
 * The schema is the file `msgrpc extract` wrote. With it loaded the server refuses arguments that
 * do not match, and msgrpc.describe() can report types to the console.
 */
const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(resolve(here, 'msgrpc.types.json'), 'utf8')) as RpcSchema

const broker = process.env.BROKER ?? 'mqtt://localhost:1883'
const server = new RpcServer({
    name: 'plantServer',
    transports: [{ brokerurl: broker, prefix: 'msgrpc/example' }],
    schema,
    exposeIntrospection: true
})

const plant = new Plant()
const history = new History()
plant.on('setpointChanged', (value: number) => history.record(value))

// Exposed before ready(): a resumed session is handed its queued requests the moment it connects.
server.exposeClassInstance(plant)
server.exposeClassInstance(history)
await server.ready()
console.log(`plantServer up on ${broker}, prefix msgrpc/example`)

// Something for the console's event pane to show.
let n = 0
const ticker = setInterval(() => void plant.writeSetpoint(500 + (n++ % 5) * 100), 4000)
const stop = async () => {
    clearInterval(ticker)
    await server.close()
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
