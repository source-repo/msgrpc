import { useState } from 'react'
import { ArgumentField, FieldState, initialText, toValue } from './ArgumentField'
import { ConsoleService, DescribedMethod, ServerDescription, isOptional, requiredPart, typeText } from './types'

/** How many times the repeat button calls. Enough for a p50 to mean something, few enough to wait for. */
const REPEAT = 20

/** The command line that would make the same call, so a call worth making here can leave the browser. */
const asCommand = (peer: string, namespace: string, method: string, args: unknown[], network: { broker?: string; hub?: string; prefix?: string }) => {
    const where = [
        ...(network.broker ? ['--broker', network.broker] : []),
        ...(network.hub ? ['--hub', network.hub] : []),
        ...(network.prefix ? ['--prefix', network.prefix] : [])
    ]
    // Quoted only where a shell would otherwise take it apart, so the common case stays readable.
    const word = (value: unknown) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return /^[A-Za-z0-9._@/:+-]+$/.test(text ?? '') ? text : `'${String(text).replace(/'/g, "'\\''")}'`
    }
    return ['msgrpc', 'call', peer, `${namespace}.${method}`, ...args.map(word), ...where].join(' ')
}

const median = (values: number[]) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

/**
 * One method, folded shut until someone wants to try it. Open, it is a form with a field per
 * argument and the result underneath.
 */
export const MethodPanel = ({
    peer,
    namespace,
    method,
    types,
    service,
    network
}: {
    peer: string
    namespace: string
    method: DescribedMethod
    types: ServerDescription['types']
    service: ConsoleService
    network: { broker?: string; hub?: string; prefix?: string }
}) => {
    const params = method.params ?? []
    const names = method.paramNames ?? params.map((_, index) => `argument ${index}`)
    const [open, setOpen] = useState(false)
    const [fields, setFields] = useState<FieldState[]>(() =>
        params.map((type) => ({ text: initialText(type, types), include: !isOptional(type) }))
    )
    const [busy, setBusy] = useState(false)
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
    // Kept rather than shown once and forgotten: one call's timing says almost nothing, and the
    // question worth asking of a device is what it does the twentieth time.
    const [times, setTimes] = useState<number[]>([])
    const [copied, setCopied] = useState(false)

    // Written the way the source declares it - `mode?: 'auto' | 'manual'` rather than the `| null`
    // the schema encodes optionality as, which reads like a value the method accepts.
    const signature = `${method.name}(${
        method.params ? params.map((type, i) => `${names[i]}${isOptional(type) ? '?' : ''}: ${typeText(requiredPart(type))}`).join(', ') : '…'
    })${method.returns ? `: ${typeText(method.returns)}` : ''}`

    /** The arguments as the form has them, or a message saying why they cannot be built. */
    const argumentsNow = () => {
        // Trailing arguments left out are simply not sent, which is what optional means.
        const args = params.map((type, index) => (fields[index].include ? toValue(fields[index].text, type, types) : undefined))
        while (args.length && args[args.length - 1] === undefined && isOptional(params[args.length - 1])) args.pop()
        return args
    }

    const invoke = async (repeat = 1) => {
        let args: unknown[]
        try {
            args = argumentsNow()
        } catch (e) {
            setOutcome({ ok: false, text: (e as Error).message })
            return
        }
        setBusy(true)
        setOutcome(null)
        const collected: number[] = []
        let last: { ok: boolean; text: string } | null = null
        try {
            for (let attempt = 0; attempt < repeat; attempt++) {
                const answer = await service.call(peer, namespace, method.name, args)
                collected.push(answer.ms)
                last = answer.error
                    ? { ok: false, text: `${answer.code ? answer.code + ': ' : ''}${answer.error}` }
                    : { ok: true, text: `${JSON.stringify(answer.result, null, 2) ?? 'undefined'}\n\n// ${answer.ms} ms` }
                // One that fails says so and stops: twenty identical failures are one finding.
                if (answer.error) break
            }
            setOutcome(last)
        } catch (e) {
            setOutcome({ ok: false, text: (e as Error).message })
        } finally {
            setTimes((current) => [...current, ...collected].slice(-200))
            setBusy(false)
        }
    }

    const copyCommand = () => {
        let args: unknown[]
        try {
            args = argumentsNow()
        } catch {
            args = []
        }
        void navigator.clipboard?.writeText(asCommand(peer, namespace, method.name, args, network)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <div className={`method${open ? ' open' : ''}`}>
            <button className="method-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span className="chevron">{open ? '▾' : '▸'}</span>
                <code>{signature}</code>
            </button>
            {open && (
                <div className="method-body">
                    {params.length === 0 && <p className="muted">No arguments.</p>}
                    {params.map((type, index) => (
                        <ArgumentField
                            key={index}
                            name={names[index]}
                            type={type}
                            types={types}
                            state={fields[index]}
                            onChange={(next) => setFields(fields.map((field, i) => (i === index ? next : field)))}
                        />
                    ))}
                    {method.rest && <p className="muted">Takes further {typeText(method.rest)} arguments, which this form does not send.</p>}
                    {!method.params && <p className="muted">No schema describes this method, so its arguments cannot be shown as fields.</p>}
                    <div className="actions">
                        <button className="primary" onClick={() => void invoke()} disabled={busy}>
                            {busy ? 'calling…' : 'Call'}
                        </button>
                        <button className="toggle" onClick={() => void invoke(REPEAT)} disabled={busy} title="call it repeatedly and keep the timings">
                            ×{REPEAT}
                        </button>
                        <button className="toggle" onClick={copyCommand} title="the command line that makes the same call">
                            {copied ? 'copied' : 'copy as CLI'}
                        </button>
                        {times.length > 0 && (
                            <span className="muted timing">
                                {times.length} call{times.length === 1 ? '' : 's'} · p50 {median(times)} ms · last {times[times.length - 1]} ms
                            </span>
                        )}
                    </div>
                    {outcome && <pre className={outcome.ok ? 'result' : 'result bad'}>{outcome.text}</pre>}
                </div>
            )}
        </div>
    )
}
