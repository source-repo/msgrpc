/**
 * A small plant to point the console at: three levels of topology, four observable components and
 * ambient context provided at three different nodes.
 *
 * It exists so the context and component panels have something true to show. Everything here is
 * ordinary library usage - no console-specific hooks - because a panel that only works against a
 * peer built for it proves nothing about the peer on the wall.
 *
 * The types below are the point of the example as much as the values are. `props` and `state` are
 * declared as interfaces, `extract` reads them with ts-morph, and the contract it writes carries
 * them beside the method signatures - so a console that has never seen this file knows that
 * `door` is one of two words and `setpoint` is a number between 0 and 300, and can draw the state
 * as a typed tree instead of guessing from whatever the current values happen to look like.
 *
 * Run it with the decorator-free twin, which is what `strip` is for:
 *
 *     npm run example:contract   # extract  -> contract.json, the published interface
 *     npm run example:build      # strip    -> dist/plant.ts, which Node runs directly
 *     node examples/display-context/dist/plant.ts
 */

import { readFile } from 'node:fs/promises'
import { HOST_ROOT, RpcComponent, RpcServer, defineRpcContext, rpc, rpcNamespace } from '@source-repo/rpc'

const NAME = process.env.PLANT_NAME ?? 'bakery'
const PORT = Number(process.env.PLANT_PORT ?? 7843)
const contract = JSON.parse(await readFile(new URL('../contract.json', import.meta.url), 'utf8'))

// --------------------------------------------------------------------------- context tokens
//
// Ids are namespaced and stable, because a token id is what a console has to be told to watch and
// what a second peer has to agree on. The axis is the load-bearing choice: `physical` walks the
// parent chain - where a thing is - and `logical` walks the owner chain - what it is working for.
// There is no fallback from one to the other, so a token that resolves to nothing on its own axis
// is honestly missing rather than quietly answered from the other tree.

export const SiteToken = defineRpcContext<{ site: string; plant: string; pressureUnit: string; timezone: string }>({
    id: 'acme.site',
    schemaVersion: '1',
    axis: 'physical'
})

export const WorkOrderToken = defineRpcContext<{ workOrder: string; product: string; due: string }>({
    id: 'acme.work-order',
    schemaVersion: '1',
    axis: 'logical'
})

/** `collect` gathers the whole chain nearest-first, which is how a maintenance window is read. */
export const MaintenanceToken = defineRpcContext<{ window: string; contact: string }>({
    id: 'acme.maintenance',
    schemaVersion: '1',
    axis: 'physical',
    resolution: 'collect'
})

// --------------------------------------------------------------------------- the interfaces

/**
 * A component's props and state are written as `type` aliases rather than interfaces, and it has to
 * be that way round. `RpcComponent<P, S>` constrains both to `RpcComponentData`, which is
 * `Record<string, unknown>` - and TypeScript gives an object *type alias* an implicit index
 * signature while an `interface` gets none, so an otherwise identical interface does not satisfy the
 * constraint. The error names the constraint rather than the cause, so it is worth knowing here.
 *
 * Only the types handed to `RpcComponent` need it. The shapes nested inside them - `Batch`, `Zone`,
 * `Reading` - are ordinary values and stay interfaces.
 */
export interface Batch {
    id: string
    startedAt: string
    loaves: number
}

export type LineProps = {
    label: string
    ratePerHour: number
    unit: string
}

export type LineState = {
    running: boolean
    produced: number
    shift: 'day' | 'night'
    lastBatch: Batch
}

/** One heated zone of the oven. Nested on purpose: a state tree is not always one level deep. */
export interface Zone {
    temperature: number
    setpoint: number
}

/** The shape a process value arrives in, which the console renders specially when it recognises it. */
export interface Reading {
    value: number
    unit: string
    quality: 'good' | 'uncertain' | 'bad'
}

export type OvenProps = {
    label: string
    maximum: number
    unit: string
}

export type OvenState = {
    temperature: number
    setpoint: number
    mode: 'idle' | 'heating' | 'cooling'
    door: 'open' | 'closed'
    zones: { top: Zone; bottom: Zone }
    /** Keyed by tag, which is how plant data usually arrives, and a record in the contract. */
    readings: { [tag: string]: Reading }
}

/**
 * The shape a real screen has: a few hundred tags, most of them still, one of them moving faster
 * than anyone can read. It is here to be measured against, because "the panel is cheap now" is a
 * claim and a claim is not a measurement.
 */
export type FieldProps = {
    label: string
    tags: number
}

export type FieldState = {
    /** Moves every tick. On a whole-snapshot channel it drags every other tag along the wire. */
    fast: number
    sweep: number
    tags: { [tag: string]: Reading }
}

export type MixerProps = {
    label: string
    maximumRpm: number
    unit: string
}

export type MixerState = {
    speed: number
    bowl: 'empty' | 'mixing'
}

// --------------------------------------------------------------------------- components

/**
 * A production line. Its state is what the line is doing; its props are what it was configured
 * with. Both travel in one snapshot, and a client reads them from a local cache.
 */
@rpcNamespace('line', { version: '1' })
export class Line extends RpcComponent<LineProps, LineState> {
    constructor(label: string, ratePerHour: number) {
        super(
            { label, ratePerHour, unit: 'loaves/h' },
            { running: false, produced: 0, shift: 'day', lastBatch: { id: 'B-0', startedAt: new Date().toISOString(), loaves: 0 } }
        )
    }

    @rpc({ semantics: 'idempotent-command', sets: 'running' })
    async setRunning(running: boolean) {
        this.setState({ running })
        return this.state.running
    }

    @rpc({ semantics: 'idempotent-command', sets: 'shift' })
    async setShift(shift: LineState['shift']) {
        this.setState({ shift })
        return shift
    }

    /** Called by the tick, not remotely. An unmarked method is not part of the contract. */
    advance(loaves: number) {
        if (!this.state.running) return
        this.setState((previous) => ({
            produced: previous.produced + loaves,
            lastBatch: { ...previous.lastBatch, loaves: previous.lastBatch.loaves + loaves }
        }))
    }
}

/**
 * An oven. `temperature` is measured and `setpoint` is commanded, which is the distinction the
 * console's editor is built around: a field is editable when a method *declares* that it sets it,
 * and no field is editable because a panel felt like drawing an input next to it.
 *
 * Every command here says what it sets. Nothing infers it from the method's name, which is what
 * lets `zones.top.setpoint` have an editor and `zones.top.temperature` - sitting right beside it,
 * same shape, same type - correctly have none.
 */
@rpcNamespace('oven', { version: '1' })
export class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor(label: string, maximum: number) {
        super(
            { label, maximum, unit: '°C' },
            {
                temperature: 20,
                setpoint: 20,
                mode: 'idle',
                door: 'closed',
                zones: { top: { temperature: 20, setpoint: 20 }, bottom: { temperature: 20, setpoint: 20 } },
                readings: { 'flue.temp': { value: 18, unit: '°C', quality: 'good' }, 'steam.pressure': { value: 0, unit: 'bar', quality: 'uncertain' } }
            }
        )
    }

    @rpc({ semantics: 'idempotent-command', sets: 'setpoint' })
    async setSetpoint(celsius: number) {
        if (celsius < 0 || celsius > this.props.maximum) throw new Error(`setpoint ${celsius} is outside 0..${this.props.maximum}`)
        this.setState((previous) => ({
            setpoint: celsius,
            zones: { top: { ...previous.zones.top, setpoint: celsius }, bottom: { ...previous.zones.bottom, setpoint: celsius } }
        }))
        return celsius
    }

    @rpc({ semantics: 'idempotent-command', sets: 'mode' })
    async setMode(mode: OvenState['mode']) {
        this.setState({ mode })
        return mode
    }

    @rpc({ semantics: 'idempotent-command', sets: 'door' })
    async setDoor(door: OvenState['door']) {
        this.setState({ door })
        return door
    }

    /**
     * The nested case, and the reason `sets` is a path rather than a field name. Nothing about the
     * name `setTopSetpoint` says it reaches `zones.top.setpoint`; the declaration does, so the
     * console draws an editor two levels down where a naming rule could never have found one.
     *
     * The zone temperatures beside these stay uneditable, because nothing claims them.
     */
    @rpc({ semantics: 'idempotent-command', sets: 'zones.top.setpoint' })
    async setTopSetpoint(celsius: number) {
        if (celsius < 0 || celsius > this.props.maximum) throw new Error(`setpoint ${celsius} is outside 0..${this.props.maximum}`)
        this.setState((previous) => ({ zones: { ...previous.zones, top: { ...previous.zones.top, setpoint: celsius } } }))
        return celsius
    }

    @rpc({ semantics: 'idempotent-command', sets: 'zones.bottom.setpoint' })
    async setBottomSetpoint(celsius: number) {
        if (celsius < 0 || celsius > this.props.maximum) throw new Error(`setpoint ${celsius} is outside 0..${this.props.maximum}`)
        this.setState((previous) => ({ zones: { ...previous.zones, bottom: { ...previous.zones.bottom, setpoint: celsius } } }))
        return celsius
    }

    /** The measurement, not a command: it moves on its own and nothing remote may assign it. */
    tick() {
        const { door, setpoint } = this.state
        // An open door loses heat whatever the setpoint says, which is the sort of thing that
        // makes a live panel worth watching.
        const target = door === 'open' ? Math.min(setpoint, 30) : setpoint
        const move = (zone: Zone, bias: number): Zone => {
            const wanted = Math.max(0, target + bias)
            const delta = wanted - zone.temperature
            if (Math.abs(delta) < 0.5) return zone
            return { ...zone, temperature: Math.round((zone.temperature + Math.max(-4, Math.min(3, delta))) * 10) / 10 }
        }
        this.setState((previous) => {
            const zones = { top: move(previous.zones.top, 4), bottom: move(previous.zones.bottom, -4) }
            const temperature = Math.round(((zones.top.temperature + zones.bottom.temperature) / 2) * 10) / 10
            const rising = temperature > previous.temperature
            const settled = Math.abs(target - temperature) < 0.5
            return {
                zones,
                temperature,
                mode: settled ? 'idle' : rising ? 'heating' : 'cooling',
                readings: {
                    ...previous.readings,
                    'flue.temp': { value: Math.round(temperature * 0.6 * 10) / 10, unit: '°C', quality: 'good' },
                    'steam.pressure': {
                        value: Math.round(Math.max(0, (temperature - 100) / 100) * 100) / 100,
                        unit: 'bar',
                        quality: door === 'open' ? 'uncertain' : 'good'
                    }
                }
            }
        })
    }
}

/** A mixer, so the tree has a second leaf under the same line and a second editable number. */
@rpcNamespace('mixer', { version: '1' })
export class Mixer extends RpcComponent<MixerProps, MixerState> {
    constructor(label: string) {
        super({ label, maximumRpm: 400, unit: 'rpm' }, { speed: 0, bowl: 'empty' })
    }

    @rpc({ semantics: 'idempotent-command', sets: 'speed' })
    async setSpeed(rpm: number) {
        if (rpm < 0 || rpm > this.props.maximumRpm) throw new Error(`speed ${rpm} is outside 0..${this.props.maximumRpm}`)
        this.setState({ speed: rpm, bowl: rpm > 0 ? 'mixing' : 'empty' })
        return rpm
    }
}

/**
 * A field of tags, and the case a marker per field would be absurd for: three hundred values, so
 * three hundred `@rpc({ sets })` declarations and three hundred methods to carry them.
 *
 * The honest form is one method that takes the path, declared `sets: '*'`. The panel's cost still
 * has to be paid by rendering rather than by pretending there is less to draw.
 */
@rpcNamespace('field', { version: '1' })
export class Field extends RpcComponent<FieldProps, FieldState> {
    constructor(label: string, count: number) {
        const tags: { [tag: string]: Reading } = {}
        for (let index = 0; index < count; index++)
            tags[`tag.${String(index).padStart(3, '0')}`] = { value: index, unit: index % 3 === 0 ? 'bar' : '°C', quality: 'good' }
        super({ label, tags: count }, { fast: 0, sweep: 0, tags })
    }

    @rpc({ semantics: 'query' })
    async count() {
        return Object.keys(this.state.tags).length
    }

    /**
     * The generic setter, and it is refused outright unless the host was started with
     * `allowStatePathWrites` - which this one is, being a development plant.
     *
     * The signature is concrete because the contract has to describe it; a caller that wants
     * `rpcPath` to check the value against the path asks for `RpcPathWriter` from `proxy<T>()`.
     *
     * **Which paths are open is decided here, and that is the part the library must not supply.**
     * A writer handed over by the framework would be a public field with extra steps: it would take
     * `fast` - a measurement that moves five times a second and would be overwritten by the next
     * tick - and it would take `sweep`, which is this component's own bookkeeping. Only a tag's
     * `value` may be written, and only to a number, and only to a tag that exists.
     */
    @rpc({ semantics: 'idempotent-command', sets: '*' })
    async set(path: string[], value: unknown) {
        const [root, tag, field] = path
        if (root !== 'tags' || path.length !== 3 || field !== 'value') throw new Error(`${path.join('.')} is not writable - only tags.<tag>.value is`)
        if (!this.state.tags[tag]) throw new Error(`no tag ${tag}`)
        if (typeof value !== 'number') throw new Error(`tags.${tag}.value is a number, not ${typeof value}`)
        this.setState((previous) => ({ tags: { ...previous.tags, [tag]: { ...previous.tags[tag], value } } }))
        return value
    }

    /**
     * One value moves on every tick and one more moves once a second, so the panel can be watched
     * doing the thing it is supposed to do: redraw two rows out of three hundred.
     */
    tick(slow: boolean) {
        this.setState((previous) => {
            const fast = Math.round((previous.fast + 1.7) * 10) / 10
            if (!slow) return { fast }
            const sweep = (previous.sweep + 1) % Object.keys(previous.tags).length
            const tag = `tag.${String(sweep).padStart(3, '0')}`
            return {
                fast,
                sweep,
                tags: { ...previous.tags, [tag]: { ...previous.tags[tag], value: Math.round(Math.random() * 1000) / 10 } }
            }
        })
    }
}

// --------------------------------------------------------------------------- the network
//
// Two peers, because one host cannot show the thing worth showing. `bakery` holds the site and the
// bread line; `pastry` is a second host whose own root hangs under the bakery's root, and whose
// line is *owned by* the bakery's line. So the physical chain crosses hosts root to root and the
// logical chain crosses through a remote owner - the two ways a chain leaves a host - and a
// console asking `pastry` about its line gets an answer that says where the rest of it lives.

const bakery = new RpcServer({
    name: NAME,
    transports: [{ port: PORT }],
    // The host's own place on the physical axis. Context providers at HOST_ROOT hang off this.
    topology: { place: ['site-7', 'bakery'] },
    schema: contract,
    // Without this the peer answers ClassNotFound to describe(), and a console can list it but
    // never show what it is. A plant peer that expects to be browsed opts in.
    exposeIntrospection: true,
    // Honour `field.set`, which writes wherever its caller names. Off by default and deliberately
    // a decision: this is a development plant, where a generic setter is the thing that makes a
    // console usable against three hundred tags. On a real one the answer is the per-field
    // declarations, whose methods carry the interlocks - and this line would not be here.
    allowStatePathWrites: true
})
await bakery.ready()

const breadLine = new Line('Bread line', 900)
const deck = new Oven('Deck oven', 300)
const spiral = new Mixer('Spiral mixer')
const field = new Field('Tag field', Number(process.env.PLANT_TAGS ?? 300))

bakery.exposeClassInstance(breadLine, 'line')
bakery.exposeClassInstance(deck, 'oven')
bakery.exposeClassInstance(spiral, 'mixer')
bakery.exposeClassInstance(field, 'field')

const inBakery = (instance: string) => ({ peer: NAME, instance })

// Physical: where the equipment stands. Logical: which line's work it is doing.
await bakery.topology.declare('line', { parent: inBakery(HOST_ROOT), label: 'Bread line' })
await bakery.topology.declare('oven', { parent: inBakery('line'), owner: inBakery('line'), label: 'Deck oven' })
await bakery.topology.declare('mixer', { parent: inBakery('line'), owner: inBakery('line'), label: 'Spiral mixer' })
await bakery.topology.declare('field', { parent: inBakery(HOST_ROOT), label: 'Tag field' })

const SECOND = process.env.PLANT_SECOND_NAME ?? 'pastry'
const pastry = new RpcServer({
    name: SECOND,
    transports: [{ connect: `http://localhost:${PORT}` }],
    topology: { place: ['site-7', 'pastry'] },
    schema: contract,
    exposeIntrospection: true
})
await pastry.ready()

const pastryLine = new Line('Pastry line', 400)
pastry.exposeClassInstance(pastryLine, 'line')

// Root to root: the only physical edge that may cross hosts, which is why a page cannot graft
// itself under a remote node to read one - and why the console asks the owning host instead.
await pastry.topology.updateHost({ parent: { peer: NAME, instance: HOST_ROOT } }, { expectedVersion: pastry.topology.get(HOST_ROOT)!.version })
await pastry.topology.declare('line', { owner: { peer: NAME, instance: 'line' }, label: 'Pastry line' })

// --------------------------------------------------------------------------- context providers
//
// One provider owns one value for one token at one node; a second provide() for the same pair is
// refused rather than silently winning. The handle is what changes a value later.

bakery.provideContext(HOST_ROOT, SiteToken, { site: 'site-7', plant: 'bakery', pressureUnit: 'bar', timezone: 'Europe/Stockholm' })
bakery.provideContext(HOST_ROOT, MaintenanceToken, { window: 'Sundays 02:00-06:00', contact: 'site-facilities' })
bakery.provideContext('line', MaintenanceToken, { window: 'Tuesdays 22:00-23:00', contact: 'line-mechanic' })
const breadWork = bakery.provideContext('line', WorkOrderToken, { workOrder: 'WO-4711', product: 'Sourdough 800g', due: '2026-08-08T04:00:00Z' })

// Nothing is provided on `pastry` at all, deliberately: everything its line sees is inherited, so
// the console shows an answer whose provider is on another peer.

// --------------------------------------------------------------------------- movement
//
// Something has to change, or a panel that re-renders correctly and a panel that never re-renders
// at all look identical.

// Five times a second, which is fast for a snapshot channel and slow for a plant.
const fastTimer = setInterval(() => field.tick(false), 200)
fastTimer.unref?.()

let ticks = 0
const timer = setInterval(() => {
    ticks++
    deck.tick()
    field.tick(true)
    breadLine.advance(2)
    pastryLine.advance(1)
    // The work order moves every couple of minutes, so context is visibly live rather than a
    // constant the page read once at startup - and it moves on the peer that does not own it.
    if (ticks % 120 === 0)
        breadWork.set({ workOrder: `WO-${4711 + ticks / 120}`, product: 'Sourdough 800g', due: new Date(Date.now() + 3600_000).toISOString() })
}, 1000)
timer.unref?.()

process.stdout.write(`plant '${NAME}' on port ${PORT}: line, oven, mixer, field (${field.props.tags} tags, one moving at 5 Hz) — and '${SECOND}' with a line of its own\n`)
process.stdout.write(`context: ${SiteToken.id} at the bakery root, ${WorkOrderToken.id} at its line, ${MaintenanceToken.id} collected up the physical chain\n`)
process.stdout.write(`next: source-rpc console --hub http://localhost:${PORT}\n`)

const stop = async () => {
    clearInterval(timer)
    clearInterval(fastTimer)
    await pastry.close()
    await bakery.close()
    process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
