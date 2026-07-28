/**
 * The console page, inlined so the CLI stays a single dependency-free artefact with no build step
 * of its own.
 */
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>msgrpc console</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --dim: #8889; }
  * { box-sizing: border-box }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; display: grid;
         grid-template-columns: 15rem 1fr 22rem; height: 100vh }
  aside, main, section { overflow: auto; padding: 1rem }
  aside, section { border-color: var(--line); border-style: solid; border-width: 0 }
  aside { border-right-width: 1px } section { border-left-width: 1px }
  h1 { font-size: 1rem; margin: 0 0 .75rem; letter-spacing: .04em; text-transform: uppercase; color: var(--dim) }
  .peer { padding: .3rem .5rem; border-radius: .3rem; cursor: pointer; display: flex; gap: .5rem; align-items: center }
  .peer:hover { background: #8881 }
  .peer[aria-selected=true] { background: #8882; font-weight: 600 }
  button[aria-pressed=true] { background: #8882; font-weight: 600 }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: #2a2 }
  .dot.off { background: #a22 }
  details { border: 1px solid var(--line); border-radius: .4rem; margin-bottom: .5rem }
  summary { padding: .5rem .75rem; cursor: pointer; font-weight: 600 }
  .body { padding: 0 .75rem .75rem }
  .sig { font-family: ui-monospace, monospace; font-size: .85em; color: var(--dim) }
  .row { display: flex; gap: .5rem; align-items: center; margin: .35rem 0; flex-wrap: wrap }
  input, button, textarea { font: inherit; padding: .3rem .5rem; border-radius: .3rem;
                            border: 1px solid var(--line); background: transparent; color: inherit }
  button { cursor: pointer } button:hover { background: #8881 }
  textarea { width: 100%; font-family: ui-monospace, monospace; min-height: 2.2rem }
  pre { background: #8881; padding: .5rem; border-radius: .3rem; overflow: auto; margin: .35rem 0 0 }
  .err { color: #c33 } .muted { color: var(--dim) }
  .ev { border-bottom: 1px solid var(--line); padding: .4rem 0; font-size: .9em }
  .ev time { color: var(--dim); font-size: .85em }
  code { font-family: ui-monospace, monospace }
</style>
</head>
<body>
<aside>
  <h1>Peers</h1>
  <div id="peers"></div>
  <p class="muted" id="empty">Waiting for a peer to announce itself…</p>
</aside>
<main>
  <h1 id="title">Select a peer</h1>
  <div id="detail"></div>
</main>
<section>
  <h1>Events</h1>
  <div id="events"></div>
  <p class="muted" id="noevents">Subscribe to an event to see it here.</p>
</section>
<script>
const $ = (id) => document.getElementById(id)
const peers = new Map()
let selected = null
// Subscriptions the console already holds, so a reloaded page shows what is really streaming
// rather than starting every button in the unwatched state.
let watching = new Set()

const render = () => {
  $('peers').innerHTML = ''
  $('empty').hidden = peers.size > 0
  for (const [name, state] of [...peers].sort()) {
    const row = document.createElement('div')
    row.className = 'peer'
    row.setAttribute('aria-selected', String(name === selected))
    row.innerHTML = '<span class="dot' + (state === 'online' ? '' : ' off') + '"></span>' + name
    row.onclick = () => select(name)
    $('peers').append(row)
  }
}

const esc = (s) => String(s).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))

// The schema's type language, rendered the way a person would write it.
const typeText = (t) => {
  if (!t) return 'unknown'
  switch (t.kind) {
    case 'literal': return JSON.stringify(t.value)
    case 'array': return typeText(t.items) + '[]'
    case 'tuple': return '[' + t.items.map(typeText).join(', ') + ']'
    case 'union': return t.options.map(typeText).join(' | ')
    case 'ref': return t.name
    case 'object': return '{ ' + Object.entries(t.fields).map(([k, f]) => k + (f.optional ? '?' : '') + ': ' + typeText(f.type)).join(', ') + ' }'
    case 'number': return 'number' + (t.min !== undefined || t.max !== undefined ? '(' + (t.min ?? '') + '..' + (t.max ?? '') + ')' : '')
    default: return t.kind
  }
}
const signature = (m) => m.name + '(' + (m.params ? m.params.map(typeText).join(', ') : '…') + ')' + (m.returns ? ': ' + typeText(m.returns) : '')

const refreshWatching = async () => {
  const state = await fetch('/api/peers').then((r) => r.json())
  watching = new Set(state.watching || [])
}

const select = async (peer) => {
  selected = peer
  render()
  await refreshWatching()
  $('title').textContent = peer
  $('detail').innerHTML = '<p class="muted">Describing…</p>'
  const described = await fetch('/api/describe?peer=' + encodeURIComponent(peer)).then((r) => r.json())
  if (described.error) {
    $('detail').innerHTML = '<p class="err">' + esc(described.error) + (described.code ? ' <code>' + esc(described.code) + '</code>' : '') +
      '</p><p class="muted">A server only answers this when it is started with exposeIntrospection.</p>'
    return
  }
  $('detail').innerHTML = ''
  const header = document.createElement('p')
  header.className = 'muted'
  header.textContent = (described.version ? 'contract ' + described.version + ' · ' : '') +
    (described.validating ? 'arguments checked' : 'arguments not checked')
  $('detail').append(header)

  for (const ns of described.namespaces) {
    const box = document.createElement('details')
    const events = ns.events.map((e) => {
      const key = selected + '/' + ns.name + '/' + e.name
      const on = watching.has(key)
      return '<div class="row"><code>' + esc(e.name) + '(' + (e.params ? e.params.map(typeText).join(', ') : '…') + ')</code>' +
        '<button data-toggle="' + esc(ns.name) + '|' + esc(e.name) + '" aria-pressed="' + on + '">' + (on ? 'unwatch' : 'watch') + '</button>' +
        '<span class="muted" data-subs="' + esc(ns.name) + '|' + esc(e.name) + '">' + e.subscribers + ' subscriber' + (e.subscribers === 1 ? '' : 's') + '</span></div>'
    }).join('')
    box.innerHTML = '<summary>' + esc(ns.name) + (ns.version ? ' <span class="muted">@' + esc(ns.version) + '</span>' : '') +
      ' <span class="muted sig">' + esc(ns.className || '') + (ns.created ? ' · created at runtime' : '') + '</span></summary>' +
      '<div class="body">' + ns.methods.map((m) =>
        '<div class="row" style="align-items:flex-start"><div style="flex:1">' +
        '<div class="sig">' + esc(signature(m)) + '</div>' +
        '<textarea data-args="' + esc(ns.name) + '|' + esc(m.name) + '" placeholder="[] — arguments as a JSON array"></textarea>' +
        '</div><button data-call="' + esc(ns.name) + '|' + esc(m.name) + '">call</button></div>' +
        '<pre data-out="' + esc(ns.name) + '|' + esc(m.name) + '" hidden></pre>').join('') +
      (events ? '<p class="muted" style="margin:.75rem 0 .25rem">Events</p>' + events : '') + '</div>'
    $('detail').append(box)
  }
}

$('detail').addEventListener('click', async (e) => {
  const callKey = e.target.dataset?.call
  const toggleKey = e.target.dataset?.toggle
  if (callKey) {
    const [namespace, method] = callKey.split('|')
    const box = document.querySelector('[data-args="' + CSS.escape(callKey) + '"]')
    const out = document.querySelector('[data-out="' + CSS.escape(callKey) + '"]')
    let args
    try { args = box.value.trim() ? JSON.parse(box.value) : [] } catch { out.hidden = false; out.className = 'err'; out.textContent = 'Arguments must be a JSON array'; return }
    if (!Array.isArray(args)) args = [args]
    out.hidden = false; out.className = ''; out.textContent = 'calling…'
    const body = await fetch('/api/call', { method: 'POST', body: JSON.stringify({ peer: selected, namespace, method, args }) }).then((r) => r.json())
    out.className = body.error ? 'err' : ''
    out.textContent = body.error ? (body.code ? body.code + ': ' : '') + body.error : JSON.stringify(body.result, null, 2) + '\\n\\n// ' + body.ms + ' ms'
  }
  if (toggleKey) {
    const [namespace, event] = toggleKey.split('|')
    const key = selected + '/' + namespace + '/' + event
    const on = watching.has(key)
    e.target.disabled = true
    e.target.textContent = on ? 'unwatching…' : 'watching…'
    const body = await fetch(on ? '/api/unwatch' : '/api/watch', {
      method: 'POST',
      body: JSON.stringify({ peer: selected, namespace, event })
    }).then((r) => r.json())
    if (body.watching) watching.add(key); else watching.delete(key)
    e.target.disabled = false
    e.target.textContent = body.watching ? 'unwatch' : 'watch'
    e.target.setAttribute('aria-pressed', String(!!body.watching))
    // The server's own count moves with it, so re-read it rather than guessing.
    const described = await fetch('/api/describe?peer=' + encodeURIComponent(selected)).then((r) => r.json())
    const found = described.namespaces?.find((n) => n.name === namespace)?.events?.find((ev) => ev.name === event)
    const label = document.querySelector('[data-subs="' + CSS.escape(toggleKey) + '"]')
    if (found && label) label.textContent = found.subscribers + ' subscriber' + (found.subscribers === 1 ? '' : 's')
  }
})

const stream = new EventSource('/api/events')
stream.addEventListener('ready', (m) => { for (const p of JSON.parse(m.data).peers) peers.set(p, 'online'); render() })
stream.addEventListener('peer', (m) => {
  const { peer, state } = JSON.parse(m.data)
  if (state === 'online') peers.set(peer, 'online'); else peers.set(peer, 'offline')
  render()
})
stream.addEventListener('event', (m) => {
  const ev = JSON.parse(m.data)
  $('noevents').hidden = true
  const row = document.createElement('div')
  row.className = 'ev'
  row.innerHTML = '<time>' + new Date(ev.at).toLocaleTimeString() + '</time> <code>' + esc(ev.peer) + '/' + esc(ev.namespace) + '.' + esc(ev.event) + '</code>' +
    '<pre>' + esc(JSON.stringify(ev.args)) + '</pre>'
  $('events').prepend(row)
})
</script>
</body>
</html>
`
