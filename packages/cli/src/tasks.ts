import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerOptions as TlsServerOptions } from 'node:https'
import { dirname, resolve } from 'node:path'
import { defaultSecureWebPort, defaultWebPort, type RpcAiGrants, type RpcSchema } from '@source-repo/rpc'
import { startConsole } from './console.js'
import { loadAuthFile, loadSigningKeys, loadTls, readableByOthers, scriptCredentials, signingFrom, type Signing, type SigningKeys } from './credentials.js'
import { looksLikeSchema, startFake, type FakeScript } from './fake.js'
import { grantLines, loadAiGrants } from './grants.js'
import type { NetworkOptions } from './network.js'
import { startNode } from './node.js'

/**
 * What `run` starts when nothing is named, and what `run --init` writes when nothing is named.
 *
 * Looked for in the working directory and nowhere else. Walking up the tree the way `package.json`
 * is found would mean that running this three directories deep silently starts the roles described
 * somewhere above — with that file's signing secrets, under that file's peer names, on that file's
 * bus. A task file is an identity, so which one ran must never depend on where the shell happened
 * to be. Named for what it is rather than `tasks.json`, which is already several other things.
 */
export const defaultTaskFile = 'source-rpc.tasks.json'

/** MQTT's own username and password, which authenticate the connection rather than the peer. */
export interface TaskMqttAuth {
    username?: string
    password?: string
}

export interface TaskNetwork {
    broker?: string
    hub?: string
    prefix?: string
    timeout?: number
    insecureTls?: boolean
    mqtt?: TaskMqttAuth
}

/**
 * What a task presents when a bus asks who it is: a bearer token for a hub, and the `derive` secret
 * a node mints its scripts' credentials with.
 *
 * `tokens` and `issuers` are deliberately not here. Those say what a *bus* accepts, and no task type
 * is a bus - putting them in a host's file would be writing a policy nothing in that file enforces.
 */
export interface TaskAuth {
    token?: string
    derive?: string
}

interface CommonTask {
    id: string
    type: 'console' | 'node' | 'serve'
    network?: TaskNetwork
    name?: string
    /** A path to a key file, or the same keys written inline. */
    sign?: string | SigningKeys
    /** A path to an auth file, or the same credentials written inline. */
    auth?: string | TaskAuth
}

export interface ConsoleTask extends CommonTask {
    type: 'console'
    host?: string
    port?: number
    basePath?: string
    /** Serve HTTPS, and WSS with it. Both together, and they move the default port to 8844. */
    cert?: string
    key?: string
}

export interface NodeTask extends CommonTask {
    type: 'node'
    scripts: string
    scriptableBy: string[]
    /**
     * Path to the AI grants document. A path only, never inline: the document carries its own
     * revision so that policy can be replaced on its own cadence, and burying it in a file that
     * changes for unrelated reasons takes that away. It is policy rather than a secret, so the
     * argument that put `sign` and `auth` inline does not apply to it.
     */
    grants?: string
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
    /**
     * Re-read every node task's grants document and apply it, reporting through `warning`.
     *
     * Here as well as on `node` because `run` is how a host is meant to be started, and a grant that
     * can only be closed by restarting the process is one that cannot be closed while something is
     * going wrong. A document that fails to re-read leaves the one in force alone.
     */
    reloadGrants: () => void
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

/**
 * The broker's own credentials, which are not a peer's identity: MQTT authenticates a *connection*,
 * and every task connecting to the same broker with the same account is still a separate peer with
 * a separate signing secret.
 *
 * A block with neither field is refused rather than ignored, because it would silently turn off the
 * environment fallback below it and connect anonymously to a broker somebody meant to authenticate to.
 */
const parseMqttAuth = (value: unknown, where: string): TaskMqttAuth => {
    const object = objectAt(value, where)
    rejectUnknown(object, ['username', 'password'], where)
    const username = optionalString(object, 'username', where)
    const password = optionalString(object, 'password', where)
    if (!username && !password) throw new Error(`${where} needs a username, a password, or both`)
    return { ...(username ? { username } : {}), ...(password ? { password } : {}) }
}

const parseNetwork = (value: unknown, where: string): TaskNetwork => {
    const object = objectAt(value, where)
    rejectUnknown(object, ['broker', 'hub', 'prefix', 'timeout', 'insecureTls', 'mqtt'], where)
    const broker = optionalString(object, 'broker', where)
    const hub = optionalString(object, 'hub', where)
    const prefix = optionalString(object, 'prefix', where)
    const timeout = optionalPositiveNumber(object, 'timeout', where)
    const insecureTls = optionalBoolean(object, 'insecureTls', where)
    const mqtt = object.mqtt === undefined ? undefined : parseMqttAuth(object.mqtt, `${where}.mqtt`)
    return {
        ...(broker ? { broker } : {}),
        ...(hub ? { hub } : {}),
        ...(prefix ? { prefix } : {}),
        ...(timeout ? { timeout } : {}),
        ...(insecureTls !== undefined ? { insecureTls } : {}),
        ...(mqtt ? { mqtt } : {})
    }
}

/**
 * `sign` is a path or the keys themselves, and the shape decides which. One field rather than two
 * because two would need a rule for what happens when both are given, and there is no answer to
 * that which is not a surprise to somebody.
 */
const parseSign = (value: unknown, where: string): string | SigningKeys => {
    if (typeof value === 'string') {
        if (!value) throw new Error(`${where}.sign must be a path or an object with a "secret"`)
        return value
    }
    const object = objectAt(value, `${where}.sign`)
    rejectUnknown(object, ['name', 'secret', 'peers'], `${where}.sign`)
    // signingFrom does the rest of the validation, and does it identically for a key file.
    return signingFrom(object, `${where}.sign`).keys
}

const parseAuth = (value: unknown, where: string): string | TaskAuth => {
    if (typeof value === 'string') {
        if (!value) throw new Error(`${where}.auth must be a path or an object with a "token" or a "derive"`)
        return value
    }
    const object = objectAt(value, `${where}.auth`)
    for (const busField of ['tokens', 'issuers'])
        if (busField in object)
            throw new Error(`${where}.auth."${busField}" belongs to the bus that checks credentials, not to a host role that presents them`)
    rejectUnknown(object, ['token', 'derive'], `${where}.auth`)
    const token = optionalString(object, 'token', `${where}.auth`)
    const derive = optionalString(object, 'derive', `${where}.auth`)
    if (!token && !derive) throw new Error(`${where}.auth needs a "token", a "derive", or both`)
    return { ...(token ? { token } : {}), ...(derive ? { derive } : {}) }
}

const COMMON_FIELDS = ['id', 'type', 'network', 'name', 'sign', 'auth'] as const

const parseTask = (value: unknown, index: number): SourceRpcTask => {
    const where = `tasks[${index}]`
    const object = objectAt(value, where)
    const id = requiredString(object, 'id', where)
    const type = requiredString(object, 'type', where)
    if (type !== 'console' && type !== 'node' && type !== 'serve') throw new Error(`${where}.type must be console, node, or serve`)

    const network = object.network === undefined ? undefined : parseNetwork(object.network, `${where}.network`)
    const name = optionalString(object, 'name', where)
    const sign = object.sign === undefined ? undefined : parseSign(object.sign, where)
    const auth = object.auth === undefined ? undefined : parseAuth(object.auth, where)
    const common = { id, type, ...(network ? { network } : {}), ...(name ? { name } : {}), ...(sign ? { sign } : {}), ...(auth ? { auth } : {}) }

    if (type === 'console') {
        rejectUnknown(object, [...COMMON_FIELDS, 'host', 'port', 'basePath', 'cert', 'key'], where)
        const host = optionalString(object, 'host', where)
        const port = optionalPositiveNumber(object, 'port', where)
        if (port !== undefined && !Number.isInteger(port)) throw new Error(`${where}.port must be an integer`)
        const basePath = optionalString(object, 'basePath', where)
        const cert = optionalString(object, 'cert', where)
        const key = optionalString(object, 'key', where)
        // One without the other opens a port that listens and then fails every handshake, which is
        // a console that looks like it started and answers nobody.
        if (!!cert !== !!key) throw new Error(`${where}.cert and ${where}.key go together; got only ${cert ? 'cert' : 'key'}`)
        return {
            ...common,
            type,
            ...(host ? { host } : {}),
            ...(port ? { port } : {}),
            ...(basePath ? { basePath } : {}),
            ...(cert && key ? { cert, key } : {})
        }
    }

    if (type === 'node') {
        rejectUnknown(object, [...COMMON_FIELDS, 'scripts', 'scriptableBy', 'grants'], where)
        const grants = optionalString(object, 'grants', where)
        return {
            ...common,
            type,
            scripts: requiredString(object, 'scripts', where),
            scriptableBy: stringList(object, 'scriptableBy', where),
            ...(grants ? { grants } : {})
        }
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
    /** Mints a node's scripts their own credentials, when it holds a `derive` secret to mint with. */
    credentialFor?: (script: string) => Promise<{ name: string; token: string }>
    aiGrants?: RpcAiGrants
    tls?: TlsServerOptions
}

/** Where a task's identity came from: a file beside the task file, or the task file itself. */
const signingFor = (task: SourceRpcTask, directory: string, warning: (message: string) => void): { signing: Signing; where: string } | undefined => {
    if (!task.sign) return undefined
    if (typeof task.sign !== 'string') return { signing: signingFrom(task.sign, `task "${task.id}"`), where: 'this task file' }
    const path = resolve(directory, task.sign)
    const loaded = loadSigningKeys(path)
    if (loaded.readableByOthers) warning(`task "${task.id}": ${path} is readable by other users`)
    return { signing: loaded, where: path }
}

/**
 * A task's credentials, from a file or written inline.
 *
 * An auth *file* may carry `tokens` and `issuers` - the same file is what a `broker` reads - so what
 * a host role would do with them is nothing. They are dropped here rather than refused, since one
 * file describing both ends of a bus is a reasonable thing to keep.
 */
const authFor = (task: SourceRpcTask, directory: string, warning: (message: string) => void): TaskAuth => {
    if (!task.auth) return {}
    if (typeof task.auth !== 'string') return task.auth
    const path = resolve(directory, task.auth)
    const loaded = loadAuthFile(path)
    if (loaded.readableByOthers) warning(`task "${task.id}": ${path} is readable by other users`)
    return { ...(loaded.auth.token ? { token: loaded.auth.token } : {}), ...(loaded.auth.derive ? { derive: loaded.auth.derive } : {}) }
}

const prepareTasks = (file: string, config: SourceRpcTaskFile, callbacks: TaskFileCallbacks): PreparedTask[] => {
    const directory = dirname(file)
    const warn = (message: string) => callbacks.warning?.(message)
    const prepared = config.tasks.map((task) => {
        const merged = { ...config.network, ...task.network }
        if (!merged.broker && !merged.hub) throw new Error(`task "${task.id}": network needs broker, hub, or both`)

        const identity = signingFor(task, directory, warn)
        const signing = identity?.signing
        if (signing?.keys.name && task.name && signing.keys.name !== task.name)
            throw new Error(`task "${task.id}": name "${task.name}" does not match "${signing.keys.name}" in ${identity?.where}`)
        const auth = authFor(task, directory, warn)

        const network: NetworkOptions = {
            ...(merged.broker ? { broker: merged.broker } : {}),
            ...(merged.hub ? { hub: merged.hub } : {}),
            ...(merged.prefix ? { prefix: merged.prefix } : {}),
            name: task.name ?? signing?.keys.name ?? task.id,
            callTimeout: merged.timeout ?? 10000,
            ...(merged.insecureTls ? { insecureTls: true } : {}),
            ...(merged.mqtt ? { mqttAuth: merged.mqtt } : {}),
            ...(signing ? { sign: signing.sign, ...(signing.verify ? { verify: signing.verify } : {}) } : {}),
            // Presented to a hub and never to a broker: MQTT authenticates at the broker, with the
            // account under `network.mqtt` or in the environment, and a bearer token has no part in it.
            ...(auth.token ? { hubCredentials: { token: auth.token } } : {})
        }
        if (auth.token && merged.broker && !merged.hub)
            warn(`task "${task.id}": auth.token is presented to a hub, and this task has only a broker, so nothing will read it`)
        // Set up here rather than at startup so a credential nothing will check is reported while
        // the file is being read, along with every other thing wrong with it.
        const credentialFor = task.type === 'node' ? scriptCredentials(auth, network.name, (message) => warn(`task "${task.id}": ${message}`)) : undefined

        // Read now rather than at startup, so a missing certificate is one of the things wrong with
        // the file rather than a rollback halfway through starting it.
        const tls =
            task.type === 'console' && task.cert && task.key ? loadTls(resolve(directory, task.cert), resolve(directory, task.key)) : undefined
        // Read with everything else, so an unreadable security policy is one of the things wrong
        // with the file rather than a node that starts and then disagrees with its operator.
        const aiGrants = task.type === 'node' && task.grants ? loadAiGrants(resolve(directory, task.grants)) : undefined

        if (task.type === 'serve') {
            const contractPath = resolve(directory, task.contract)
            const schema = readJson(contractPath, 'contract')
            if (!looksLikeSchema(schema)) throw new Error(`task "${task.id}": ${contractPath} is not a Source RPC contract`)
            const scriptPath = task.script ? resolve(directory, task.script) : undefined
            const script = scriptPath ? (readJson(scriptPath, 'script') as FakeScript) : undefined
            return { task, network, schema, ...(script ? { script } : {}) }
        }
        return { task, network, ...(credentialFor ? { credentialFor } : {}), ...(tls ? { tls } : {}), ...(aiGrants ? { aiGrants } : {}) }
    })

    const duplicate = prepared.find((entry, index) => prepared.findIndex((candidate) => candidate.network.name === entry.network.name) !== index)
    if (duplicate) throw new Error(`task file starts more than one peer named "${duplicate.network.name}"`)
    return prepared
}

/**
 * A certificate moves the default port the same way `--cert` does, so the convention holds without
 * anyone having to remember it. An explicit port always wins, since a plant with its own numbering
 * has the last word.
 */
export const consolePortFor = (task: ConsoleTask, secure: boolean) => task.port ?? (secure ? defaultSecureWebPort : defaultWebPort)

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

/**
 * Whether the file holds secret material of its own rather than pointing at files that do.
 *
 * The mode warning has to follow the secrets. A task file that only names key files is configuration
 * and can be committed; one with a secret inside it is a key file, and the check that has always
 * guarded those has to guard this too or moving the secrets in would quietly lose it.
 */
const carriesSecrets = (config: SourceRpcTaskFile) =>
    !!config.network?.mqtt?.password ||
    config.tasks.some((task) => typeof task.sign === 'object' || typeof task.auth === 'object' || !!task.network?.mqtt?.password)

/** Start every task in one process, rolling back the earlier ones if a later task cannot start. */
export const startTaskFile = async (path: string, callbacks: TaskFileCallbacks = {}): Promise<TaskFileRun> => {
    const file = resolve(path)
    const config = parseTaskFile(readJson(file, 'task file'))
    if (carriesSecrets(config) && readableByOthers(file)) callbacks.warning?.(`${file} carries secrets and is readable by other users`)
    const prepared = prepareTasks(file, config, callbacks)
    const running: { info: StartedTask; close: () => Promise<void>; reloadGrants?: () => void }[] = []

    for (const entry of prepared) {
        const { task, network } = entry
        try {
            if (task.type === 'console') {
                const console = await startConsole({
                    ...network,
                    host: task.host ?? '127.0.0.1',
                    port: consolePortFor(task, !!entry.tls),
                    ...(entry.tls ? { tls: entry.tls } : {}),
                    ...(task.basePath ? { basePath: task.basePath } : {})
                })
                running.push({ info: { id: task.id, type: task.type, name: network.name, url: console.url }, close: console.close })
                if (task.host && task.host !== '127.0.0.1' && task.host !== 'localhost')
                    callbacks.warning?.(`task "${task.id}": console is bound to ${task.host}; anyone who can reach it can use its granted authority`)
            } else if (task.type === 'node') {
                const node = await startNode({
                    ...network,
                    scripts: resolve(dirname(file), task.scripts),
                    scriptableBy: task.scriptableBy,
                    ...(entry.credentialFor ? { credentialFor: entry.credentialFor } : {}),
                    ...(entry.aiGrants ? { aiGrants: entry.aiGrants } : {})
                })
                running.push({
                    info: { id: task.id, type: task.type, name: network.name },
                    close: node.close,
                    ...(task.grants
                        ? {
                              reloadGrants: () => {
                                  const path = resolve(dirname(file), task.grants!)
                                  let next
                                  try {
                                      next = loadAiGrants(path)
                                  } catch (e) {
                                      callbacks.warning?.(`task "${task.id}": grants unchanged, ${e instanceof Error ? e.message : String(e)}`)
                                      return
                                  }
                                  node.setAiGrants(next)
                                  for (const line of grantLines(next)) callbacks.warning?.(`task "${task.id}": ${line}`)
                              }
                          }
                        : {})
                })
                // Said whether or not a document was given: this node's scripts carry `ai-program`,
                // so what is open is part of what an operator has just started.
                for (const line of grantLines(entry.aiGrants)) callbacks.warning?.(`task "${task.id}": ${line}`)
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
        },
        reloadGrants: () => {
            for (const task of running) task.reloadGrants?.()
        }
    }
}

/** 32 bytes from the system generator, which is what every secret in a generated file is. */
const freshSecret = () => randomBytes(32).toString('base64url')

/**
 * A task file with the three roles in it, ready to edit.
 *
 * The secrets are real rather than placeholders, and that is the point of generating one at all: the
 * shape of a task file is easy to type out from the documentation, and a secret somebody invents at
 * a keyboard is the part that is reliably done badly. Every role gets its own, and each one's
 * `peers` names the others, so the file that lands is a network whose members already know each
 * other rather than a template with `<secret>` in five places.
 *
 * `controller` is in every `peers` map without being a task here, because the reason to run a
 * scriptable node is that something elsewhere scripts it. Its secret is in this file for whoever
 * sets that machine up to copy out - printing it would put it in a scrollback and a terminal log.
 */
export const taskFileSkeleton = (options: { broker?: string; hub?: string; controller?: string } = {}) => {
    const controller = options.controller ?? 'controller'
    const roles = ['host-console', 'host-node', 'host-simulator'] as const
    const secrets = Object.fromEntries([...roles, controller].map((name) => [name, freshSecret()]))
    // Everyone else on this network, which is every other role here plus the peer that scripts the
    // node. A name in one of these maps and in nobody's `name` is a signature that will never verify,
    // so they are built from the role list rather than written out three times.
    const peers = (self: string) => Object.fromEntries([...roles.filter((role) => role !== self), controller].map((name) => [name, secrets[name]]))

    return {
        version: 1 as const,
        network: {
            ...(options.hub ? { hub: options.hub } : { broker: options.broker ?? 'mqtt://127.0.0.1:1883' }),
            timeout: 10000
        },
        tasks: [
            {
                id: 'console',
                type: 'console' as const,
                sign: { name: 'host-console', secret: secrets['host-console'], peers: peers('host-console') },
                host: '127.0.0.1',
                port: defaultWebPort
            },
            {
                id: 'node',
                type: 'node' as const,
                sign: { name: 'host-node', secret: secrets['host-node'], peers: peers('host-node') },
                scripts: 'scripts',
                scriptableBy: [controller]
            },
            {
                id: 'simulator',
                type: 'serve' as const,
                sign: { name: 'host-simulator', secret: secrets['host-simulator'], peers: peers('host-simulator') },
                contract: 'contracts/host.types.json'
            }
        ]
    }
}

/** What the generated file still needs from whoever generated it, in the order they have to do it. */
export const taskFileSkeletonNotes = (file: string, controller = 'controller') => [
    `${file} has three roles with fresh signing secrets, and is readable only by you`,
    'set network.broker or network.hub to the bus these roles should join',
    `create the scripts directory, and point the simulator's contract at a real one - or delete the tasks you do not want`,
    `"${controller}" is the peer allowed to script the node: give it the secret this file lists for it under peers`,
    'a bus that authenticates also needs auth.token per task, and network.mqtt for an MQTT account'
]
