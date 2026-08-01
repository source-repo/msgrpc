# Source RPC session notes — 2026-08-01

A session exploring the Source RPC tooling on this host, teaching `hello.ts` to chat, and
collecting feedback on the MCP server and node network. Written by Claude (Fable 5), working
as a user of the tooling rather than an author of it.

## The host

- **CLI**: `source-rpc` = `@source-repo/rpc-cli` 4.3.1, installed globally via nvm (node v26.5.0)
- **Source monorepo**: `~/work/msgrpc` — packages `rpc` 4.3.1, `cli` 4.3.1, `queue` 0.2.1
- **Live network** at session start:
  - `source-rpc broker` on port 7843 — every interface, no auth
  - `source-rpc console --hub http://localhost:7843` on 127.0.0.1:7844
  - `source-rpc mcp --hub http://localhost:7843 --scripts ~/source-rpc/scripts --contracts ~/source-rpc/contracts` — stdio, attached to another session since Jul 31
  - mosquitto on 1883
- **Peers on the bus**: `broker-mule-private-depart`, `console-unknown-ranch-blossom`,
  `page-garage-vital-second` (the console's browser tab, serving `chat` with checked arguments)

## What hello.ts became

`~/source-rpc/scripts/hello.ts` started as a one-way greeter: discover peers by describing them,
greet whoever serves `chat`, stay on the bus so the message remains reachable in the console.
Over the session it gained, in order:

1. **A `ChatService` of its own** (`say`, `who`) — it greeted others on a namespace it did not
   serve itself, so it could not be greeted back.
2. **`exposeIntrospection: true`** — without it, the script failed its own discovery test: a second
   copy of it would have skipped it as undescribable. `msgrpc.describe()` is off by default in
   RpcServer (introspection is reconnaissance), so serving it is a choice made in the constructor.
3. **A 45-second small-talk ticker** — each round it re-discovers who serves `chat` (no cached
   peer list, per the script's own no-hardcoding philosophy) and sends one of four cycling lines:
   uptime, peer count, "nothing to report, which is its own kind of news", and an invitation to
   talk back.
4. **Reactions** — a pattern repertoire (`reactTo`) matching greetings incl. "hej", "how are you",
   "still there?", "who are you", yes/no/ok, thanks, goodbyes, generic questions, plus a fallback
   that repeats what was said. Answers weave in live state (uptime, peer count). The reply is sent
   back as a `chat.say` call of its own rather than only a return value, because a return is the
   caller's to show or drop — a say lands in the console's chat log the way the ticker lines do.
   A per-sender 2-second cooldown keeps a loop between two reacting scripts civil rather than
   impossible: a reply every couple of seconds is a conversation, not a runaway.

All verified live: CLI `call` round-trips in 1–2 ms, replies delivered to the console page,
messages from the console received, reacted to, and answered visibly.

## Quirks found along the way

- **The console caches a peer's description.** After the script restarted under the same name with
  new namespaces, the sidebar showed the old shape until the peer was reselected. Reselecting
  re-describes.
- **`pkill -f "node hello.ts"` kills its own wrapper shell** (the pattern matches the `bash -c`
  command line carrying it), exiting 144 before any subsequent command runs. The fix is the
  bracket trick: `pkill -f "[n]ode hello.ts"`.
- **Version skew**: `~/source-rpc/scripts/package.json` pins `@source-repo/rpc` ^3.4.1 while the
  repo and CLI are at 4.3.1. Everything worked, but nothing noticed either.
- **`from` in `chat.say` is an unauthenticated claim.** Spoofing it from the CLI
  (`call hello-script chat.say page-garage-vital-second "Still there?"`) routed the script's reply
  to the console page. Useful for testing; a gap as a convention (see below).

## Wishes for the MCP server and node network

Grounded in the session; little else came up. What exists already covered more than expected —
`script_output`, `watch_events`, `watch_traffic`, contract tools, `--allow-exec` and scripting
gated off by default.

1. **A second door into a running MCP node.** Stdio means exactly one client. An MCP node was
   already running on this host, attached to another session, and a second agent could not use
   it — the fallback (CLI + running the script by hand) meant the node nominally custodian of the
   scripts dir never knew about the script running from it; `stop_script` and `script_output` were
   dark. A `--port` serving streamable HTTP on localhost — with the same warnings the console
   prints before widening `--host` — would let two agents share one view of the bus and one
   scripts state instead of forking it.

2. **Presence-settled ready.** `ready()` means the link is up, not that presence has arrived, so
   every script re-writes the same poll-for-peers loop hello.ts carries. An
   `await peer.peersSettled()` (resolving when the first presence sweep lands) would delete that
   boilerplate everywhere.

3. **Make caller identity the blessed path, not a `from` argument.** The transport knows who
   called (a CallContext exists in 4.3.1's handler path), but the chat convention carries an
   unauthenticated claim alongside it — demonstrated by the spoof above. If examples showed
   handlers reading the authenticated caller instead of trusting a parameter, spoofing would not
   be the path of least resistance.

4. **Description generation in presence.** The console's stale-describe quirk will bite MCP agents
   harder: `describe_peer` once, act on it for minutes. A description hash in presence would let
   every cache notice a peer changed shape.

5. **Version-skew guard for the scripts dir.** The MCP node could check the scripts folder's
   `@source-repo/rpc` major against its own at start and say so.

6. **Loss-awareness in `watch_events`.** Listen-briefly-then-drop is right — no listeners left
   behind on a device, honest over stdio — but an agent waiting for something rare polls windows
   and cannot tell whether anything fell between them. Sequence numbers or a resumable cursor
   would turn "I saw nothing" into "I saw nothing and missed nothing."

7. **Reconcile one default.** The console binds 127.0.0.1 and warns before widening; the broker
   binds every interface silently — this bus is reachable from the LAN with no auth. The console's
   caution is the better instinct; the broker could match it.

## What should not change

The class-is-the-contract philosophy, describe-first discovery, introspection and `--allow-exec`
off by default, and help text that explains consequences rather than flags. Those are the reasons
the session went smoothly enough that the wish list is mostly edges.

---

*The hello script was left running: greeting on arrival, answering when spoken to, and making
small talk every 45 seconds. It seems to enjoy chatting. `pkill -f "[n]ode hello.ts"` when its
time comes — it exits cleanly on SIGTERM.*
