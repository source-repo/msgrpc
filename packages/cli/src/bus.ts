import { EventEmitter } from 'events'
import { rpc, rpcNamespace, RpcMessageType, type Message, type RelayedFrame, type RpcCallInstanceMethodPayload, type RpcErrorPayload, type RpcEventPayload, type RpcSuccessPayload } from '@source-repo/msgrpc'

/**
 * The traffic tap: what the broker is relaying, turned on while it runs.
 *
 * A console can only ever see its own calls and the events it subscribed to, which on a real
 * network is a small fraction of what is happening. The broker sees everything by definition - it
 * is the thing forwarding it - so this is where the rest becomes visible.
 *
 * **It is turned on by a call, not by a flag.** A plant bus that has to be restarted to be observed
 * will not be observed: the run you want to look at is the one already going wrong. The cost of
 * that decision is that the broker now exposes something, where it used to expose nothing at all
 * and answer ClassNotFound to anyone who addressed it - see the note in broker.ts.
 *
 * What this offers over pointing a generic MQTT monitor at the same wire is that it knows what a
 * frame *is*. A call and its reply share a correlation id, so they can be paired and the reply
 * reported with the time it took and the method it answers - neither of which is in the reply
 * itself. A topic browser shows you a MsgPack blob; this shows you
 * `plantServer.plant.writeSetpoint(1200) -> ok 42ms`.
 */

/** What a tap asks to be shown. Everything is optional; a tap with no filter sees all of it. */
export interface TapFilter {
    /** Only frames this peer sent or received - "mirror that device", which is the usual request. */
    peer?: string
    /** Only this namespace. Applies to replies too, since a reply is paired with its call first. */
    namespace?: string
    /** Only these kinds: POST, SUCCESS, ERROR, EVENT. */
    kinds?: string[]
    /**
     * Include arguments, results and event payloads.
     *
     * Off by default, and deliberately: the metadata is what a debugging session usually needs, and
     * a plant bus carries values that nobody meant to hand to whoever happened to be tapping.
     */
    payloads?: boolean
    /**
     * Seconds before this tap drops itself. A console that closes without untapping would otherwise
     * leave the broker building and emitting frames for a subscriber that is not there any more.
     */
    ttl?: number
}

/** One frame the broker passed between two peers. */
export interface TappedFrame {
    at: number
    source: string
    target: string
    /** POST, SUCCESS, ERROR or EVENT. */
    kind: string
    /** The namespace, taken from the call when this is a reply - a reply does not carry one. */
    namespace?: string
    method?: string
    event?: string
    /** Correlation id, so a call and its reply can be lined up by whoever is reading. */
    id?: string
    /** Milliseconds since the call this answers, when that call was seen. */
    ms?: number
    /** The error code on a refused call. */
    code?: string
    error?: string
    /** Only when a matching tap asked for payloads. */
    params?: unknown[]
    result?: unknown
    /** Which taps this frame matched, so several people can watch with different filters at once. */
    taps: string[]
}

export interface TapRecord {
    token: string
    filter: TapFilter
    /** Epoch milliseconds. */
    expires: number
    frames: number
}

/** Exported so the console can give its own record of a tap the same life as the tap itself. */
export const DEFAULT_TAP_TTL = 300
const DEFAULT_TTL = DEFAULT_TAP_TTL
const MAX_TTL = 3600
/**
 * How many calls are remembered while waiting for their replies. A call whose reply never comes
 * would otherwise be held forever, and this runs on a bus with no upper bound on traffic.
 */
const MAX_PENDING = 5000

/** The kinds, as the wire writes them, so a filter can name them without importing the enum. */
const KINDS = new Set<string>([RpcMessageType.CallInstanceMethod, RpcMessageType.success, RpcMessageType.error, RpcMessageType.event])

@rpcNamespace('bus', { version: '1' })
export class BusService extends EventEmitter {
    declare rpcEvents: { frame: [frame: TappedFrame] }

    private readonly active = new Map<string, TapRecord>()
    /** Calls seen and not yet answered, so a reply can be given the time it took and the method. */
    private readonly pending = new Map<string, { at: number; namespace?: string; method?: string; source: string }>()
    private counter = 0

    constructor(
        /** Named in what `taps()` reports, so a reader knows which broker they are looking at. */
        private readonly busName: string
    ) {
        super()
    }

    /**
     * Opened when the first tap starts and closed after the last one ends, for a source that costs
     * something to hold open - an MQTT subscription to every peer's traffic, in particular. A broker
     * needs none of this: it is already forwarding the frames, and `observe` returns on its first
     * line when nothing is watching.
     */
    onDemand?: { start: () => Promise<void>; stop: () => Promise<void> }

    /**
     * Starts or stops the source to match whether anything is watching.
     *
     * Failures on the way down are swallowed and failures on the way up are not: a tap that could
     * not subscribe has to say so, or it reports an empty network and looks like a quiet one.
     */
    private async settleSource(wasActive: boolean) {
        const active = this.active.size > 0
        if (active === wasActive || !this.onDemand) return
        if (active) await this.onDemand.start()
        else await this.onDemand.stop().catch(() => undefined)
    }

    /**
     * Start watching. Returns a token: several people can tap at once with different filters, and
     * untapping has to remove yours rather than everyone's.
     */
    @rpc
    async tap(filter?: TapFilter): Promise<{ token: string; expires: number; filter: TapFilter }> {
        const requested = filter ?? {}
        for (const kind of requested.kinds ?? []) if (!KINDS.has(kind)) throw Object.assign(new Error(`unknown kind '${kind}'`), { code: 'InvalidParams' })
        // Bounded rather than taken as given: a ttl of a year is a leak with a number on it.
        const ttl = Math.min(Math.max(requested.ttl ?? DEFAULT_TTL, 1), MAX_TTL)
        const token = `tap-${++this.counter}`
        const wasActive = this.active.size > 0
        this.active.set(token, { token, filter: { ...requested, ttl }, expires: Date.now() + ttl * 1000, frames: 0 })
        try {
            await this.settleSource(wasActive)
        } catch (e) {
            // Rolled back rather than left as a tap watching nothing, which would report a quiet
            // network instead of a source that could not be opened.
            this.active.delete(token)
            throw e
        }
        return { token, expires: Date.now() + ttl * 1000, filter: { ...requested, ttl } }
    }

    @rpc
    async untap(token: string): Promise<{ tapping: boolean; already: boolean }> {
        const wasActive = this.active.size > 0
        const had = this.active.delete(token)
        if (!this.active.size) this.pending.clear()
        await this.settleSource(wasActive)
        return { tapping: false, already: !had }
    }

    /** Who is watching what, including how much each tap has seen. */
    @rpc
    async taps(): Promise<{ bus: string; taps: TapRecord[]; pending: number }> {
        this.expire()
        return { bus: this.busName, taps: [...this.active.values()], pending: this.pending.size }
    }

    /** Whether anything is listening, so the broker can leave the transport hook unattached. */
    get tapping() {
        this.expire()
        return this.active.size > 0
    }

    private expire() {
        const now = Date.now()
        const wasActive = this.active.size > 0
        for (const [token, record] of this.active) if (record.expires <= now) this.active.delete(token)
        if (!this.active.size) this.pending.clear()
        // Not awaited: expiry is noticed from the frame path and from taps(), neither of which can
        // wait on a broker connection closing. Failures on the way down are swallowed anyway.
        if (wasActive && !this.active.size) void this.settleSource(wasActive)
    }

    /**
     * One relayed frame, from the transport that forwarded it.
     *
     * Everything here is best-effort reading of someone else's message: a frame whose payload is
     * not the shape we expect is reported with what could be read rather than dropped, since a
     * malformed frame on the bus is exactly the sort of thing a tap exists to show.
     */
    observe(relayed: RelayedFrame) {
        this.expire()
        if (!this.active.size) return
        const frame = this.readFrame(relayed)
        if (!frame) return

        const matched = [...this.active.values()].filter((record) => this.matches(record.filter, frame))
        if (!matched.length) return
        // Payloads are carried only if at least one of the taps that matched asked for them.
        if (!matched.some((record) => record.filter.payloads)) {
            delete frame.params
            delete frame.result
        }
        frame.taps = matched.map((record) => record.token)
        for (const record of matched) record.frames++
        this.emit('frame', frame)
    }

    private matches(filter: TapFilter, frame: TappedFrame) {
        if (filter.peer && frame.source !== filter.peer && frame.target !== filter.peer) return false
        if (filter.namespace && frame.namespace !== filter.namespace) return false
        if (filter.kinds?.length && !filter.kinds.includes(frame.kind)) return false
        return true
    }

    private readFrame({ source, target, message }: RelayedFrame): TappedFrame | undefined {
        const payload = (message as Message<{ type?: string }>).payload
        if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return undefined
        const at = Date.now()
        const frame: TappedFrame = { at, source, target, kind: payload.type, taps: [] }

        switch (payload.type) {
            case RpcMessageType.CallInstanceMethod: {
                const call = payload as RpcCallInstanceMethodPayload
                frame.namespace = call.path
                frame.method = call.method
                frame.id = call.id
                frame.params = call.params
                // Remembered so the reply can be given a duration and the method it answers.
                if (this.pending.size >= MAX_PENDING) {
                    const oldest = this.pending.keys().next()
                    if (!oldest.done) this.pending.delete(oldest.value)
                }
                if (call.id) this.pending.set(call.id, { at, namespace: call.path, method: call.method, source })
                break
            }
            case RpcMessageType.success: {
                const success = payload as RpcSuccessPayload
                frame.id = success.id
                frame.result = success.result
                this.pair(frame)
                break
            }
            case RpcMessageType.error: {
                const failure = payload as RpcErrorPayload
                frame.id = failure.id
                frame.code = failure.code
                frame.error = failure.error?.message
                this.pair(frame)
                break
            }
            case RpcMessageType.event: {
                const event = payload as RpcEventPayload
                frame.event = event.event
                frame.namespace = event.path
                frame.params = event.params
                break
            }
            default:
                // An unrecognised kind is still traffic, and still worth showing.
                break
        }
        return frame
    }

    /** Fills in what a reply does not carry: the method it answers, and how long it took. */
    private pair(frame: TappedFrame) {
        if (!frame.id) return
        const call = this.pending.get(frame.id)
        if (!call) return
        this.pending.delete(frame.id)
        frame.ms = frame.at - call.at
        frame.namespace = call.namespace
        frame.method = call.method
    }

    /** Drops every tap, so a broker shutting down stops building frames for nobody. */
    async releaseAll() {
        const wasActive = this.active.size > 0
        this.active.clear()
        this.pending.clear()
        await this.settleSource(wasActive)
    }
}
