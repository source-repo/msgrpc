/**
 * What a browser gets instead of the Node-only transports. Nothing here is reachable from a page
 * that dials out, which is the only thing a page can do - but a bundler has to resolve the import,
 * and resolving it to socket.io's server means pulling `http`, `fs` and `zlib` into the bundle.
 *
 * Constructing one says so rather than failing somewhere inside a shimmed builtin.
 */
const unavailable = (what: string): never => {
    throw new Error(`msgrpc: ${what} is not available in a browser. A page can only serve over a connection it opens: transports: [{ connect: url }].`)
}

export class SocketIoServerTransport {
    constructor() {
        unavailable('a socket.io listener')
    }
}

export class MqttTransport {
    constructor() {
        unavailable('the MQTT client')
    }
}
