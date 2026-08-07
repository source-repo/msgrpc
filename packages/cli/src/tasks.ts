import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defaultWebPort, type RpcSchema } from '@source-repo/rpc'
import { startConsole } from './console.js'
import { loadSigningKeys } from './credentials.js'
import { looksLikeSchema, startFake, type FakeScript } from './fake.js'
import type { NetworkOptions } from './network.js'
import { startNode } from './node.js'

export interface TaskNetwork {
    broker?: string
    hub?: string
    prefix?: string
    timeout?: number
    insecureTls?: boolean
}

interface CommonTask {
    id: string
    type: 'console' | 'node' | 'serve'
    network?: TaskNetwork
    name?: string
    sign?: string
}

export interface ConsoleTask extends CommonTask {
    type: 'console'
    host?: string
    port?: number
    basePath?: string
}

export interface NodeTask extends CommonTask {
    type: 'node'
    scripts: string
    scriptableBy: string[]
}

export interface ServeTask extends CommonTask {
    type: 'serve'
    contract: string
    script?: string
    allowExec?: boolean
}

export type SourceRpcTask = ConsoleTask | NodeTask | ServeTask

export interface SourceRpcTaskFile {
    version: 1
    network?: TaskNetwork
    tasks: SourceRpcTask[]
}

export interface StartedTask {
    id: string
    type: SourceRpcTask['type']
    name: string
    url?: string
    namespaces?: string[]
}

export interface TaskFileRun {
    file: string
    tasks: StartedTask[]
    close: () => Promise<void>
}

export interface TaskFileCallbacks {
    started?: (task: StartedTask) => void
    warning?: (message: string) => void
}

type JsonObject = Record<string, unknown>

const objectAt = (value: unknown, where: string): JsonObject => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`)
    return value as JsonObject
}

const rejectUnknown = (object: JsonObject, allowed: readonly string[], where: string) => {
    const unknown = Object.keys(object).find((key) => !allowed.includes(key))
    if (unknown) throw new Error(`${where} has unknown field "${unknown}"`)
}

const optionalString = (object: JsonObject, key: string, where: string) => {
    const value = object[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value) throw new Error(`${where}.${key} must be a non-empty string`)
    return value
}

const requiredString = (object: JsonObject, key: string, where: string) => {
    const value = optionalString(object, key, where)
    if (value === undefined) throw new Error(`${where}.${key} is required`)
    return value
}

const optionalBoolean = (object: JsonObject, key: string, where: string) => {
    const value = object[key]
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new Error(`${where}.${key} must be true or false`)
    return value
}

const optionalPositiveNumber = (object: JsonObject, key: string, where: string) => {
    const value = object[key]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${where}.${key} must be a positive number`)
    return value
}

const stringList = (object: JsonObject, key: string, where: string) => {
    const value = object[key]
    if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item))
        throw new Error(`${where}.${key} must be a non-empty array of peer names`)
    return value as string[]
}

const parseNetwork = (value: unknown, where: string): TaskNetwork => {
    const object = objectAt(value, where)
    rejectUnknown(object, ['broker', 'hub', 'prefix', 'timeout', 'insecureTls'], where)
    const broker = optionalString(object, 'broker', where)
    const hub = optionalString(object, 'hub', where)
    const prefix = optionalString(object, 'prefix', where)
    const timeout = optionalPositiveNumber(object, 'timeout', where)
    const insecureTls = optionalBoolean(object, 'insecureTls', where)
    return {
        ...(broker ? { broker } : {}),
        ...(hub ? { hub } : {}),
        ...(prefix ? { prefix } : {}),
        ...(timeout ? { timeout } : {}),
        ...(insecureTls !== undefined ? { insecureTls } : {})
    }
}

const COMMON_FIELDS = ['id', 'type', 'network', 'name', 'sign'] as const

const parseTask = (value: unknown, index: number): SourceRpcTask => {
    const where = `tasks[${index}]`
    const object = objectAt(value, where)
    const id = requiredString(object, 'id', where)
    const type = requiredString(object, 'type', where)
    if (type !== 'console' && type !== 'node' && type !== 'serve') throw new Error(`${where}.type must be console, node, or serve`)

    const network = object.network === undefined ? undefined : parseNetwork(object.network, `${where}.network`)
    const name = optionalString(object, 'name', where)
    const sign = optionalString(object, 'sign', where)
    const common = { id, type, ...(network ? { network } : {}), ...(name ? { name } : {}), ...(sign ? { sign } : {}) }

    if (type === 'console') {
        rejectUnknown(object, [...COMMON_FIELDS, 'host', 'port', 'basePath'], where)
        const host = optionalString(object, 'host', where)
        const port = optionalPositiveNumber(object, 'port', where)
        if (port !== undefined && !Number.isInteger(port)) throw new Error(`${where}.port must be an integer`)
        const basePath = optionalString(object, 'basePath', where)
        return { ...common, type, ...(host ? { host } : {}), ...(port ? { port } : {}), ...(basePath ? { basePath } : {}) }
    }

    if (type === 'node') {
        rejectUnknown(object, [...COMMON_FIELDS, 'scripts', 'scriptableBy'], where)
        return { ...common, type, scripts: requiredString(object, 'scripts', where), scriptableBy: stringList(object, 'scriptableBy', where) }
    }

    rejectUnknown(object, [...COMMON_FIELDS, 'contract', 'script', 'allowExec'], where)
    const script = optionalString(object, 'script', where)
    const allowExec = optionalBoolean(object, 'allowExec', where)
    return {
        ...common,
        type,
        contract: requiredString(object, 'contract', where),
        ...(script ? { script } : {}),
        ...(allowExec !== undefined ? { allowExec } : {})
    }
}

/** Parse strictly so a misspelled setting is a startup error rather than an ignored intention. */
export const parseTaskFile = (value: unknown): SourceRpcTaskFile => {
    const root = objectAt(value, 'task file')
    rejectUnknown(root, ['version', 'network', 'tasks'], 'task file')
    if (root.version !== 1) throw new Error('task file.version must be 1')
    const network = root.network === undefined ? undefined : parseNetwork(root.network, 'task file.network')
    if (!Array.isArray(root.tasks) || !root.tasks.length) throw new Error('task file.tasks must be a non-empty array')
    const tasks = root.tasks.map(parseTask)
    const duplicate = tasks.find((task, index) => tasks.findIndex((candidate) => candidate.id === task.id) !== index)
    if (duplicate) throw new Error(`task file has duplicate task id "${duplicate.id}"`)
    return { version: 1, ...(network ? { network } : {}), tasks }
}

const readJson = (path: string, what: string): unknown => {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (e) {
        throw new Error(`cannot read ${what} from ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
}

interface PreparedTask {
    task: SourceRpcTask
    network: NetworkOptions
    schema?: RpcSchema
    script?: FakeScript
}

const prepareTasks = (file: string, config: SourceRpcTaskFile, callbacks: TaskFileCallbacks): PreparedTask[] => {
    const directory = dirname(file)
    const prepared = config.tasks.map((task) => {
        const merged = { ...config.network, ...task.network }
        if (!merged.broker && !merged.hub) throw new Error(`task "${task.id}": network needs broker, hub, or both`)

        const keyPath = task.sign ? resolve(directory, task.sign) : undefined
        const signing = keyPath ? loadSigningKeys(keyPath) : undefined
        if (signing?.readableByOthers) callbacks.warning?.(`task "${task.id}": ${keyPath} is readable by other users`)
        if (signing?.keys.name && task.name && signing.keys.name !== task.name)
            throw new Error(`task "${task.id}": name "${task.name}" does not match "${signing.keys.name}" in ${keyPath}`)

        const network: NetworkOptions = {
            ...(merged.broker ? { broker: merged.broker } : {}),
            ...(merged.hub ? { hub: merged.hub } : {}),
            ...(merged.prefix ? { prefix: merged.prefix } : {}),
            name: task.name ?? signing?.keys.name ?? task.id,
            callTimeout: merged.timeout ?? 10000,
            ...(merged.insecureTls ? { insecureTls: true } : {}),
            ...(signing ? { sign: signing.sign, ...(signing.verify ? { verify: signing.verify } : {}) } : {})
        }

        if (task.type === 'serve') {
            const contractPath = resolve(directory, task.contract)
            const schema = readJson(contractPath, 'contract')
            if (!looksLikeSchema(schema)) throw new Error(`task "${task.id}": ${contractPath} is not a Source RPC contract`)
            const scriptPath = task.script ? resolve(directory, task.script) : undefined
            const script = scriptPath ? (readJson(scriptPath, 'script') as FakeScript) : undefined
            return { task, network, schema, ...(script ? { script } : {}) }
        }
        return { task, network }
    })

    const duplicate = prepared.find((entry, index) => prepared.findIndex((candidate) => candidate.network.name === entry.network.name) !== index)
    if (duplicate) throw new Error(`task file starts more than one peer named "${duplicate.network.name}"`)
    return prepared
}

const closeStarted = async (started: { close: () => Promise<void> }[]) => {
    const failures: unknown[] = []
    for (const task of [...started].reverse()) {
        try {
            await task.close()
        } catch (e) {
            failures.push(e)
        }
    }
    if (failures.length) throw new AggregateError(failures, `failed to close ${failures.length} task${failures.length === 1 ? '' : 's'}`)
}

/** Start every task in one process, rolling back the earlier ones if a later task cannot start. */
export const startTaskFile = async (path: string, callbacks: TaskFileCallbacks = {}): Promise<TaskFileRun> => {
    const file = resolve(path)
    const config = parseTaskFile(readJson(file, 'task file'))
    const prepared = prepareTasks(file, config, callbacks)
    const running: { info: StartedTask; close: () => Promise<void> }[] = []

    for (const entry of prepared) {
        const { task, network } = entry
        try {
            if (task.type === 'console') {
                const console = await startConsole({
                    ...network,
                    host: task.host ?? '127.0.0.1',
                    port: task.port ?? defaultWebPort,
                    ...(task.basePath ? { basePath: task.basePath } : {})
                })
                running.push({ info: { id: task.id, type: task.type, name: network.name, url: console.url }, close: console.close })
                if (task.host && task.host !== '127.0.0.1' && task.host !== 'localhost')
                    callbacks.warning?.(`task "${task.id}": console is bound to ${task.host}; anyone who can reach it can use its granted authority`)
            } else if (task.type === 'node') {
                const node = await startNode({
                    ...network,
                    scripts: resolve(dirname(file), task.scripts),
                    scriptableBy: task.scriptableBy
                })
                running.push({ info: { id: task.id, type: task.type, name: network.name }, close: node.close })
                if (network.broker && !network.sign)
                    callbacks.warning?.(`task "${task.id}": unsigned MQTT cannot prove a scripting caller's identity; scripting calls will be refused`)
            } else {
                const fake = await startFake({
                    ...network,
                    schema: entry.schema!,
                    ...(entry.script ? { script: entry.script } : {}),
                    ...(task.allowExec ? { allowExec: true } : {})
                })
                running.push({ info: { id: task.id, type: task.type, name: network.name, namespaces: fake.namespaces }, close: fake.close })
                callbacks.warning?.(`task "${task.id}": serve is a fake, not a device`)
                if (task.allowExec) callbacks.warning?.(`task "${task.id}": allowExec runs code supplied by its script`)
            }
            callbacks.started?.(running.at(-1)!.info)
        } catch (e) {
            try {
                await closeStarted(running)
            } catch (rollback) {
                throw new AggregateError([e, rollback], `task "${task.id}" failed to start and rollback also failed`, { cause: rollback })
            }
            throw new Error(`task "${task.id}" failed to start: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
        }
    }

    let closed = false
    return {
        file,
        tasks: running.map(({ info }) => info),
        close: async () => {
            if (closed) return
            closed = true
            await closeStarted(running)
        }
    }
}
