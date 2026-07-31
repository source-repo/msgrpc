import { MessageModule, Message, MessageType, GenericModule } from './Core.js'
import {
    RpcCallInstanceMethodPayload,
    RpcErrorCode,
    RpcErrorPayload,
    RpcEventPayload,
    RpcMessage,
    RpcMessageType,
    RpcMethodSemantics,
    RpcSuccessPayload,
    toRemoteError
} from './Messages.js'
export * from './Messages.js'
import { v4 as uuidv4 } from 'uuid'
import { IManageRpc } from './Rpc.js'
import { RpcAuthorizer, RpcCallContext, RpcIdentity } from './Auth.js'
import { isFailedOutcome, type RpcIdempotencyStore, type RpcInvocation, type StoredRpcOutcome } from './Idempotency.js'
import EventEmitter from 'events'
import { ILogger, LogLevel } from '../Logging/ILogger.js'
import { declaredAuthority, declaredConflation, declaredNamespace, declaredSemantics, markedMethods, type RpcExecution } from './Expose.js'
import {
    acquireComponentAuthority,
    componentAuthority,
    componentSnapshot,
    componentSnapshotEvent,
    DEFAULT_AUTHORITY_TTL,
    installComponentPublisher,
    installComponentValidator,
    releaseComponentAuthority,
    RpcComponent,
    type RpcComponentExposeOptions
} from './Component.js'
import { RpcSchema, validateParams, validateValue, type ComponentSchema } from './Schema.js'
import { describeProblems, namespaceProblems } from './Compatibility.js'

export class EventProxy {
    /**
     * Held so the listener can be removed again. Binding at registration time produced a fresh
     * function that removeListener() could never match.
     */
    private readonly listener = (...args: unknown[]) => {
        // Caught here, because an emit is not a call: nothing above this is awaiting the delivery,
        // so a transport that cannot publish - a broker that has gone away, most obviously - would
        // otherwise reject a promise nobody holds, and Node ends the process on one of those.
        void this.rpcServer.sendEvent(this.target, this.event, args, this.instanceName).catch((e) =>
            this.rpcServer.emit('deliveryError', { target: this.target, event: this.event, path: this.instanceName, error: e })
        )
    }
    constructor(
        public rpcServer: RpcServerHandler,
        public instance: EventEmitter,
        public event: string,
        public target: string,
        public instanceName: string
    ) {}
    attach() {
        this.instance.on(this.event, this.listener)
    }
    detach() {
        this.instance.removeListener(this.event, this.listener)
    }
}

/**
 * Identifies one subscription. Previously a Map keyed by a freshly allocated object literal, so
 * lookups compared by reference and never matched - every repeated on() stacked another listener.
 */
const eventProxyKey = (instanceName: string, event: string, source: string) => `${instanceName}\u0000${event}\u0000${source}`

export type BindObject = {
    [index: string]: (...args: unknown[]) => unknown
}

export type ObjectByString = { [index: string]: unknown }

/** How one instance is exposed, beyond the name it answers to. */
export interface ExposeOptions {
    /**
     * How far up the prototype chain to publish methods from. The old third argument, which was
     * this number on its own; a number is still accepted so existing calls keep working.
     */
    prototypeSteps?: number
    /**
     * Whether calls into this instance may overlap. Overrides what the class declares, since the
     * call site knows how this particular instance is used.
     */
    execution?: RpcExecution
    /**
     * How many calls may wait in one of this instance's queues before arrivals are refused Busy.
     * Overrides what the class declares, for the same reason execution does.
     */
    mailbox?: number
    /** Snapshot publishing for an instance extending RpcComponent. Ignored for anything else. */
    component?: RpcComponentExposeOptions
}

const isRpcCallInstanceMethodPayload = (payload: RpcMessage): payload is RpcCallInstanceMethodPayload => {
    return payload.type === RpcMessageType.CallInstanceMethod
}

/**
 * How many calls may wait in one queue before new arrivals are refused Busy, unless the instance
 * declares its own bound. A hundred waiting commands on one industrial instance is a malfunction
 * upstream, not a load to absorb - and the callers of most of them have already stopped waiting,
 * so admitting more only grows a backlog the deadline check will refuse one by one.
 */
const DEFAULT_MAILBOX = 100

/**
 * The codes a method may answer with by throwing an error that carries one.
 *
 * Everything a method threw used to come back as `Exception`, so a service that wanted to say
 * "you may not do that" could say it only in the message - and a caller reading `code` to decide
 * whether to retry, re-authenticate or give up learned nothing. Restricted to the codes the
 * protocol already defines, so an error carrying an unrelated `code` - a Node `ENOENT`, say - is
 * still reported as the exception it is.
 */
const CHOSEN_CODES = new Set<string>([
    'Unauthorized',
    'Forbidden',
    'InvalidParams',
    'IncompatibleVersion',
    'ClassNotFound',
    'MethodNotFound',
    'TransportError',
    'Timeout',
    // A method that talked to something else and did not learn the answer may say so. It is the
    // honest reply from a gateway whose own downstream call timed out, and inventing a result or
    // reporting a plain exception would both claim more than is known.
    'UnknownOutcome'
])

const chosenCode = (e: unknown): RpcErrorCode => {
    const code = (e as { code?: unknown } | null)?.code
    return typeof code === 'string' && CHOSEN_CODES.has(code) ? (code as RpcErrorCode) : 'Exception'
}

export class RpcServerHandler extends MessageModule<Message<RpcMessage>, RpcMessage, Message<RpcMessage>, RpcMessage> {
    manageRpc = new ManageRpc()
    eventProxies = new Map<string, EventProxy>()

    /** Decides whether a call may proceed. When unset, every call that resolves is allowed. */
    authorize?: RpcAuthorizer
    /** Supplied by RpcServer; asks the transports which identity a peer name is bound to. */
    resolveIdentity?: (source: string) => RpcIdentity | undefined
    /** Reject calls from peers no transport can vouch for. */
    requireIdentity = false
    /**
     * Suppress duplicate requests. MQTT at QoS 1 is at-least-once, so the same request can be
     * delivered twice; without this a retransmission would run the method a second time, which is
     * not something a caller can undo. A duplicate is answered from the cache instead.
     */
    deduplicateRequests = true
    /** How many recent request ids to remember. Oldest are evicted first. */
    maxTrackedRequests = 1000
    /**
     * Refuse a call whose caller has already stopped waiting for it, instead of running it late.
     *
     * A request carries the milliseconds its caller intended to wait, and that budget is counted
     * from the moment this process received the frame. A read arriving late only wastes work; a
     * command does not - the operator saw a timeout, did something else about it, and then the
     * original 'start pump' runs anyway. On by default, because that outcome is worse than the
     * failed call it replaces.
     */
    refuseExpiredCalls = true
    /**
     * Where to record what a non-repeatable command did, so a redelivery after a crash is answered
     * rather than executed a second time. Unset means execution is at least once - see
     * RPC/Idempotency.ts, which spells out exactly what that leaves open.
     */
    idempotency?: RpcIdempotencyStore
    /** Describes what exposed methods accept. Absent means nothing is checked. */
    schema?: RpcSchema
    /**
     * 'described' checks calls into namespaces the schema covers and lets the rest through, so a
     * partial schema is useful. 'required' refuses anything the schema does not describe.
     */
    validation: 'off' | 'described' | 'required' = 'described'
    /** Set by RpcServer: this host's topology records, for describe() to read. */
    hostTopology?: import('./Topology.js').HostTopology
    /** Check what handlers return as well as what callers send. Off by default: it is a self-check. */
    validateResults = false
    /**
     * What to do with a caller declaring a contract version this schema has no history for.
     * 'allow' by default, because truncating history is a legitimate operational choice and should
     * not strand peers.
     */
    unknownVersion: 'allow' | 'reject' = 'allow'
    /** Verdicts by namespace and declared version, so the comparison runs once per peer, not per call. */
    private compatibility = new Map<string, string | undefined>()
    private recentResponses = new Map<string, RpcMessage>()
    private inFlightRequests = new Set<string>()

    constructor(name: string, sources?: GenericModule<unknown, unknown, Message, RpcMessage>[]) {
        super(name, sources)
        this.manageRpc.logger?.log('Information', 'RpcServerHandler {name} starting', { name })
    }

    /**
     * Gate a call before it reaches an exposed method. Returns an error code to reject with, or
     * undefined to allow. Subscriptions go through here too: without that, anyone could attach to
     * an instance's events and receive everything it emits.
     */
    private async checkAccess(payload: RpcCallInstanceMethodPayload, source: string, subscription: boolean): Promise<RpcErrorCode | undefined> {
        const identity = this.resolveIdentity?.(source)
        if (this.requireIdentity && !identity) return 'Unauthorized'
        if (!this.authorize) return undefined
        const context: RpcCallContext = {
            identity,
            source,
            instanceName: payload.path,
            method: payload.method,
            params: payload.params,
            subscription
        }
        try {
            return (await this.authorize(context)) ? undefined : 'Forbidden'
        } catch {
            // An authorizer that throws denies. Failing open here would turn a bug in the
            // authorizer into an access-control bypass.
            return 'Forbidden'
        }
    }

    /**
     * Returns a reason to refuse the call, or undefined. The namespace's contract version rides
     * along in the message, because a caller built against an older contract otherwise looks
     * indistinguishable from one sending plain rubbish.
     */
    private checkParams(payload: RpcCallInstanceMethodPayload): string | undefined {
        if (!this.schema || this.validation === 'off') return undefined
        const namespace = this.schema.namespaces[payload.path]
        if (!namespace) return this.validation === 'required' ? `${payload.path} is not described by the schema` : undefined
        if (namespace.validate === false) return undefined
        const method = namespace.methods[payload.method]
        if (!method) return this.validation === 'required' ? `${payload.path}.${payload.method} is not described by the schema` : undefined
        const failure = validateParams(payload.params, method, this.schema.types)
        if (!failure) return undefined
        return namespace.version ? `${failure} (this server serves ${payload.path}@${namespace.version})` : failure
    }

    /**
     * Compares the contract a caller declares with the one served here. Only a genuine structural
     * incompatibility is refused: a caller whose contract still holds keeps working, which is why
     * this compares schemas rather than gating on a version or a hash being equal.
     */
    private checkVersion(payload: RpcCallInstanceMethodPayload): string | undefined {
        if (!this.schema || this.validation === 'off' || !payload.version) return undefined
        const namespace = this.schema.namespaces[payload.path]
        if (!namespace || payload.version === namespace.version) return undefined

        const key = `${payload.path}@${payload.version}`
        if (this.compatibility.has(key)) return this.compatibility.get(key)

        const previous = namespace.history?.[payload.version]
        let verdict: string | undefined
        if (!previous) {
            verdict =
                this.unknownVersion === 'reject'
                    ? `${payload.path}@${payload.version} is unknown to this server, which serves ${payload.path}@${namespace.version ?? 'an unversioned contract'}`
                    : undefined
        } else {
            verdict = describeProblems(payload.path, payload.version, namespace.version, namespaceProblems(previous, namespace, this.schema.types))
        }
        this.compatibility.set(key, verdict)
        return verdict
    }

    override async receive(message: Message<RpcMessage>, source: string, target: string) {
        this.manageRpc.logger?.log('Debug', 'RpcServerHandler {name} received message type {type} from {source} to {target}: {message}', {
            name: this.name,
            type: message.type,
            source,
            target,
            message: JSON.stringify(message)
        })
        // Deliberately not awaited: awaiting would serialise every request arriving on one
        // connection behind the slowest handler. The catch is what stops an unawaited promise
        // becoming an unhandled rejection - receivePayload answers the caller itself, so reaching
        // here at all means even that failed.
        if (message.payload)
            void this.receivePayload(message.payload, source, target).catch((e) => this.emit('handlerError', { source, target, error: e }))
    }
    /**
     * Send a response and remember it against its request id, so a redelivered request can be
     * answered without running the method again.
     */
    private respond(requestId: string, source: string, response: RpcMessage, messageType: MessageType) {
        if (this.deduplicateRequests) {
            this.inFlightRequests.delete(requestId)
            this.recentResponses.set(requestId, response)
            while (this.recentResponses.size > this.maxTrackedRequests) {
                const oldest = this.recentResponses.keys().next()
                if (oldest.done) break
                this.recentResponses.delete(oldest.value)
            }
        }
        return this.sendPayload(response, messageType, this.name, source)
    }

    override async receivePayload(payload: RpcMessage, source: string, target: string) {
        try {
            await this.dispatch(payload, source, target)
        } catch (e) {
            // Anything that escaped dispatch - a transport that could not publish the reply, a
            // schema check that threw, a bug here - used to be an unhandled rejection, and the
            // caller learned nothing until its own timeout expired. Tell it what happened instead.
            await this.reportDispatchFailure(payload, source, e)
        }
    }

    /**
     * Last resort when dispatch itself failed. Answers the caller if the request can still be
     * identified, and never throws: the thing that failed may well be the transport this reply
     * would go out on, and a failure to report a failure has nowhere left to go.
     */
    private async reportDispatchFailure(payload: RpcMessage, source: string, error: unknown) {
        this.emit('handlerError', { source, payload, error })
        const id = (payload as RpcCallInstanceMethodPayload).id
        if (!isRpcCallInstanceMethodPayload(payload) || !id) return
        if (this.deduplicateRequests) this.inFlightRequests.delete(id)
        try {
            await this.sendPayload(
                { type: RpcMessageType.error, id, code: 'Exception', error: toRemoteError(error) } as RpcErrorPayload,
                MessageType.ErrorMessage,
                this.name,
                source
            )
        } catch {
            // The link is gone; the caller's timeout is all that is left.
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private async dispatch(payload: RpcMessage, source: string, target: string) {
        // Stamped here, on arrival, and by this process's own clock. Comparing the caller's clock
        // with this one would need the two to agree, which over MQTT they broadly do and from a
        // browser they do not.
        const arrived = Date.now()
        if (isRpcCallInstanceMethodPayload(payload)) {
            if (this.deduplicateRequests) {
                const cached = this.recentResponses.get(payload.id)
                if (cached) {
                    const messageType = (cached as RpcErrorPayload).code ? MessageType.ErrorMessage : MessageType.ResponseMessage
                    await this.sendPayload(cached, messageType, this.name, source)
                    return
                }
                // Still running: the original call will answer, so drop the redelivery.
                if (this.inFlightRequests.has(payload.id)) return
                this.inFlightRequests.add(payload.id)
            }
            // Deliberately not getNameSpaceMethodMap(): that creates a map on miss, which would let
            // unknown remote paths grow exposedNameSpaceMethodMaps without bound.
            const map = this.manageRpc.findNameSpaceMethodMap(payload.path)
            const handler = map?.get(payload.method)
            if (!handler) {
                const instanceName = payload.path
                const event = payload.params[0] as string
                const inst = this.manageRpc.exposedNameSpaceInstances[instanceName]
                // The snapshot event only exists on a component. Refused by name before the emitter
                // check, because a plain instance is not an emitter either - and the answer "on is
                // not exposed" would be true and useless, where this one says what to fix.
                if (payload.method === 'on' && event === componentSnapshotEvent && inst && !(inst instanceof RpcComponent)) {
                    await this.sendError(payload.id, source, 'ClassNotFound', `${payload.path} is not an observable component`)
                    return
                }
                if (payload.method === 'on' && inst instanceof EventEmitter) {
                    const denied = await this.checkAccess(payload, source, true)
                    if (denied) {
                        await this.sendError(payload.id, source, denied, `not permitted to subscribe to ${payload.path}.${event}`)
                        return
                    }
                    // Idempotent: a client replaying its subscriptions after a reconnect must not
                    // stack a second listener for a subscription the server already holds.
                    const eventKey = eventProxyKey(instanceName, event, source)
                    let eventProxy = this.eventProxies.get(eventKey)
                    let result = 'ok - already exists'
                    if (!eventProxy) {
                        eventProxy = new EventProxy(this, inst, event, source, instanceName)
                        this.eventProxies.set(eventKey, eventProxy)
                        eventProxy.attach()
                        result = 'ok'
                    }
                    // A component subscription is answered with the current snapshot first - after
                    // the listener is attached, so an update cannot fall between them, and on every
                    // resubscription, so a reconnect repairs whatever was missed with one frame
                    // rather than a replay. Targeted at this subscriber only: the others are current.
                    if (event === componentSnapshotEvent) await this.sendEvent(source, componentSnapshotEvent, [componentSnapshot(inst)], instanceName)
                    await this.respond(payload.id, source, { type: RpcMessageType.success, result, id: payload.id } as RpcSuccessPayload, MessageType.ResponseMessage)
                } else if ((payload.method === 'off' || payload.method === 'removeListener') && inst instanceof EventEmitter) {
                    // Deliberately not authorized. The key includes the caller, so a peer can only
                    // drop its own subscription, and refusing to let someone stop receiving events
                    // would be a strange thing to enforce.
                    const eventKey = eventProxyKey(instanceName, event, source)
                    const eventProxy = this.eventProxies.get(eventKey)
                    if (eventProxy) {
                        eventProxy.detach()
                        this.eventProxies.delete(eventKey)
                    }
                    await this.respond(
                        payload.id,
                        source,
                        { type: RpcMessageType.success, result: eventProxy ? 'ok' : 'ok - was not subscribed', id: payload.id } as RpcSuccessPayload,
                        MessageType.ResponseMessage
                    )
                } else if ((payload.method === '$acquire' || payload.method === '$release') && inst) {
                    // Arbitration is the dispatch layer's, like 'on' and 'off': the check needs the
                    // caller's identity, which methods do not see, and it must not queue behind the
                    // very commands it arbitrates. authorize() rules on it like any other call.
                    if (!(inst instanceof RpcComponent)) {
                        await this.sendError(payload.id, source, 'ClassNotFound', `${payload.path} is not an observable component, so it has no authority to hold`)
                        return
                    }
                    const denied = await this.checkAccess(payload, source, false)
                    if (denied) {
                        await this.sendError(payload.id, source, denied, `not permitted to call ${payload.path}.${payload.method}`)
                        return
                    }
                    if (payload.method === '$acquire') {
                        const ttl = payload.params[0] ?? DEFAULT_AUTHORITY_TTL
                        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
                            await this.sendError(payload.id, source, 'InvalidParams', `$acquire: the lease must expire, so its ttl is a positive number of milliseconds`)
                            return
                        }
                        const take = (payload.params[1] as { take?: boolean } | undefined)?.take === true
                        const outcome = acquireComponentAuthority(inst, source, ttl, take)
                        if (!outcome.granted) {
                            await this.sendError(payload.id, source, 'NotInControl', `${payload.path} is controlled by ${outcome.holder} until ${new Date(outcome.expiresAt).toISOString()}`)
                            return
                        }
                        await this.respond(payload.id, source, { type: RpcMessageType.success, result: outcome.authority, id: payload.id } as RpcSuccessPayload, MessageType.ResponseMessage)
                    } else {
                        const result = releaseComponentAuthority(inst, source)
                        await this.respond(payload.id, source, { type: RpcMessageType.success, result, id: payload.id } as RpcSuccessPayload, MessageType.ResponseMessage)
                    }
                } else await this.sendError(payload.id, source, map ? 'MethodNotFound' : 'ClassNotFound', `${payload.path}.${payload.method} is not exposed`)
                return
            }

            const denied = await this.checkAccess(payload, source, false)
            if (denied) {
                await this.sendError(payload.id, source, denied, `not permitted to call ${payload.path}.${payload.method}`)
                return
            }
            // After authorization: no point spending the check on a caller already being refused.
            const incompatible = this.checkVersion(payload)
            if (incompatible) {
                await this.sendError(payload.id, source, 'IncompatibleVersion', incompatible)
                return
            }
            const invalid = this.checkParams(payload)
            if (invalid) {
                await this.sendError(payload.id, source, 'InvalidParams', invalid)
                return
            }

            // Refused at the door as well as re-checked at execution (see invoke): the door gives a
            // caller a fast answer instead of a place in a queue it will be refused out of.
            const notInControl = this.authorityRefusal(payload, source)
            if (notInControl) {
                await this.sendError(payload.id, source, 'NotInControl', notInControl)
                return
            }

            // The queue, when this call belongs in one, wraps everything from here on: the
            // deadline has to be read after waiting in it, since that wait is exactly what it
            // exists to catch, and a duplicate has to be recognised before a sibling call can start
            // running the same command alongside it.
            const key = this.executionKey(payload, source)
            if (key === undefined) await this.invoke(payload, source, arrived, handler)
            else await this.enqueue(key, payload, source, arrived, handler)
        }
    }

    /**
     * Queue one call behind its key, bounded and conflatable.
     *
     * The bound is a flood guard, not a scheduler. Dequeue-time expiry already refuses whatever
     * waited past its caller's deadline; what the bound catches is the queue itself growing without
     * limit - memory, and a backlog nobody is still waiting for. It refuses on the way in, because
     * a caller told Busy now can decide something, where one whose call dies in the queue later
     * cannot.
     *
     * A conflatable method supersedes its own queued predecessor: the replaced caller hears
     * Superseded immediately rather than when its turn comes, and the superseding call is admitted
     * even at the bound, since it logically takes the replaced call's place - the zombie entry
     * still drains through the chain, so the overshoot is bounded by the number of conflatable
     * methods, not by callers.
     */
    private async enqueue(key: string, payload: RpcCallInstanceMethodPayload, source: string, arrived: number, handler: (...args: unknown[]) => unknown) {
        // NUL as the separator because it cannot occur in a namespace or a method name, so the
        // composite cannot be forged by a clever method string. Escaped, never the byte itself.
        const conflateKey = this.manageRpc.exposedConflation[payload.path]?.has(payload.method) ? `${key}\u0000${payload.method}` : undefined
        let replaced = false
        if (conflateKey) {
            const previous = this.conflatable.get(conflateKey)
            if (previous) {
                previous.supersede()
                replaced = true
            }
        }
        const waiting = this.executionWaiting.get(key) ?? 0
        const limit = this.manageRpc.exposedMailbox[payload.path] ?? DEFAULT_MAILBOX
        if (!replaced && waiting >= limit) {
            await this.sendError(payload.id, source, 'Busy', `${payload.path}.${payload.method} was not queued: ${waiting} calls are already waiting on this instance`)
            return
        }

        let superseded = false
        const entry = conflateKey
            ? {
                  supersede: () => {
                      superseded = true
                      // Answered now rather than at its turn: the caller is freed the moment a newer
                      // value replaces theirs, and an idempotent command that never ran leaves nothing
                      // to record.
                      void this.sendError(payload.id, source, 'Superseded', `${payload.path}.${payload.method} was superseded by a newer call before it ran`).catch(() => undefined)
                  }
              }
            : undefined
        if (conflateKey && entry) this.conflatable.set(conflateKey, entry)
        this.executionWaiting.set(key, waiting + 1)
        await this.serialise(key, async () => {
            const now = this.executionWaiting.get(key) ?? 1
            if (now <= 1) this.executionWaiting.delete(key)
            else this.executionWaiting.set(key, now - 1)
            if (conflateKey && this.conflatable.get(conflateKey) === entry) this.conflatable.delete(conflateKey)
            if (superseded) return
            await this.invoke(payload, source, arrived, handler)
        })
    }

    /** Calls waiting per queue key, so the mailbox bound has something to read. */
    private executionWaiting = new Map<string, number>()
    /** The queued-and-not-started call per conflatable method and key, for the next one to replace. */
    private conflatable = new Map<string, { supersede: () => void }>()

    /**
     * Run one call: check the budget, claim the command, invoke it, answer.
     *
     * Split out of dispatch because it is what a serial instance runs one at a time, and because
     * the order of these four is the whole of the delivery semantics.
     */
    private async invoke(payload: RpcCallInstanceMethodPayload, source: string, arrived: number, handler: (...args: unknown[]) => unknown) {
        const spent = this.expiredBy(payload, arrived)
        if (spent !== undefined) {
            await this.sendError(payload.id, source, 'Timeout', `${payload.path}.${payload.method} was not run: its caller stopped waiting ${spent} ms ago`)
            return
        }

        // The fence, this side of M4's durable ownerEpoch: authority is checked again after any
        // queue wait, because the wait is exactly where a takeover or an expiry can land - and a
        // command from the previous generation must be refused, not run under yesterday's grant.
        const notInControl = this.authorityRefusal(payload, source)
        if (notInControl) {
            await this.sendError(payload.id, source, 'NotInControl', notInControl)
            return
        }

        const invocation = this.invocationFor(payload, source)
        let claimed = false
        if (invocation) {
            let claim
            try {
                claim = await this.idempotency!.begin(invocation)
            } catch (e) {
                // Refused rather than run. A store that cannot be reached is the one condition under
                // which running would risk the double execution it was installed to prevent, and an
                // operator would rather see a command refused than a pump started twice.
                await this.sendError(
                    payload.id,
                    source,
                    'UnknownOutcome',
                    `${payload.path}.${payload.method} was not run: its idempotency store could not be reached (${e instanceof Error ? e.message : String(e)})`
                )
                return
            }
            // Somebody else holds this command. They will answer the caller, and two answers to one
            // request would be worse than waiting for theirs.
            if (claim === 'in-progress') {
                this.inFlightRequests.delete(payload.id)
                return
            }
            if (claim !== 'acquired') {
                // It already ran. This is what it answered, sent again without running anything.
                const stored = isFailedOutcome(claim)
                    ? ({ type: RpcMessageType.error, id: payload.id, code: claim.code, error: claim.error } as RpcErrorPayload)
                    : ({ type: RpcMessageType.success, id: payload.id, result: claim.result } as RpcSuccessPayload)
                await this.respond(payload.id, source, stored, stored.type === RpcMessageType.error ? MessageType.ErrorMessage : MessageType.ResponseMessage)
                return
            }
            claimed = true
        }

        const params = [...payload.params]
        let result
        try {
            result = await handler(...params)
            const badResult = this.checkResult(payload, result)
            if (badResult) {
                // Recorded as the failure it is: the method ran, so a redelivery must not run it
                // again just because this server disliked what it returned.
                await this.settle(invocation, claimed, { code: 'InvalidParams', error: { name: 'RpcError', message: badResult } })
                await this.sendError(payload.id, source, 'InvalidParams', badResult)
                return
            }
            await this.settle(invocation, claimed, { result })
            await this.respond(payload.id, source, { type: RpcMessageType.success, id: payload.id, result } as RpcSuccessPayload, MessageType.ResponseMessage)
        } catch (e) {
            const code = chosenCode(e)
            await this.settle(invocation, claimed, { code, error: toRemoteError(e) })
            await this.respond(payload.id, source, { type: RpcMessageType.error, id: payload.id, code, error: toRemoteError(e) } as RpcErrorPayload, MessageType.ErrorMessage)
        }
    }

    /**
     * Write down what the command did, before its answer is sent.
     *
     * This order is the one that matters. Recording after answering would leave a window in which
     * the caller has the result and the store does not, so a redelivery arriving in that window
     * runs the command again - which is the whole failure this is here to prevent. A store that
     * cannot record it is reported and the answer still goes out: the command has already run, and
     * withholding the result would not un-run it.
     */
    private async settle(invocation: RpcInvocation | undefined, claimed: boolean, outcome: StoredRpcOutcome) {
        if (!invocation || !claimed) return
        try {
            await this.idempotency!.complete(invocation, outcome)
        } catch (e) {
            this.emit('idempotencyError', { invocation, outcome, error: e })
        }
    }

    /** The command a call is an attempt at, or undefined when nothing here needs to know. */
    private invocationFor(payload: RpcCallInstanceMethodPayload, source: string): RpcInvocation | undefined {
        // Only where a repeat would cost something. A store round trip on every read would be paid
        // by the calls that least need it.
        if (!this.idempotency || this.semanticsOf(payload) !== 'non-repeatable-command') return undefined
        return {
            idempotencyKey: payload.idempotencyKey ?? payload.id,
            requestId: payload.id,
            scope: `${payload.path}.${payload.method}`,
            source,
            ...(payload.ttl !== undefined ? { ttl: payload.ttl } : {})
        }
    }

    /**
     * What a method says it does to the world: the running class first, then the schema.
     *
     * The class wins because it is what will actually run. A schema is a description, and a server
     * whose description has drifted from its code should act on the code.
     */
    /** Why this call may not run under the current arbitration state, or undefined when it may. */
    private authorityRefusal(payload: { path: string; method: string }, source: string): string | undefined {
        if (!this.manageRpc.exposedAuthority[payload.path]?.has(payload.method)) return undefined
        const instance = this.manageRpc.exposedNameSpaceInstances[payload.path]
        if (!(instance instanceof RpcComponent)) return undefined
        const authority = componentAuthority(instance)
        const holding = authority.holder !== undefined && (authority.expiresAt ?? 0) > Date.now()
        if (holding && authority.holder === source) return undefined
        return holding
            ? `${payload.path}.${payload.method} requires authority: ${authority.holder} is in control`
            : `${payload.path}.${payload.method} requires authority: nobody is in control - $acquire it first`
    }

    semanticsOf(payload: { path: string; method: string }): RpcMethodSemantics | undefined {
        return this.manageRpc.exposedSemantics[payload.path]?.get(payload.method) ?? this.schema?.namespaces[payload.path]?.methods[payload.method]?.semantics
    }

    /** The queue a call belongs in, or undefined when it may overlap with its siblings. */
    private executionKey(payload: RpcCallInstanceMethodPayload, source: string): string | undefined {
        const execution = this.manageRpc.exposedExecution[payload.path]
        if (!execution) {
            // Nothing declared: graded by what the method says it does. Commands serialise per
            // instance, because command state is what interleaving corrupts and the contract
            // already names which methods command; queries and undeclared methods run as they
            // arrive. Undeclared is deliberately not guessed at - see RpcExecution in Expose.ts.
            const semantics = this.semanticsOf(payload)
            return semantics === 'idempotent-command' || semantics === 'non-repeatable-command' ? payload.path : undefined
        }
        if (execution === 'parallel') return undefined
        if (execution === 'serial') return payload.path
        const context: RpcCallContext = {
            identity: this.resolveIdentity?.(source),
            source,
            instanceName: payload.path,
            method: payload.method,
            params: payload.params,
            subscription: false
        }
        try {
            return `${payload.path}\u0000${execution(context)}`
        } catch {
            // A key function that throws serialises the whole instance rather than letting the call
            // run unordered. The safe reading of "I cannot tell you which queue" is the strictest one.
            return payload.path
        }
    }

    /** One promise chain per key. Entries go away once nothing is waiting, so idle costs nothing. */
    private executionQueues = new Map<string, Promise<void>>()

    private async serialise<T>(key: string, run: () => Promise<T>): Promise<T> {
        const ahead = this.executionQueues.get(key) ?? Promise.resolve()
        let release!: () => void
        const mine = new Promise<void>((resolve) => (release = resolve))
        // The tail is what the next arrival waits behind. It only ever resolves - release() is in a
        // finally - so a method that throws cannot leave the queue permanently rejected.
        const tail = ahead.then(() => mine)
        this.executionQueues.set(key, tail)
        await ahead
        try {
            return await run()
        } finally {
            release()
            if (this.executionQueues.get(key) === tail) this.executionQueues.delete(key)
        }
    }

    /**
     * How long ago the caller's budget ran out, or undefined while it still has one.
     *
     * The budget starts when the frame arrived here, so it covers the wait in front of this method
     * and nothing before it. What came before is the transport's to account for: MQTT 5 hands the
     * broker the same budget as a message expiry, so a request that sat in a queue arrives already
     * shortened, or does not arrive at all.
     */
    private expiredBy(payload: RpcCallInstanceMethodPayload, arrived: number) {
        if (!this.refuseExpiredCalls || payload.ttl === undefined) return undefined
        if (!Number.isFinite(payload.ttl) || payload.ttl < 0) return undefined
        const overdue = Date.now() - (arrived + payload.ttl)
        return overdue > 0 ? overdue : undefined
    }

    /** Catches this server returning something its own contract does not allow. */
    private checkResult(payload: RpcCallInstanceMethodPayload, result: unknown): string | undefined {
        if (!this.validateResults || !this.schema) return undefined
        const returns = this.schema.namespaces[payload.path]?.methods[payload.method]?.returns
        if (!returns) return undefined
        const failure = validateValue(result, returns, this.schema.types, 'result')
        return failure ? `${payload.path}.${payload.method} returned a value its own schema forbids: ${failure}` : undefined
    }

    private sendError(id: string, target: string, code: RpcErrorCode, message: string) {
        return this.respond(id, target, { type: RpcMessageType.error, id, code, error: { name: 'RpcError', message } } as RpcErrorPayload, MessageType.ErrorMessage)
    }

    /**
     * Release every event subscription held for a peer that has gone away. Without this the
     * exposed instance keeps the listener forever and each emit produces an undeliverable frame.
     */
    removePeer(source: string) {
        for (const [key, eventProxy] of this.eventProxies) {
            if (eventProxy.target !== source) continue
            eventProxy.detach()
            this.eventProxies.delete(key)
        }
    }

    async sendEvent(target: string, event: string, params: unknown[], path?: string) {
        return await this.sendPayload({ type: RpcMessageType.event, event, params, path } as RpcEventPayload, MessageType.EventMessage, this.name, target)
    }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class DummyLogger implements ILogger {
    log(level: LogLevel, messageTemplate: string, properties?: { [key: string]: unknown } | undefined) {
        console.log(`LEVEL ${level.toString()}, messageTemplate: ${messageTemplate}, properties: "${properties ? JSON.stringify(properties) : '<empty>'}"`)
    }
}

export class ManageRpc implements IManageRpc {
    exposedNameSpaceMethodMaps: { [nameSpace: string]: Map<string, (...args: unknown[]) => void> } = {}
    exposedNameSpaceInstances: { [nameSpace: string]: object } = {}
    exposedClasses: { [className: string]: new (...args: unknown[]) => unknown } = {}
    createdInstances = new Map<string, object>()
    /** What each exposed namespace's methods declare about repeating them. */
    exposedSemantics: { [nameSpace: string]: Map<string, RpcMethodSemantics> } = {}
    /** How each exposed namespace lets its calls overlap. Absent means graded by method semantics. */
    exposedExecution: { [nameSpace: string]: RpcExecution } = {}
    /** Which of each namespace's methods conflate: a queued call replaced by a newer one. */
    exposedConflation: { [nameSpace: string]: Set<string> } = {}
    /** Which of each namespace's methods only the authority holder may call. */
    exposedAuthority: { [nameSpace: string]: Set<string> } = {}
    /** Each namespace's mailbox bound, where one was declared. Absent means the default. */
    exposedMailbox: { [nameSpace: string]: number } = {}
    /**
     * Set by RpcServer when snapshot validation is on: the component contract to check commits
     * against, read at expose time. A closure rather than a copy, because the schema may gain its
     * introspection namespace after construction and the contract has to be the current one.
     */
    componentContractFor?: (namespace: string) => { component: ComponentSchema; types: RpcSchema['types'] } | undefined

    constructor(public logger?: ILogger) {}

    /**
     * Make the management surface callable remotely. Off unless RpcServer is constructed with
     * exposeManagement, because it is the most dangerous thing this library can offer.
     *
     * Only createRpcInstance is published, and only for classes already passed to exposeClass().
     * The previous behaviour was exposeClassInstance(this, 'manageRpc'), which published every
     * method on this class - including exposeClassInstance and exposeObject themselves, letting
     * any peer that could reach the transport publish arbitrary objects and instantiate arbitrary
     * exposed classes. The logger was published the same way, so anyone could write log entries.
     */
    exposeManagement() {
        const map = this.getNameSpaceMethodMap('manageRpc')
        map.set('createRpcInstance', (...args: unknown[]) => this.createRpcInstance(args[0] as string, args[1] as string | undefined, ...args.slice(2)))
        this.exposedNameSpaceInstances['manageRpc'] = this
    }
    getNameSpaceMethodMap(name: string) {
        let result = this.exposedNameSpaceMethodMaps[name]
        if (!result) {
            result = new Map<string, () => void>()
            this.exposedNameSpaceMethodMaps[name] = result
        }
        return result
    }

    /** Look up a namespace without creating one. Use this on paths that came off the wire. */
    findNameSpaceMethodMap(name: string) {
        return this.exposedNameSpaceMethodMaps[name]
    }

    /** Set by RpcServer: refuse to expose a class that marks nothing. */
    requireExplicitExposure = false

    exposeClassInstance(instance: object, name?: string, options?: number | ExposeOptions) {
        const declared = declaredNamespace(instance)
        const namespace = name ?? declared?.name
        if (!namespace) throw new Error(`exposeClassInstance: ${instance.constructor.name} declares no @rpcNamespace, so a name is required`)
        // A bare number is the old third argument, which was prototypeSteps and nothing else.
        const settings: ExposeOptions = typeof options === 'number' ? { prototypeSteps: options } : (options ?? {})
        let prototypeSteps = settings.prototypeSteps
        // Marked methods are an allow-list. Without marks every function on the prototype chain is
        // published, including helpers the class never meant to offer.
        const allowed = markedMethods(instance)
        if (!allowed && this.requireExplicitExposure)
            throw new Error(`exposeClassInstance: ${instance.constructor.name} marks no @rpc methods and requireExplicitExposure is on`)
        this.exposedNameSpaceInstances[namespace] = instance
        // The call site wins over the class, since it is the one that knows how this particular
        // instance is being used - the same class may front one device here and a pool there.
        const execution = settings.execution ?? declared?.execution
        if (execution) this.exposedExecution[namespace] = execution
        const semantics = declaredSemantics(instance)
        if (semantics.size) this.exposedSemantics[namespace] = semantics
        const conflation = declaredConflation(instance)
        if (conflation.size) {
            // Conflation drops a queued call in favour of a newer one, which is only safe when the
            // contract says repeating - and therefore skipping - is free. Refused here, loudly,
            // rather than discovered in production as a command that silently never ran.
            for (const method of conflation)
                if (semantics.get(method) !== 'idempotent-command')
                    throw new Error(`exposeClassInstance: ${namespace}.${method} declares conflate without 'idempotent-command' semantics - only a command that is free to repeat is free to skip`)
            this.exposedConflation[namespace] = conflation
        }
        const guarded = declaredAuthority(instance)
        if (guarded.size) {
            // Authority is held on the component - its snapshot is where controlledBy is visible
            // and its runtime is where the lease lives. On anything else the flag would silently
            // gate nothing, which is the worst way for a safety-adjacent declaration to fail.
            if (!(instance instanceof RpcComponent))
                throw new Error(`exposeClassInstance: ${namespace}.${[...guarded][0]} declares requiresAuthority, but ${instance.constructor.name} is not an RpcComponent - there is no authority to check against`)
            this.exposedAuthority[namespace] = guarded
        }
        const mailbox = settings.mailbox ?? declared?.mailbox
        if (mailbox !== undefined) {
            if (!Number.isInteger(mailbox) || mailbox < 1) throw new Error(`exposeClassInstance: ${namespace} declares a mailbox of ${mailbox}; the bound is a positive count of waiting calls`)
            this.exposedMailbox[namespace] = mailbox
        }
        // A component's commits become snapshot events on its own emitter, which the ordinary event
        // proxies then fan out - one mechanism for events and snapshots, not two. The publisher is
        // installed here because exposure is when somebody can start listening.
        if (instance instanceof RpcComponent) {
            const contract = this.componentContractFor?.(namespace)
            if (contract)
                installComponentValidator(
                    instance,
                    (props, state) => validateValue(props, contract.component.props, contract.types, 'props') ?? validateValue(state, contract.component.state, contract.types, 'state')
                )
            installComponentPublisher(instance, settings.component ?? {}, () => void instance.emit(componentSnapshotEvent, componentSnapshot(instance)), this.logger)
        }
        // Iterate upwards to find all the methods within the prototype chain.
        let props = Object.getOwnPropertyNames(instance.constructor.prototype)
        let parent = Object.getPrototypeOf(instance.constructor.prototype)
        while (parent && parent.constructor.name !== 'Object' && parent.constructor.name !== 'EventEmitter') {
            const parentProps = Object.getOwnPropertyNames(parent)
            props = props.concat(parentProps)
            parent = Object.getPrototypeOf(parent)
            if (prototypeSteps && prototypeSteps-- === 0) break
        }
        // All methods was found.
        const map = this.getNameSpaceMethodMap(namespace)
        for (const f of props) {
            if (f === 'constructor' || typeof (instance as ObjectByString)[f] !== 'function') continue
            if (allowed && !allowed.has(f)) continue
            map.set(f, (instance as BindObject)[f].bind(instance))
        }
    }

    exposeClass<T>(constructor: new () => T, aliasName?: string) {
        let name = constructor.name
        if (aliasName) name = aliasName
        this.exposedClasses[name] = constructor
    }

    exposeObject(obj: object, name: string) {
        this.exposedNameSpaceInstances[name] = obj
        const props = Object.getOwnPropertyNames(obj)
        for (const f of props) {
            if (f !== 'constructor' && typeof (obj as ObjectByString)[f] === 'function') {
                const map = this.getNameSpaceMethodMap(name)
                map.set(f, (obj as BindObject)[f])
            }
        }
    }

    expose(methodName: string, method: () => void) {
        const map = this.getNameSpaceMethodMap(methodName)
        map.set(methodName, method)
    }
    async createRpcInstance(className: string, instanceName?: string, ...args: unknown[]) {
        let result: string = ''
        const con = this.exposedClasses[className]
        if (con) {
            const id = instanceName ? instanceName : uuidv4()
            const instance = new con(...args)
            this.createdInstances.set(id, instance as ObjectByString)
            this.exposeClassInstance(instance as object, id)
            result = id
        }
        return result
    }
}
