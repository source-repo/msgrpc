import { createContext, runInContext } from 'node:vm'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Behaviour for a fake that the contract cannot describe: state.
 *
 * `returns` answers the same value every time and `emits` fires on a timer, which covers a screen
 * that needs something to draw. What neither covers is a device that *reacts* - a pump that ramps
 * toward the setpoint it was last given, a batch that will not start twice, a valve that reports
 * closed until something opens it. Those are the behaviours an HMI is actually wrong about, and
 * they need a variable and a method that can read what it was called with.
 *
 * So a script may supply the method bodies, in JavaScript or in Python. Both are **off unless
 * `--allow-exec` says otherwise**, and the reason is worth stating rather than leaving implied:
 *
 * **This runs code the script author supplied, and the flag is the security boundary - not the
 * runtime.** The JavaScript context has no `require`, no `process`, no filesystem and a per-call
 * time budget, which stops a careless handler wedging the process; `node:vm` is documented as not
 * being a security mechanism, and a determined script can get out of it. Python is a subprocess with
 * the privileges of whoever started it and no confinement at all. Both are the right tool for a
 * simulator on a development machine and the wrong thing to reach from a plant network, which is why
 * the container ships without the flag.
 */

/** How long one handler may run before the call is failed rather than waited out. */
const CALL_BUDGET_MS = 200

/** How long Python gets to answer, allowing for an interpreter doing real work on the first call. */
const PYTHON_BUDGET_MS = 5000

export interface HandlerRuntime {
    /** Whether this runtime answers for a `namespace.method`. */
    handles: (target: string) => boolean
    /** Run it. Throwing an error carrying `code` selects the RPC error the caller sees. */
    call: (target: string, params: unknown[]) => Promise<unknown>
    close: () => Promise<void>
}

/** Thrown for a handler that failed on its own terms, so the caller gets Exception and the reason. */
const handlerFailed = (target: string, reason: unknown) =>
    Object.assign(new Error(`${target}: ${reason instanceof Error ? reason.message : String(reason)}`), { code: 'Exception' })

/**
 * JavaScript method bodies over shared state.
 *
 * The functions are defined once, so a handler can close over whatever it likes, and *called* by a
 * script with a timeout - the budget has to be on the call rather than on the definition, since a
 * loop that never ends is written in the body and not at the top level.
 */
export const javascriptRuntime = (handlers: { [target: string]: string }, state: { [key: string]: unknown }): HandlerRuntime => {
    // Deliberately spare. Everything a simulator needs to compute a reading, and nothing that
    // reaches the machine it is running on.
    const context = createContext({
        state,
        Math,
        JSON,
        Date,
        Number,
        String,
        Boolean,
        Array,
        Object,
        isNaN,
        parseFloat,
        parseInt,
        __handlers: {} as { [target: string]: unknown },
        __target: '',
        __params: [] as unknown[]
    })

    for (const [target, source] of Object.entries(handlers)) {
        try {
            // Wrapped in parentheses so `(v) => …` and `function (v) { … }` both read as expressions.
            runInContext(`__handlers[${JSON.stringify(target)}] = (${source})`, context, { timeout: CALL_BUDGET_MS })
        } catch (e) {
            // At construction, so a typo is a startup failure rather than a call that fails later on
            // a screen somebody is watching.
            throw new Error(`handler for ${target} did not compile: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
        }
        if (typeof (context.__handlers as { [k: string]: unknown })[target] !== 'function')
            throw new Error(`handler for ${target} is not a function - give it \`(a, b) => …\` or \`function (a, b) { … }\``)
    }

    return {
        handles: (target) => target in handlers,
        call: async (target, params) => {
            context.__target = target
            context.__params = params
            try {
                // Awaited outside the context: a handler may be async, and the timeout only bounds
                // the synchronous run. A promise that never settles is caught by the call timeout
                // the caller already carries.
                return await runInContext('__handlers[__target](...__params)', context, { timeout: CALL_BUDGET_MS })
            } catch (e) {
                throw handlerFailed(target, e)
            }
        },
        close: async () => undefined
    }
}

/**
 * A Python program that answers calls, spoken to over stdio as newline-delimited JSON.
 *
 * One interpreter per fake, started once and kept, so state is whatever the program keeps in its own
 * variables - which is the point, and the thing a JSON script cannot express. The protocol is
 * deliberately tiny; the shim below is the whole of what the program has to satisfy.
 */
export const PYTHON_SHIM = `
import sys, json
_handlers = {}

def rpc(target):
    """Decorate a function to answer 'namespace.method'."""
    def register(fn):
        _handlers[target] = fn
        return fn
    return register

def _serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            call = json.loads(line)
        except Exception as e:
            print(json.dumps({"id": None, "error": "bad request: %s" % e}), flush=True)
            continue
        fn = _handlers.get(call.get("target"))
        if fn is None:
            print(json.dumps({"id": call.get("id"), "error": "no handler for %s" % call.get("target")}), flush=True)
            continue
        try:
            print(json.dumps({"id": call.get("id"), "result": fn(*call.get("params", []))}), flush=True)
        except Exception as e:
            print(json.dumps({"id": call.get("id"), "error": str(e)}), flush=True)
`

export const pythonRuntime = async (program: string, targets: string[], interpreter = 'python3'): Promise<HandlerRuntime> => {
    let child: ChildProcessWithoutNullStreams
    try {
        // `-u` because a buffered interpreter answers the first call when the second arrives.
        child = spawn(interpreter, ['-u', '-c', `${PYTHON_SHIM}\n${program}\n_serve()\n`], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
        throw new Error(`could not start ${interpreter}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }

    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
    let nextId = 1
    let died: Error | undefined

    createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return
        let message: { id?: number; result?: unknown; error?: string }
        try {
            message = JSON.parse(line) as typeof message
        } catch {
            // A print() in the program rather than a reply. Passed through, since a simulator author
            // debugging with print deserves to see it somewhere.
            process.stderr.write(`source-rpc fake (python): ${line}\n`)
            return
        }
        const waiting = message.id !== undefined ? pending.get(message.id) : undefined
        if (!waiting) return
        pending.delete(message.id!)
        if (message.error !== undefined) waiting.reject(new Error(message.error))
        else waiting.resolve(message.result)
    })

    const stderr: string[] = []
    child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderr.push(text)
        process.stderr.write(`source-rpc fake (python): ${text}`)
    })

    child.on('exit', (code) => {
        // Everything still waiting is failed now rather than left to time out one by one, and the
        // reason names the interpreter's own complaint - a traceback is the useful part.
        died = new Error(`the python program exited (${code})${stderr.length ? `: ${stderr.join('').trim().split('\n').pop()}` : ''}`)
        for (const [, waiting] of pending) waiting.reject(died)
        pending.clear()
    })
    child.on('error', (e) => {
        died = new Error(`could not run ${interpreter}: ${e.message}. Is it installed and on PATH?`)
        for (const [, waiting] of pending) waiting.reject(died)
        pending.clear()
    })

    return {
        handles: (target) => targets.includes(target),
        call: async (target, params) => {
            if (died) throw handlerFailed(target, died)
            const id = nextId++
            const answer = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
            child.stdin.write(`${JSON.stringify({ id, target, params })}\n`)
            const budget = new Promise<never>((_, reject) =>
                setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`did not answer within ${PYTHON_BUDGET_MS} ms`))
                }, PYTHON_BUDGET_MS).unref()
            )
            try {
                return await Promise.race([answer, budget])
            } catch (e) {
                throw handlerFailed(target, e)
            }
        },
        close: async () => {
            child.stdin.end()
            child.kill()
        }
    }
}
