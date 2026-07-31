import { MqttTransport, TransportEvent, type RelayedFrame, type ServerDescription } from '@source-repo/rpc'
import { BusService, type TapFilter, type TappedFrame } from './bus.js'
import type { ConnectedNetwork, NetworkOptions } from './network.js'

/**
 * Opening a tap from a process that is not the console: one filter, one stream of frames, closed
 * when the caller is done with it.
 *
 * The console has its own version of this because it hands out tokens to a page and shares one
 * subscription between them; this is the single-tap primitive that `record` and `replay` want, and
 * squeezing both shapes into one abstraction produced something that fitted neither. What they do
 * share is the rule: a socket.io network is watched at the broker, which is the only thing that
 * sees frames it is not party to, and an MQTT network is watched here, since there is no broker of
 * ours there to ask.
 */

/** The part of a peer's `bus` a tap calls. */
type BusPeer = {
    tap: (filter?: TapFilter) => Promise<{ token: string }>
    untap: (token: string) => Promise<unknown>
    on: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
    off: (event: string, handler: (...args: unknown[]) => void) => Promise<unknown>
}

/** How long to wait for presence before deciding nothing here can watch. */
const DEFAULT_SETTLE = 2000

export interface OpenTap {
    /** Who is doing the watching: peer names, or 'this process' for an MQTT tap held here. */
    sources: string[]
    close: () => Promise<void>
}

export const openTap = async (
    connected: ConnectedNetwork,
    options: NetworkOptions & { settle?: number },
    filter: TapFilter,
    onFrame: (frame: TappedFrame) => void
): Promise<OpenTap> => {
    const sources: string[] = []
    const closers: (() => Promise<void>)[] = []

    if (options.broker) {
        // A connection of its own, for the reason MqttTransport's `tap` option documents: a peer
        // subscribed to both its own topic and the wildcard covering it has overlapping
        // subscriptions, and a broker may deliver a matching message once per subscription.
        const bus = new BusService(options.name)
        bus.on('frame', (frame: TappedFrame) => onFrame(frame))
        const link = new MqttTransport(`${options.name}-tap`, options.broker, {
            ...(options.prefix ? { prefix: options.prefix } : {}),
            tap: true,
            presence: false
        })
        link.on(TransportEvent.relayed, (relayed: RelayedFrame) => bus.observe(relayed))
        await link.open()
        await link.ready()
        await bus.tap(filter)
        sources.push('this process')
        closers.push(async () => {
            await bus.releaseAll()
            await link.close()
        })
    }

    // ready() means the links are up, not that presence has arrived. Scanning immediately finds an
    // empty network on a bus that is plainly there, and the tap then watches nothing at all - which
    // reads as a quiet plant rather than as the race it is.
    const deadline = Date.now() + (options.settle ?? DEFAULT_SETTLE)
    while (!connected.online.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))

    // Every peer at once rather than one after another: a peer that is registered and no longer
    // answering costs a whole call timeout, and in sequence that is one per stale peer.
    const described = await Promise.all(
        [...connected.online].map(async (peer) => {
            const description = await connected.network
                .proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', peer)
                .then((proxy) => proxy.remote.describe())
                .catch(() => undefined)
            return { peer, hasBus: !!description?.namespaces.some((namespace) => namespace.name === 'bus') }
        })
    )

    for (const { peer, hasBus } of described) {
        if (!hasBus) continue
        try {
            const proxy = await connected.network.proxy<BusPeer>('bus', peer)
            const answer = await proxy.remote.tap(filter)
            const handler = (frame: unknown) => onFrame(frame as TappedFrame)
            await proxy.remote.on('frame', handler)
            sources.push(peer)
            closers.push(async () => {
                await proxy.remote.off('frame', handler).catch(() => undefined)
                await proxy.remote.untap(answer.token).catch(() => undefined)
            })
        } catch {
            // One bus that refuses does not stop the others, and a tap that opened nothing is
            // reported by its empty source list rather than by failing.
        }
    }

    return {
        sources,
        close: async () => {
            for (const closer of closers) await closer().catch(() => undefined)
        }
    }
}
