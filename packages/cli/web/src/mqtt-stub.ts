/**
 * The console's browser client always connects back to the CLI over the origin that served the
 * page, so it never takes RpcClient's `mqtt://` branch. That branch is still a dynamic import in
 * the library, and a bundler emits the chunk whether or not anything reaches it - 380 kB of MQTT
 * client shipped in a tarball to sit unused, plus a rollup warning about the node build's exports.
 *
 * Aliasing `mqtt` here drops it. If the console is ever meant to speak MQTT from the browser, the
 * alias in vite.config.ts is what to remove; until then this says so rather than failing obscurely.
 */
export const connect = () => {
    throw new Error('the msgrpc console does not speak MQTT from the browser: it calls the CLI, which holds the broker connection')
}

export default { connect }
