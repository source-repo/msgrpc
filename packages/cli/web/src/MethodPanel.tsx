import { useState } from 'react'
import { ArgumentField, FieldState, initialText, toValue } from './ArgumentField'
import { ConsoleService, DescribedMethod, ServerDescription, isOptional, requiredPart, typeText } from './types'

/**
 * One method, folded shut until someone wants to try it. Open, it is a form with a field per
 * argument and the result underneath.
 */
export const MethodPanel = ({
    peer,
    namespace,
    method,
    types,
    service
}: {
    peer: string
    namespace: string
    method: DescribedMethod
    types: ServerDescription['types']
    service: ConsoleService
}) => {
    const params = method.params ?? []
    const names = method.paramNames ?? params.map((_, index) => `argument ${index}`)
    const [open, setOpen] = useState(false)
    const [fields, setFields] = useState<FieldState[]>(() =>
        params.map((type) => ({ text: initialText(type, types), include: !isOptional(type) }))
    )
    const [busy, setBusy] = useState(false)
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

    // Written the way the source declares it - `mode?: 'auto' | 'manual'` rather than the `| null`
    // the schema encodes optionality as, which reads like a value the method accepts.
    const signature = `${method.name}(${
        method.params ? params.map((type, i) => `${names[i]}${isOptional(type) ? '?' : ''}: ${typeText(requiredPart(type))}`).join(', ') : '…'
    })${method.returns ? `: ${typeText(method.returns)}` : ''}`

    const invoke = async () => {
        let args: unknown[]
        try {
            // Trailing arguments left out are simply not sent, which is what optional means.
            args = params.map((type, index) => (fields[index].include ? toValue(fields[index].text, type, types) : undefined))
            while (args.length && args[args.length - 1] === undefined && isOptional(params[args.length - 1])) args.pop()
        } catch (e) {
            setOutcome({ ok: false, text: (e as Error).message })
            return
        }
        setBusy(true)
        setOutcome(null)
        try {
            const answer = await service.call(peer, namespace, method.name, args)
            setOutcome(
                answer.error
                    ? { ok: false, text: `${answer.code ? answer.code + ': ' : ''}${answer.error}` }
                    : { ok: true, text: `${JSON.stringify(answer.result, null, 2) ?? 'undefined'}\n\n// ${answer.ms} ms` }
            )
        } catch (e) {
            setOutcome({ ok: false, text: (e as Error).message })
        } finally {
            setBusy(false)
        }
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
                    </div>
                    {outcome && <pre className={outcome.ok ? 'result' : 'result bad'}>{outcome.text}</pre>}
                </div>
            )}
        </div>
    )
}
