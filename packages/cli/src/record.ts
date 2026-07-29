import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { RpcMessageType } from '@source-repo/rpc'
import { awaitPeer, connectNetwork, type NetworkOptions } from './network.js'
import { openTap } from './tapping.js'
import type { TapFilter, TappedFrame } from './bus.js'

/**
 * Writing a session down, and playing it back at something else.
 *
 * The tap already produces correlated, self-describing frames, so a recording is that stream in a
 * file. What it is for is the question a plant asks constantly and no test framework answers: this
 * new device is supposed to behave like the old one - does it? Capture an hour of the working
 * plant, replay it at the replacement, and compare the answers.
 *
 * jsonl rather than anything cleverer, so `grep`, `jq` and `wc -l` work on it and a recording made
 * today can still be read when whatever wrote it is gone.
 */

/** The first line of a recording, so a file that is not one is refused rather than half-read. */
export interface RecordingHeader {
    msgrpc: 'recording'
    version: 1
    at: number
    filter: TapFilter
    /** Who was doing the watching, for whoever reads the file later and wonders what it can see. */
    sources: string[]
}

/**
 * MsgPack carries Date and Uint8Array as values; JSON carries neither, and a recording that turned
 * a timestamp into a string would replay something the device never received. Both are tagged on
 * the way out and restored on the way back, which is the same problem the console's argument fields
 * solve when they walk typed JSON before sending it.
 */
export const encodeValue = (value: unknown): unknown => {
    if (value instanceof Date) return { $date: value.toISOString() }
    if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('hex') }
    if (Array.isArray(value)) return value.map(encodeValue)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)]))
    return value
}

export const decodeValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decodeValue)
    if (value && typeof value === 'object') {
        const tagged = value as { $date?: unknown; $bytes?: unknown }
        if (typeof tagged.$date === 'string') return new Date(tagged.$date)
        if (typeof tagged.$bytes === 'string') return Uint8Array.from(Buffer.from(tagged.$bytes, 'hex'))
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeValue(entry)]))
    }
    return value
}

export interface RecordOptions extends NetworkOptions {
    out: string
    filter: TapFilter
}

export const startRecording = async (options: RecordOptions) => {
    const connected = await connectNetwork(options)
    let written = 0

    // Appended line by line rather than held and written at the end: a recording is most wanted
    // from the run that ended badly, and a process killed mid-session should leave what it saw.
    const write = (line: unknown) => appendFileSync(options.out, JSON.stringify(line) + '\n')

    // Held until the header is down. The header names the sources, which are only known once the
    // tap is open, and writing it afterwards would truncate the file over any frame that arrived
    // in between - the first moments of a recording being exactly the ones worth keeping.
    let pending: unknown[] | undefined = []
    const lineFor = (frame: TappedFrame) => ({
        ...frame,
        ...(frame.params ? { params: encodeValue(frame.params) } : {}),
        ...(frame.result !== undefined ? { result: encodeValue(frame.result) } : {})
    })

    const tap = await openTap(connected, options, options.filter, (frame) => {
        written++
        if (pending) pending.push(lineFor(frame))
        else write(lineFor(frame))
    })

    const header: RecordingHeader = { msgrpc: 'recording', version: 1, at: Date.now(), filter: options.filter, sources: tap.sources }
    writeFileSync(options.out, JSON.stringify(header) + '\n')
    const buffered = pending
    pending = undefined
    for (const line of buffered) write(line)

    return {
        sources: tap.sources,
        frames: () => written,
        close: async () => {
            await tap.close()
            await connected.close()
        }
    }
}

/** A recording, read back. */
export const readRecording = (path: string) => {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (!lines.length) throw new Error(`${path} is empty`)
    let header: RecordingHeader
    try {
        header = JSON.parse(lines[0]) as RecordingHeader
    } catch {
        throw new Error(`${path} does not start with a recording header`)
    }
    if (header?.msgrpc !== 'recording') throw new Error(`${path} is not a Source RPC recording`)
    if (header.version !== 1) throw new Error(`${path} is a version ${header.version} recording, and this only reads version 1`)
    const frames = lines.slice(1).map((line) => JSON.parse(line) as TappedFrame)
    return { header, frames }
}

export interface ReplayOptions extends NetworkOptions {
    file: string
    /** Send every call here instead of to whoever received it originally. */
    against?: string
    /** Higher is faster. 0 or less sends with no waiting at all. */
    speed: number
    /** How long to wait for each addressee to appear before giving up on it. */
    wait?: number
}

/** What one recorded call did the second time round. */
export interface ReplayedCall {
    namespace: string
    method: string
    params: unknown[]
    target: string
    /** matched, differed, failed, or sent - the last meaning there was nothing recorded to compare. */
    outcome: 'matched' | 'differed' | 'failed' | 'sent'
    expected?: unknown
    got?: unknown
    error?: string
    ms: number
}

/**
 * Deep equality for what came back against what was recorded.
 *
 * Dates and byte strings compare by value: a reply carrying `new Date(...)` is the same answer as
 * the recorded one when the instants match, and `===` would say otherwise for every single call.
 */
const same = (a: unknown, b: unknown): boolean => {
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    if (a instanceof Uint8Array || b instanceof Uint8Array)
        return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((byte, index) => byte === b[index])
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => same(entry, b[index]))
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const left = Object.keys(a as object)
        const right = Object.keys(b as object)
        if (left.length !== right.length) return false
        return left.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    }
    return a === b
}

export const replaySession = async (options: ReplayOptions, onCall?: (call: ReplayedCall) => void) => {
    const { frames } = readRecording(options.file)
    const connected = await connectNetwork(options)

    // A reply carries no method of its own, so the recorded answer for a call is found by its id -
    // the same pairing the tap does when it reports one.
    const replies = new Map<string, TappedFrame>()
    for (const frame of frames) if (frame.id && (frame.kind === RpcMessageType.success || frame.kind === RpcMessageType.error)) replies.set(frame.id, frame)

    const calls = frames.filter((frame) => frame.kind === RpcMessageType.CallInstanceMethod)
    const results: ReplayedCall[] = []
    let previous: number | undefined

    // Every addressee has to be reachable before the first call goes out. ready() means the links
    // are up, not that presence has arrived, and a replay that started regardless spent its first
    // call waiting out a timeout against a peer that was moments from appearing.
    const targets = new Set(calls.map((call) => options.against ?? call.target))
    const missing = new Set<string>()
    await Promise.all([...targets].map(async (target) => void ((await awaitPeer(connected, target, options.wait ?? 5000)) || missing.add(target))))

    try {
        for (const call of calls) {
            // The original spacing, so a device that only misbehaves under the rate it actually
            // sees is given that rate rather than a burst.
            if (previous !== undefined && options.speed > 0) {
                const gap = (call.at - previous) / options.speed
                if (gap > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(gap, 60000)))
            }
            previous = call.at

            const target = options.against ?? call.target
            const namespace = call.namespace ?? ''
            const method = call.method ?? ''
            const params = (decodeValue(call.params ?? []) as unknown[]) ?? []

            const started = Date.now()
            const outcome: ReplayedCall = { namespace, method, params, target, outcome: 'sent', ms: 0 }
            if (missing.has(target)) {
                // Said once per call rather than waited out per call: twelve calls at a peer that is
                // not there is twelve timeouts and one fact.
                outcome.error = `${target} is not on this network`
                outcome.outcome = 'failed'
                results.push(outcome)
                onCall?.(outcome)
                continue
            }
            if (!call.params) {
                // Recorded without payloads, so there are no arguments to send. Reported rather
                // than sent empty, which would call the method with nothing and compare that.
                outcome.error = 'recorded without payloads, so it cannot be replayed'
                outcome.outcome = 'failed'
                results.push(outcome)
                onCall?.(outcome)
                continue
            }
            try {
                const proxy = await connected.network.proxy<{ [method: string]: (...a: unknown[]) => Promise<unknown> }>(namespace, target)
                const got = await proxy.remote![method](...params)
                outcome.ms = Date.now() - started
                const recorded = call.id ? replies.get(call.id) : undefined
                if (!recorded || (recorded.kind === RpcMessageType.success && recorded.result === undefined)) {
                    // Nothing to compare against is not a pass. Counted apart, so a run of these
                    // cannot be read as a device that matched.
                    outcome.outcome = 'sent'
                    outcome.got = got
                } else if (recorded.kind === RpcMessageType.error) {
                    outcome.outcome = 'differed'
                    outcome.expected = `${recorded.code}: ${recorded.error ?? ''}`.trim()
                    outcome.got = got
                } else {
                    const expected = decodeValue(recorded.result)
                    outcome.outcome = same(expected, got) ? 'matched' : 'differed'
                    outcome.expected = expected
                    outcome.got = got
                }
            } catch (e) {
                outcome.ms = Date.now() - started
                const failure = e as { code?: string; message?: string }
                const recorded = call.id ? replies.get(call.id) : undefined
                // A call that failed the same way it failed when recorded is a match: a device that
                // refuses what the old one refused is behaving.
                if (recorded?.kind === RpcMessageType.error && recorded.code === failure.code) {
                    outcome.outcome = 'matched'
                    outcome.expected = `${recorded.code}: ${recorded.error ?? ''}`.trim()
                    outcome.got = `${failure.code}: ${failure.message ?? ''}`.trim()
                } else {
                    outcome.outcome = 'failed'
                    outcome.error = `${failure.code ? failure.code + ': ' : ''}${failure.message ?? String(e)}`
                    if (recorded?.kind === RpcMessageType.success) outcome.expected = decodeValue(recorded.result)
                }
            }
            results.push(outcome)
            onCall?.(outcome)
        }
    } finally {
        await connected.close()
    }

    return {
        calls: results,
        matched: results.filter((call) => call.outcome === 'matched').length,
        differed: results.filter((call) => call.outcome === 'differed').length,
        failed: results.filter((call) => call.outcome === 'failed').length,
        sent: results.filter((call) => call.outcome === 'sent').length
    }
}
