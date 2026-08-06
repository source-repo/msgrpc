import {
    MqttTransport,
    RpcServer,
    SocketIoClientTransport,
    TransportEvent,
    type MessageSigner,
    type MessageVerifier,
    type RpcAuthorizer,
    type Transport
} from '@source-repo/rpc'

/**
 * Joining a network the way every command here joins one: an MQTT broker, a socket.io hub, or both.
 *
 * The three commands that do this - console, mcp and the one-shot verbs - had the same twenty lines
 * of transport construction each, which is three places to forget `prefix` in. The console still
 * builds its own server, because it prepends the socket.io transport that serves the browser, so it
 * takes the transports and keeps the server; the others take both.
 */

export interface NetworkOptions {
    /** Watch an MQTT network. Either this or `hub`, or both. */
    broker?: string
    /** Watch a socket.io network by connecting to a hub. */
    hub?: string
    /** MQTT topic namespace. A hub has none, so this does nothing for `hub` alone. */
    prefix?: string
    name: string
    callTimeout: number
    /** Sign outgoing frames, so a server configured with `verify` accepts them. */
    sign?: MessageSigner
    /** Require and check signatures on incoming frames. Optional even when signing. */
    verify?: MessageVerifier
    /** Handshake credentials for a hub that authenticates. No flag: a secret does not belong in `ps`. */
    hubCredentials?: unknown
    /**
     * Decides what callers may reach on this peer. Only meaningful for a window that has been given
     * something to offer - see `--scriptable-by`, which is the one thing that turns this from a
     * peer that exposes nothing into a peer that exposes something worth guarding.
     */
    authorize?: RpcAuthorizer
    /** Publish `msgrpc.describe` for commands that expose a discoverable service. */
    exposeIntrospection?: boolean
    /**
     * Given the server to expose things on, before `ready()` is awaited.
     *
     * The ordering is not fussiness. A resumed MQTT session is handed its queued messages the
     * instant it connects, so anything exposed after ready() is exposed too late for the requests
     * that were waiting - and those callers get ClassNotFound from a peer that does serve the
     * namespace, a second after it started. The frame spec lists this under known limits.
     */
    expose?: (network: RpcServer) => void
    /**
     * Talk to an `https://`, `wss://` or `mqtts://` peer without checking its certificate.
     *
     * Deliberately unsafe, and off. It exists because a plant's development bus often has a
     * self-signed certificate and a debugging tool that cannot reach it is no use - but anything
     * able to answer on that address can then read and rewrite what this command sends.
     */
    insecureTls?: boolean
}

const hasEnvironmentValue = (name: string) => Object.prototype.hasOwnProperty.call(process.env, name)

export const mqttAuthFromEnvironment = () => ({
    ...(hasEnvironmentValue('SOURCE_RPC_MQTT_USERNAME') ? { username: process.env.SOURCE_RPC_MQTT_USERNAME } : {}),
    ...(hasEnvironmentValue('SOURCE_RPC_MQTT_PASSWORD') ? { password: process.env.SOURCE_RPC_MQTT_PASSWORD } : {})
})

/** The links a set of options asks for, in the order the commands have always built them. */
export const networkTransports = (options: NetworkOptions): Transport[] => [
    ...(options.broker
        ? [
              new MqttTransport(options.name, options.broker, {
                  mqtt: mqttAuthFromEnvironment(),
                  ...(options.prefix ? { prefix: options.prefix } : {}),
                  ...(options.sign ? { sign: options.sign } : {}),
                  ...(options.verify ? { verify: options.verify } : {}),
                  ...(options.insecureTls ? { allowInsecureTls: true } : {})
              })
          ]
        : []),
    ...(options.hub
        ? [
              new SocketIoClientTransport(
                  options.name,
                  options.hub,
                  [],
                  { ...(options.hubCredentials ? { auth: options.hubCredentials as { [key: string]: unknown } } : {}) },
                  true,
                  options.insecureTls
              )
          ]
        : [])
]

export interface ConnectedNetwork {
    network: RpcServer
    /** Every peer visible on any link, kept current as they arrive and leave. */
    online: Set<string>
    close: () => Promise<void>
}

/**
 * A window onto the network: an RpcServer that exposes nothing and exists to look and to call.
 *
 * The online set is seeded from the registry after ready() rather than only from the events, since
 * transports are built asynchronously and whoever announced themselves during startup has already
 * been and gone by the time a listener could be attached.
 */
export const connectNetwork = async (options: NetworkOptions): Promise<ConnectedNetwork> => {
    if (!options.broker && !options.hub) throw new Error('connectNetwork: give it a broker, a hub, or both')

    const online = new Set<string>()
    const network = new RpcServer({
        name: options.name,
        callTimeout: options.callTimeout,
        readyTimeout: 15000,
        transports: networkTransports(options),
        ...(options.exposeIntrospection ? { exposeIntrospection: true } : {}),
        ...(options.authorize ? { authorize: options.authorize } : {})
    })
    options.expose?.(network)
    await network.ready()
    for (const peer of network.peers.names()) if (peer !== options.name) online.add(peer)
    for (const transport of network.transports) {
        transport.on(TransportEvent.peerOnline, (peer: string) => void (peer !== options.name && online.add(peer)))
        transport.on(TransportEvent.peerGone, (peer: string) => void online.delete(peer))
    }

    return { network, online, close: () => network.close() }
}

/**
 * Waits for a peer to be addressable rather than failing on the first attempt.
 *
 * ready() means the links are up, not that presence has arrived - and over MQTT retained presence
 * lands a moment after the subscription does. A one-shot command that gave up on that gap would
 * fail intermittently for reasons nobody could reproduce.
 */
export const awaitPeer = async (connected: ConnectedNetwork, peer: string, timeout: number) => {
    const deadline = Date.now() + timeout
    for (;;) {
        if (connected.online.has(peer) || connected.network.peers.names().includes(peer)) return true
        if (Date.now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}
