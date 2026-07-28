import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from './ChatService'

/** The view over what ChatService receives, which is where the service itself is explained. */

export const Chat = ({
    peer,
    messages,
    onSend
}: {
    peer: string | null
    messages: ChatMessage[]
    onSend: (text: string) => Promise<string | undefined>
}) => {
    const [text, setText] = useState('')
    const [failure, setFailure] = useState<string | null>(null)
    const [sending, setSending] = useState(false)
    const end = useRef<HTMLDivElement>(null)

    // Block body on purpose. React 19 calls whatever an effect returns as its cleanup, and an
    // arrow with an expression body returns the expression - which is how this crashed the page
    // with "_ is not a function" the moment the log grew.
    useEffect(() => {
        end.current?.scrollIntoView({ block: 'end' })
    }, [messages.length])

    const send = async () => {
        if (!text.trim() || !peer) return
        setSending(true)
        setFailure((await onSend(text.trim()).finally(() => setSending(false))) ?? null)
        setText('')
    }

    return (
        <div className="chat">
            <header>
                <h1>Chat</h1>
                {/* Who you are talking to. Which peer you are is in the sidebar, always visible. */}
                <span className="muted mono">{peer ?? '—'}</span>
            </header>
            {!peer && <p className="muted">Select a peer to talk to it. Any peer running this console can answer.</p>}
            {peer && (
                <>
                    <div className="chat-log">
                        {messages.length === 0 && <p className="muted">Nothing yet. Say something to {peer}.</p>}
                        {/* No name on a line: the side it sits on already says who said it, and the
                            header names the only other party there is. */}
                        {messages.map((message, index) => (
                            <div key={`${message.at}-${index}`} className={message.mine ? 'said mine' : 'said'}>
                                <span className="text">{message.text}</span>
                            </div>
                        ))}
                        <div ref={end} />
                    </div>
                    <div className="chat-send">
                        <input
                            className="control"
                            value={text}
                            placeholder={`say something to ${peer}`}
                            onChange={(event) => setText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') void send()
                            }}
                        />
                        <button className="primary" disabled={sending || !text.trim()} onClick={() => void send()}>
                            {sending ? '…' : 'Send'}
                        </button>
                    </div>
                    {failure && <p className="muted bad">{failure}</p>}
                </>
            )}
        </div>
    )
}
