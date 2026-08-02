import { rpc, rpcNamespace, type RpcAuthorizer, type RpcCallContext } from '@source-repo/rpc'
import { addPackage, listPackages, removePackage } from './packages.js'
import { deleteScript, listScripts, readScript, saveScript, ScriptRunner, type ScriptLanguage } from './scripts.js'

/**
 * Managing a node's scripts from another node, so a test hall is one place rather than a row of
 * remote desktops.
 *
 * `--scripts` already lets a model write and run programs on the machine it is talking to. What it
 * cannot do is reach the next machine along, and on a bench with a Linux box, a Windows PLC and a
 * couple of devices, that is where the time goes: a remote desktop each, a file copied by hand, and
 * the mistake you make on the fourth one.
 *
 * This is the same capability offered as an ordinary RPC namespace, which is the third time this
 * codebase has reached for that shape - `bus.tap()` turned a restart-with-a-flag into a call, and
 * `ConsoleService` let a browser and a model consume one surface. What it buys here is that
 * everything already built for calling a peer works on it: argument checking from the contract,
 * `describe()` so "which nodes can I script?" is answerable with `source-rpc peers`, the verbs
 * (`source-rpc call node7 scripting.start deploy`), and the command semantics below.
 *
 * ## What this is
 *
 * **Remote code execution, offered as a method.** Not a reason to refuse to build it - it is what a
 * test hall wants - but the trust model inverts and it is worth being exact about how.
 *
 * `--scripts` on its own is bounded by having a shell on the box: the model reaches it over stdio,
 * as the user who started the server. Exposing this namespace replaces that boundary with "can
 * reach the bus", and a broker relays for anyone that can open a socket to it unless told not to.
 *
 * So the rule is one line, and it is the strictest one that still works:
 *
 * **A call arriving over RPC is refused unless the caller is authenticated *and* named.**
 *
 * Local use does not go through this. The server that owns a node holds the object and calls its
 * methods directly, which is what "local" means here - not a peer name to be compared, but no RPC
 * at all. Anything that did arrive over the wire is by definition somebody else.
 *
 * ## Why authenticated *and* named
 *
 * A peer name off the wire is a claim. On socket.io a token pins the connection to one name and the
 * transport drops frames claiming another, so an identity means something. **On MQTT there is no
 * connection to authenticate**: `getIdentity` returns undefined unless frames are signed, so a
 * network without `sign`/`verify` cannot tell anyone apart and this namespace refuses everybody.
 * That is the correct failure, and it is worth knowing before wondering why the key is not working.
 *
 * ## Through a bus, sign
 *
 * The part that surprises, found by building it. **Identity is per connection, and does not survive
 * a relay.** A bench authenticates to the broker; the node being scripted is connected to the broker
 * too, so it has no connection to the bench and no way to learn who it is - and refuses, correctly,
 * because the alternative is trusting a name that arrived through a third party.
 *
 * That rules out the arrangement most people would reach for first: a hall of nodes dialling one bus
 * over socket.io, each expecting `--scriptable-by` to work through it. It does not, and no flag
 * makes it, because the information genuinely is not there.
 *
 * What does work is signing, and it works because a signature is on the frame rather than on the
 * link: whoever reads it can check it, whatever the broker did in between. So a relayed test hall is
 * MQTT with `--sign` at both ends, each key file naming the other peer. There is a test for exactly
 * that arrangement and one for the direct connection, and they are the two shapes worth copying.
 */

export interface ScriptingOptions {
    /** Where scripts are written and run. The same directory `--scripts` names. */
    directory: string
    /** Handed to each script it starts, so a script reads its broker url rather than carrying one. */
    environment?: { [key: string]: string }
    /**
     * Mints the credential a script connects with. Absent means scripts start unauthenticated,
     * which is right on an open bench and is why it is not required: what must never happen again
     * is a script inheriting the node's own credential, and that is now impossible rather than
     * discouraged.
     */
    credentialFor?: (script: string) => Promise<{ name: string; token: string } | undefined>
    /**
     * Peer names permitted to script this node from elsewhere. Empty - the default - means nobody:
     * the namespace can be exposed for a local server's own use without opening it to the bus.
     *
     * A name here is only as good as the transport's ability to prove it, which is why the guard
     * insists on an identity as well. See `scriptingAuthorizer`.
     */
    allow?: string[]
}

/**
 * An authorizer that refuses `scripting` to anyone this node has not named, and leaves every other
 * namespace to whatever policy was already in place.
 *
 * Shipped with the service rather than left to the reader, because the failure mode of forgetting it
 * is an open remote shell on the bus. Compose it with your own by passing that as `inner`.
 */
export const scriptingAuthorizer = (options: ScriptingOptions, inner?: RpcAuthorizer): RpcAuthorizer => {
    const allowed = new Set(options.allow ?? [])
    return async (context: RpcCallContext) => {
        if (context.instanceName !== SCRIPTING_NAMESPACE) return inner ? await inner(context) : true
        // No identity, no scripting. `source` is a claim until a transport has checked it, and on
        // MQTT nothing checks it unless frames are signed - so an unsigned network refuses everyone,
        // which is the answer that cannot be wrong.
        if (!context.identity) return false
        return allowed.has(context.identity.name)
    }
}

/**
 * The namespace name, for the guard to compare against. Written out again in the decorator below
 * rather than referenced, because the extraction CLI reads the source rather than running it and
 * only understands a string literal there - a constant produces a contract with no namespaces in
 * it, and the only sign is the count in the line it prints.
 */
export const SCRIPTING_NAMESPACE = 'scripting'

/**
 * The scripts on one node, as methods.
 *
 * Every method here is what the MCP tools of the same name already do; the difference is that this
 * one can be called from the next machine along. Semantics are declared because they are true and
 * because a caller deciding whether to retry after a lost answer needs them: installing a package
 * twice is not the same as listing them twice.
 */
@rpcNamespace('scripting', { version: '1', execution: 'serial' })
export class ScriptingService {
    private runner: ScriptRunner

    constructor(private options: ScriptingOptions) {
        this.runner = new ScriptRunner(options.directory, options.environment ?? {}, options.credentialFor)
    }

    /** The scripts here, and which of them this node is running. */
    @rpc({ semantics: 'query' })
    async list() {
        return listScripts(this.options.directory).map((script) => ({
            ...script,
            running: this.runner.isRunning(script.name),
            ...(this.runner.status(script.name)?.ended ? { ended: this.runner.status(script.name)!.ended } : {})
        }))
    }

    /** Write one. Saving does not start it, the same as saving a file does not run it. */
    @rpc({ semantics: 'idempotent-command' })
    async save(name: string, source: string, language?: string) {
        return saveScript(this.options.directory, name, source, language === 'mjs' ? 'mjs' : ('ts' as ScriptLanguage))
    }

    @rpc({ semantics: 'query' })
    async read(name: string) {
        return readScript(this.options.directory, name)
    }

    /** Stopped first if it is running, so a delete does not leave a process behind holding the name. */
    @rpc({ semantics: 'idempotent-command' })
    async remove(name: string) {
        if (this.runner.isRunning(name)) await this.runner.stop(name)
        deleteScript(this.options.directory, name)
        return name
    }

    /**
     * Run it, as a process of its own. Idempotent rather than non-repeatable because a second start
     * is refused rather than obeyed - two of one script under one name is the thing to avoid.
     */
    @rpc({ semantics: 'idempotent-command' })
    async start(name: string) {
        const started = await this.runner.start(name)
        return { name: started.name, pid: started.pid ?? null, startedAt: started.startedAt }
    }

    @rpc({ semantics: 'idempotent-command' })
    async stop(name: string) {
        const record = await this.runner.stop(name)
        return { name: record.name, ended: record.ended ?? null }
    }

    /** What it printed, with stderr lines marked. A script has no other channel back. */
    @rpc({ semantics: 'query' })
    async output(name: string) {
        const record = this.runner.status(name)
        if (!record) throw Object.assign(new Error(`'${name}' has not been started here`), { code: 'MethodNotFound' })
        return { name, output: record.output, ended: record.ended ?? null, running: this.runner.isRunning(name) }
    }

    @rpc({ semantics: 'query' })
    async packages() {
        return listPackages(this.options.directory)
    }

    /**
     * Install one. Non-repeatable: it writes to node_modules and, if asked, runs the package's own
     * install hooks - which is unreviewed code from the registry either way round.
     */
    @rpc({ semantics: 'non-repeatable-command' })
    async addPackage(spec: string, allowInstallScripts?: boolean) {
        return await addPackage(this.options.directory, spec, allowInstallScripts === true)
    }

    @rpc({ semantics: 'non-repeatable-command' })
    async removePackage(name: string) {
        return await removePackage(this.options.directory, name)
    }

    /** Everything this node started goes with it, rather than being orphaned holding peer names. */
    async close() {
        await this.runner.stopAll()
    }
}
