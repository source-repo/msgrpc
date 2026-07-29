import type { ServerDescription } from '@source-repo/rpc'
import { awaitPeer, connectNetwork, type NetworkOptions } from './network.js'
import { coerceArguments } from './verbs.js'

/**
 * Calling one method over and over, and reporting what it cost.
 *
 * `call` already returns the time a single call took, and the console shows it once and forgets it.
 * The question a plant actually asks is the one a single call cannot answer: this device is fine at
 * one call a second - what does it do at twenty? Finding the rate at which a device falls over is
 * ordinarily done by writing a script, and the script is always the same script.
 *
 * Percentiles rather than an average, because an average hides exactly the calls worth knowing
 * about: a device answering in 2 ms with one reply a second taking 4 seconds averages out to
 * something that looks healthy.
 */

export interface BenchOptions extends NetworkOptions {
    peer: string
    namespace: string
    method: string
    /** Already coerced; `runBench` does that from the contract when given words. */
    args: unknown[]
    /** Calls per second to aim for. */
    rate: number
    /** How long to keep going. */
    forMs: number
    /** How many calls may be outstanding at once before the rest are counted as fallen behind. */
    concurrency: number
    wait?: number
}

export interface BenchReport {
    peer: string
    method: string
    calls: number
    ok: number
    failed: number
    /**
     * Calls not sent because too many were already outstanding. A device that cannot keep up shows
     * here rather than in the latencies, where it would look like the network was fine.
     */
    behind: number
    /** How the failures broke down, by RPC error code. */
    codes: { [code: string]: number }
    ms: { min: number; p50: number; p90: number; p95: number; p99: number; max: number; mean: number }
    rate: { asked: number; achieved: number }
    ranForMs: number
}

const percentile = (sorted: number[], fraction: number) => {
    if (!sorted.length) return 0
    // Nearest-rank: with 20 samples the 95th is the 19th, which is a sample that happened rather
    // than an interpolation between two that did.
    const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    return sorted[Math.max(0, rank)]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const bench = async (options: BenchOptions): Promise<BenchReport> => {
    const connected = await connectNetwork(options)
    try {
        if (!(await awaitPeer(connected, options.peer, options.wait ?? 5000)))
            throw Object.assign(new Error(`${options.peer} did not appear within ${options.wait ?? 5000} ms`), { code: 'ClassNotFound' })

        const proxy = await connected.network.proxy<{ [method: string]: (...a: unknown[]) => Promise<unknown> }>(options.namespace, options.peer)
        const remote = proxy.remote!
        const latencies: number[] = []
        const codes: { [code: string]: number } = {}
        let ok = 0
        let failed = 0
        let behind = 0
        let inFlight = 0
        const outstanding: Promise<void>[] = []

        const fire = () => {
            inFlight++
            const started = Date.now()
            const call = remote[options.method](...options.args)
                .then(() => {
                    ok++
                    latencies.push(Date.now() - started)
                })
                .catch((e: unknown) => {
                    failed++
                    // Counted by code rather than lumped together: a device refusing arguments and
                    // a device that stopped answering are different findings with the same shape.
                    const code = (e as { code?: string }).code ?? 'Exception'
                    codes[code] = (codes[code] ?? 0) + 1
                    latencies.push(Date.now() - started)
                })
                .finally(() => {
                    inFlight--
                })
            outstanding.push(call)
        }

        const interval = options.rate > 0 ? 1000 / options.rate : 0
        const began = Date.now()
        const deadline = began + options.forMs
        let next = began
        while (Date.now() < deadline) {
            const waiting = next - Date.now()
            if (waiting > 0) await sleep(Math.min(waiting, deadline - Date.now()))
            if (Date.now() >= deadline) break
            // Not sent rather than queued: piling calls onto a device that is already behind
            // measures the queue rather than the device.
            if (inFlight >= options.concurrency) behind++
            else fire()
            next = interval > 0 ? next + interval : Date.now()
        }
        // The last calls are waited out, so a run does not report latencies it never collected.
        await Promise.allSettled(outstanding)
        const ranForMs = Date.now() - began

        const sorted = [...latencies].sort((a, b) => a - b)
        return {
            peer: options.peer,
            method: `${options.namespace}.${options.method}`,
            calls: ok + failed,
            ok,
            failed,
            behind,
            codes,
            ms: {
                min: sorted[0] ?? 0,
                p50: percentile(sorted, 0.5),
                p90: percentile(sorted, 0.9),
                p95: percentile(sorted, 0.95),
                p99: percentile(sorted, 0.99),
                max: sorted[sorted.length - 1] ?? 0,
                mean: sorted.length ? Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length) : 0
            },
            rate: { asked: options.rate, achieved: ranForMs ? Math.round(((ok + failed) / ranForMs) * 1000 * 10) / 10 : 0 },
            ranForMs
        }
    } finally {
        await connected.close()
    }
}

/** Coerces the words a shell gives against the peer's own contract, the way `call` does. */
export const benchArguments = async (options: NetworkOptions & { peer: string; namespace: string; method: string; texts: string[] }) => {
    const connected = await connectNetwork(options)
    try {
        const description = await connected.network
            .proxy<{ describe(): Promise<ServerDescription> }>('msgrpc', options.peer)
            .then((proxy) => proxy.remote!.describe())
            .catch(() => undefined)
        const method = description?.namespaces.find((namespace) => namespace.name === options.namespace)?.methods.find((entry) => entry.name === options.method)
        return coerceArguments(options.texts, method, description?.types)
    } finally {
        await connected.close()
    }
}
