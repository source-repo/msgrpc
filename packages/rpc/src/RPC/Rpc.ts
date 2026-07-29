import type { ExposeOptions } from './RpcServerHandler.js'

/**
 * The Source RPC port. An unconfigured server listens here, an unconfigured client dials here, and
 * `source-rpc broker` runs a bus here.
 *
 * Having one number rather than three is the whole of the argument: a well-known port is what lets
 * `mqtt://broker:1883` and `http://bus:7843` both be written from memory, and what makes a port map
 * in a compose file readable without a comment on each line.
 *
 * 7843 rather than anything in the 80xx range, which is where a developer's other work already
 * lives - 8080, 8081, 8085 are taken on any machine that has been used for a while, and a default
 * that collides on the laptop is a default nobody keeps. This is quiet ground: high enough to need
 * no privilege, low enough to stay clear of the ephemeral range, and not the neighbour of anything
 * that would be mistaken for it.
 */
export const defaultWebSocketPort = 7843

/**
 * Where anything that serves a browser puts its HTTP port. `source-rpc console` defaults here.
 *
 * Adjacent to the RPC port rather than derived by an offset: they are read together, and 7843/7844
 * is one thing to remember. A single process needs only one of them - the console serves its page
 * and its RPC on the same listener - so the second number is for running a bus and a console on one
 * host, which is the ordinary case.
 */
export const defaultWebPort = defaultWebSocketPort + 1

/**
 * The same two services with TLS: `rpc-tls` and `console-tls`.
 *
 * A thousand above their plaintext counterparts, deliberately **not** adjacent to them. The last
 * two digits still match, so 7843/8843 is one number to remember with a rule attached - but no
 * range covers both, and `allow 7843:7846` is the rule somebody writes at the end of a long day. A
 * firewall that meant to publish only the encrypted port should not be able to open the other one
 * by fencepost. MQTT draws the same line for the same reason, 1883 against 8883, so the habit
 * transfers.
 *
 * These say where to *find* a service, not what any process must do. A port carries TLS because it
 * was given a certificate, never because of its number - see `--cert`/`--key` in the CLI, which
 * moves to these ports when it is given the material and stays put when it is not.
 */
export const defaultSecureWebSocketPort = defaultWebSocketPort + 1000
export const defaultSecureWebPort = defaultWebPort + 1000

export interface IManageRpc {
    exposeClassInstance(instance: object, name?: string, options?: number | ExposeOptions): void
    exposeClass<T>(constructor: new (...args: unknown[]) => T, aliasName?: string): void
    exposeObject(obj: object, name: string): void
    expose(methodName: string, method: () => void): void
    createRpcInstance(className: string, instanceName?: string, ...args: unknown[]): Promise<string | undefined>
}

export const isEventFunction = (prop: string) =>
    prop === 'on' ||
    prop === 'addListener' ||
    prop === 'prependListener' ||
    prop === 'once' ||
    prop === 'prependOnceListener' ||
    prop === 'off' ||
    prop === 'removeListener' ||
    prop === 'emit' ||
    prop === 'removeListener' ||
    prop === 'removeAllListeners' ||
    prop === 'setMaxListeners' ||
    prop === 'getMaxListeners'

export const isPromiseFunction = (prop: string) => prop === 'then' || prop === 'catch'
