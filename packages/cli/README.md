```
███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗███████╗
██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝██╔════╝
███████╗██║   ██║██║   ██║██████╔╝██║     █████╗
╚════██║██║   ██║██║   ██║██╔══██╗██║     ██╔══╝
███████║╚██████╔╝╚██████╔╝██║  ██║╚██████╗███████╗
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚══════╝
██████╗ ██████╗  ██████╗      ██████╗██╗     ██╗
██╔══██╗██╔══██╗██╔════╝     ██╔════╝██║     ██║
██████╔╝██████╔╝██║     ████╗██║     ██║     ██║
██╔══██╗██╔═══╝ ██║     ╚═══╝██║     ██║     ██║
██║  ██║██║     ╚██████╗     ╚██████╗███████╗██║
╚═╝  ╚═╝╚═╝      ╚═════╝      ╚═════╝╚══════╝╚═╝
```

# @source-repo/rpc-cli

Tooling for [Source RPC](https://www.npmjs.com/package/@source-repo/rpc): read a contract out of TypeScript source, fail a build when it changes in a way that would break a deployed peer, browse a live network in a browser, and hand that same network to an AI assistant over [MCP](https://modelcontextprotocol.io) — list the peers, describe them, call them, stand a fake one up, watch what they say to each other.

```
npm install --save-dev @source-repo/rpc-cli
```

The command is `source-rpc`. ESM only, Node 22 or later. Container images at `ghcr.io/source-repo/rpc-cli`.

**Documentation: [source-repo.github.io/rpc](https://source-repo.github.io/rpc/)** — [the command line](https://source-repo.github.io/rpc/tools/cli), [the console](https://source-repo.github.io/rpc/tools/console) and [the MCP server](https://source-repo.github.io/rpc/tools/mcp) in full.

## What you would not expect

What a CLI usually ships for an RPC library is a code generator. A Source RPC server describes itself at runtime, so this one is a set of instruments instead — and these five are the ones people are surprised to find:

- **[The traffic tap](https://source-repo.github.io/rpc/tools/console#the-traffic-tap)** — `tcpdump` for RPC. It pairs a call to its reply and reports the method and the latency, *neither of which is in the reply itself*. Armed by a call rather than a restart, because a plant bus that has to be restarted before it can be watched will not be watched.
- **[`record` and `replay`](https://source-repo.github.io/rpc/tools/cli#record-and-replay)** — capture a live session, replay it at the replacement device, and exit 1 on divergence. A call that failed *the same way it failed when recorded* counts as a match.
- **[`check --peer`](https://source-repo.github.io/rpc/tools/cli#check)** — ask the box on the wall what it serves and compare that against the committed contract, using the comparator the server itself applies at runtime.
- **[`serve --fail plant.halt=Timeout`](https://source-repo.github.io/rpc/tools/cli#serve)** — a fake built from a contract and told to *never answer*. Staging a hang usually means pulling a cable.
- **[`mcp`](https://source-repo.github.io/rpc/tools/mcp)** — the live network as tools for a model: list the peers, describe one, call it with arguments checked locally first, find who implements a capability, or stand a fake up from a contract passed inline.

## Commands

**Contracts**

```
source-rpc extract   write the contract described by the source to a file
source-rpc check     compare the source against a written contract, exit 1 on a breaking change
source-rpc diff      compare what two live peers expose
```

**A live network**

```
source-rpc console   browse it in a browser: peers, what they expose, calls and events
source-rpc broker    run a WebSocket bus for peers with no MQTT broker to share, with a traffic tap
source-rpc node      make this machine scriptable from another one, and nothing else
source-rpc run       start console, node and serve roles together from one JSON task file
source-rpc mcp       serve the network to an MCP client over stdio
source-rpc peers     who is on the network right now
source-rpc find      who implements a qualified capability
source-rpc describe  what one peer exposes
source-rpc call      call a method, and exit 1 if the peer refuses
source-rpc watch     stream a peer's events as jsonl until Ctrl-C
```

**Testing against it**

```
source-rpc serve     stand a peer up from a contract, for an HMI with no plant to talk to
source-rpc record    write what the network is carrying to a file
source-rpc replay    send a recording's calls at a peer and compare the answers
source-rpc bench     call one method over and over and report what it cost
```

Every command, flag and port convention is documented on [the site](https://source-repo.github.io/rpc/tools/cli).
