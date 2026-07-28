import { useEffect, useRef, useState } from 'react'

/**
 * Chat is here to be a service the page *hosts*, not a feature the console offers.
 *
 * Everything else in this app calls outwards: the page is a client of the console, which is the
 * ordinary direction. A page exposing a namespace that another peer calls is the opposite one, and
 * it is the part of the design least likely to be exercised by accident - a browser cannot listen,
 * so it can only be reached by dialling out and being relayed to. Two consoles on one bus, a page
 * on each, and a message crossing between them tests dial-out serving, presence propagation and
 * relaying in a way no amount of calling the console can.
 */

export interface ChatMessage {
    from: string
    text: string
    at: number
    mine: boolean
}

/** What a page exposes to its peers. The other side calls `say`; nothing here is console-specific. */
export class ChatService {
    constructor(private readonly onMessage: (from: string, text: string) => void) {}

    async say(from: string, text: string) {
        this.onMessage(String(from), String(text))
        return 'delivered'
    }

    /** So a peer can show who it is talking to before saying anything. */
    async who() {
        return { app: 'msgrpc console', kind: 'browser page' }
    }
}

export const Chat = ({
    me,
    peer,
    messages,
    onSend
}: {
    me: string
    peer: string | null
    messages: ChatMessage[]
    onSend: (text: string) => Promise<string | undefined>
}) => {
    const [text, setText] = useState('')
    const [failure, setFailure] = useState<string | null>(null)
    const [sending, setSending] = useState(false)
    const end = useRef<HTMLDivElement>(null)

    useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages.length])

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
                <span className="muted mono">{me}</span>
            </header>
            {!peer && <p className="muted">Select a peer to talk to it. Any peer running this console can answer.</p>}
            {peer && (
                <>
                    <div className="chat-log">
                        {messages.length === 0 && <p className="muted">Nothing yet. Say something to {peer}.</p>}
                        {messages.map((message, index) => (
                            <div key={`${message.at}-${index}`} className={message.mine ? 'said mine' : 'said'}>
                                <span className="who">{message.mine ? 'you' : message.from}</span>
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
