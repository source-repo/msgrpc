import test from 'ava'

import { mqttAuthFromEnvironment } from './network.js'

const withMqttEnvironment = (environment: Record<string, string | undefined>, run: () => void) => {
    const names = ['SOURCE_RPC_MQTT_USERNAME', 'SOURCE_RPC_MQTT_PASSWORD']
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
        for (const name of names) delete process.env[name]
        for (const [name, value] of Object.entries(environment)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
        run()
    } finally {
        for (const name of names) {
            const value = previous[name]
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

test.serial('mqtt credentials can come from the environment', (t) => {
    withMqttEnvironment({ SOURCE_RPC_MQTT_USERNAME: 'plant', SOURCE_RPC_MQTT_PASSWORD: 'secret' }, () => {
        t.deepEqual(mqttAuthFromEnvironment(), { username: 'plant', password: 'secret' })
    })
})

test.serial('unset mqtt credential variables are not passed as empty options', (t) => {
    withMqttEnvironment({}, () => {
        t.deepEqual(mqttAuthFromEnvironment(), {})
    })
})
