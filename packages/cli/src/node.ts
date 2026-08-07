import type { RpcAiGrants } from '@source-repo/rpc'
import { connectNetwork, type NetworkOptions } from './network.js'
import { environmentFor } from './scripts.js'
import { ScriptingService, scriptingAuthorizer } from './scripting.js'

/**
 * A machine that can be scripted from elsewhere, and does nothing else.
 *
 * `mcp --scripts --scriptable-by` already offers this, and on the machine a model is attached to
 * that is the right shape. On the other machines it is not: a PLC in the corner of a test hall has
 * no model attached and no use for a stdio protocol, and running one there means a server whose
 * whole reason for existing sits unused while the part that matters runs beside it.
 *
 * So this is the same capability with nothing else in it. It joins the network, offers the
 * `scripting` namespace to the peers it names, and waits.
 *
 *   source-rpc node --scripts ./scripts --scriptable-by bench --broker mqtt://bus:1883 --sign node.json
 *
 * **Both flags are required, and that is deliberate.** A node with no directory has nothing to
 * offer, and a node that names nobody offers it to nobody - either one joins the bus, occupies a
 * peer name and does nothing whatsoever, which is a configuration that looks like it is working.
 * `mcp` can sensibly be given one without the other, because it has other work to do; this cannot.
 */

export interface NodeOptions extends NetworkOptions {
    /** Where scripts are kept and run. */
    scripts: string
    /** Mints each script's own credential; see ScriptingOptions. Absent means scripts run unauthenticated. */
    credentialFor?: (script: string) => Promise<{ name: string; token: string } | undefined>
    /** Peers permitted to script this machine. At least one, or there is no reason to be running. */
    scriptableBy: string[]
}

export const startNode = async (options: NodeOptions) => {
    if (!options.scriptableBy.length) throw new Error('startNode: name at least one peer with --scriptable-by, or this offers nothing to anybody')

    const scripting = new ScriptingService({
        directory: options.scripts,
        // Handed to each script it starts, so a script reads its broker url from the environment
        // rather than carrying one that is right on this machine and wrong on the next.
        environment: environmentFor(options),
        allow: options.scriptableBy,
        ...(options.credentialFor ? { credentialFor: options.credentialFor } : {})
    })

    const connected = await connectNetwork({
        ...options,
        authorize: scriptingAuthorizer({ directory: options.scripts, allow: options.scriptableBy }),
        exposeIntrospection: true,
        // Before ready(), because a resumed MQTT session is handed its queue the moment it connects
        // and a request that arrives before the namespace exists is answered ClassNotFound by a peer
        // that serves it perfectly well a second later.
        expose: (network) => network.exposeClassInstance(scripting)
    })

    return {
        name: options.name,
        scripting,
        /**
         * Replace the grants document on a running node.
         *
         * The handler reads `aiGrants` at every decision rather than compiling it once, so swapping
         * it takes effect on the next call and needs no restart. That is what the document's
         * `revision` is for, and it is the difference between closing a grant in a hurry and
         * restarting a node that is in the middle of something.
         */
        setAiGrants: (grants: RpcAiGrants | undefined) => {
            connected.network.rpc.aiGrants = grants
        },
        close: async () => {
            // The scripts go with the node. A process left holding a peer name after the thing that
            // started it has gone is the sort of debris that is only noticed much later.
            await scripting.close()
            await connected.close()
        }
    }
}
