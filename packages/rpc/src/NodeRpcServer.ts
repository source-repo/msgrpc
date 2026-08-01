import type { Server } from 'http'
import type { ServerOptions as TlsServerOptions } from 'https'
import { Transport } from './RPC/Core.js'
import { MqttTransport, MqttTransportOptions } from './Transports/MqttTransport.js'
import { SocketIoServerTransport } from './Transports/SocketIoServerTransport.js'
import { ConnectServerOptions, RpcServerBase, RpcServerOptions, ServerOptions } from './RpcServer.js'
import { defaultWebSocketPort } from './RPC/Rpc.js'

/**
 * The server for a process that can listen.
 *
 * This is what `RpcServer` means everywhere except a browser, where the package's `browser` export
 * condition resolves to RpcServerBase instead. The split is not cosmetic: a page cannot open a
 * listening socket or speak MQTT, and putting those shapes here means `{ port: 8080 }` in browser
 * code is a compile error rather than a class that throws when constructed. It also keeps
 * socket.io's server and the MQTT client out of a browser bundle, because nothing a browser
 * resolves imports this file at all.
 */

/** A socket.io server this class opens and owns. */
export interface HttpServerOptions extends ServerOptions {
    port: number
    /**
     * The interface to bind, e.g. '127.0.0.1'. Absent binds every interface, which is the right
     * default for a service - a plant peer that only its own machine could reach would be a
     * mystery - and the wrong one for a tool, which is why the CLI's listening commands pass
     * loopback here unless told to widen.
     */
    host?: string
    /**
     * TLS material for this server. Present means HTTPS; absent means plain HTTP.
     *
     * ```ts
     * { port: 8443, tls: { cert: readFileSync('plant.crt'), key: readFileSync('plant.key') } }
     * ```
     */
    tls?: TlsServerOptions
    path?: string
    /**
     * @deprecated Refused. `https: true` opened an HTTPS server with no certificate and no key, so
     * it listened and then failed every handshake. Pass `tls` with the certificate instead, or hand
     * over a `server` you have configured yourself.
     */
    https?: never
}

/** Attach to an http.Server you already have, so a page and its RPC arrive on one port. */
export interface ExternalServerOptions extends ServerOptions {
    server: Server
    path?: string
}

/** Serve over a broker. */
export interface MqttServerOptions extends ServerOptions, MqttTransportOptions {
    brokerurl: string
}

export interface NodeRpcServerOptions extends Omit<RpcServerOptions, 'transports'> {
    transports: (HttpServerOptions | ExternalServerOptions | ConnectServerOptions | MqttServerOptions | Transport)[]
}

export class NodeRpcServer extends RpcServerBase {
    constructor(options: Partial<NodeRpcServerOptions> = {}) {
        // The base stores the narrower union; this class only ever adds shapes to it, and
        // buildTransport below is what actually reads them.
        super(options as Partial<RpcServerOptions>)
    }

    /** A socket.io server on the default port, which is what an unconfigured server has always been. */
    protected override configuredTransports() {
        return this.options.transports.length ? this.options.transports : [{ port: defaultWebSocketPort }]
    }

    protected override async buildTransport(serveroption: unknown): Promise<Transport | undefined> {
        const portable = await super.buildTransport(serveroption)
        if (portable) return portable

        if ((serveroption as HttpServerOptions).port) {
            const httpOptions = serveroption as HttpServerOptions
            // The type says `never`, which stops it at compile time; this stops it for a caller
            // configuring the server from JSON, who would otherwise get a listening socket that
            // fails every handshake.
            if ((serveroption as { https?: unknown }).https)
                throw new Error(
                    `RpcServer '${this.options.name}': { https: true } is refused because it opened a server with no certificate. Pass tls: { cert, key } instead.`
                )
            return new SocketIoServerTransport(
                this.options.name,
                undefined,
                httpOptions.port,
                httpOptions.tls,
                [],
                { path: httpOptions.path },
                this.options.authenticate,
                httpOptions.host
            )
        }
        if ((serveroption as ExternalServerOptions).server) {
            const externalOptions = serveroption as ExternalServerOptions
            return new SocketIoServerTransport(this.options.name, externalOptions.server, 0, undefined, [], { path: externalOptions.path }, this.options.authenticate)
        }
        if ((serveroption as MqttServerOptions).brokerurl) {
            const mqttServerOptions = serveroption as MqttServerOptions
            return new MqttTransport(this.options.name, mqttServerOptions.brokerurl, {
                // A server should not lose requests published while it was restarting, so it keeps
                // its broker session by default. Clients do not: a late reply is useless to a call
                // that has already timed out, and every short-lived peer would leave session state
                // behind on the broker.
                persistentSession: true,
                ...mqttServerOptions
            })
        }
        return undefined
    }
}
