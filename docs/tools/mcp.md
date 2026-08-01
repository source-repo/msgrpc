# The MCP server

```
source-rpc mcp --broker mqtt://localhost:1883
source-rpc mcp --hub http://hub:7843
```

Serves the network to an [MCP](https://modelcontextprotocol.io) client over stdio, so a model can look at a plant the way a person looks at the console. It takes the same network flags as `console`, including `--sign`.

| tool | what it does |
| --- | --- |
| `list_peers` | who is on the network right now |
| `describe_peer` | one peer's namespaces, methods, argument names and types, and events |
| `call_method` | call a method, with positional arguments, and return what it returns |
| `start_fake` | stand a peer up from a contract and put it on this network |
| `stop_fake` / `list_fakes` | take one off again; what is being served here |
| `check_peer` | compare a live peer with a contract and report what would break |
| `diff_peers` | what two live peers expose differently |
| `watch_traffic` | what other peers are saying to each other, for a few seconds |
| `watch_events` | what one peer emitted, for a few seconds — and whether anything was missed since the last watch |
| `save_contract` / `list_contracts` | only with `--contracts <dir>` |

### Standing something up

The awkward part of asking a model to test a device is that the device has to exist. `start_fake` takes a contract **inline** — no file, no shell, no second terminal — and puts a peer on the network that answers from it:

```
start_fake { name: "fakePlant", schema: {…}, script: { returns: { "plant.read": { celsius: 84 } } } }
→ fakePlant is on the network, answering plant from the contract. It is a fake: it answers from
  the contract, not from a device.
```

From there the ordinary verbs reach it, and it **refuses what the contract refuses** — so a model can check that its caller handles `InvalidParams` without touching anything real. `script` supplies canned returns, deliberate failures and timed events, including the `Timeout` code that never answers at all.

**A fake will not take a name a peer already answers to.** Standing one up under a live device's name would displace it, and calls meant for the plant would reach a stand-in that agrees with everything. That is refused, not resolved.

Fakes run inside the MCP server rather than as spawned processes, so they stop when it does and none are left behind.

### Watching without wondering

`watch_events` subscribes for a few seconds and drops the subscription again, so a look leaves no listener behind on the device. That shape has a blind spot: an agent waiting for something rare polls windows, and an event can fall *between* them. So the answer carries a `loss` verdict, computed from an emission counter the server keeps per event whether or not anyone is subscribed — "gapless" means nothing fired between this watch and the previous one that was not heard; "missed N" means N fell in the gap; a server restart between watches is reported as **unknowable**, because a fresh incarnation cannot say what an old one dropped — the counter's vocabulary is the component channel's epoch discipline, and a sequence only orders within one epoch. A peer running an older library, or serving no introspection, is reported as unable to say, which is different from either. Each heard event also carries its `seq`, so a gap inside a window is visible in the data itself.

### Where contracts go

`--contracts <dir>` is what makes `save_contract` and `list_contracts` exist at all. Without it they are **not in the tool list**, because a server that cannot write files should not advertise tools claiming it can. With it, a contract is written as `<name>.types.json` in that directory and nowhere else — a name that would climb out of it is refused rather than resolved — and what is written is the same file `source-rpc serve --contract` and `source-rpc check --peer --against` read.

So the loop closes: a model can draft a contract, save it where the CLI will find it, stand a peer up from it, drive that peer, and check a real device against the same file.

### Peers kept as scripts

`start_fake` is the two-minute answer, and it is gone when the conversation ends. `--scripts <dir>` is the other thing: a directory of peers written as programs, which the model can add to, change, start and stop — and which you can open in an editor, commit, and run by hand with `node`.

A script is not bound to one contract, so unlike a fake it can call as well as answer: drive a start-up sequence, poll a device and log what it sees, bridge two networks, or stand several peers up at once.

```
source-rpc mcp --hub http://bus:7843 --scripts ./scripts
```

| tool | |
| --- | --- |
| `save_script` | write `<name>.ts` (or `.mjs`) to the directory |
| `read_script` | its source, for changing part of it rather than rewriting the whole |
| `list_scripts` | what is there, and which of them are running |
| `start_script` / `stop_script` | run it as its own process, or stop it |
| `delete_script` | remove it, stopping it first if it is running |
| `script_output` | the last 200 lines it printed, stderr marked `!` |

**TypeScript by default, and Node runs it directly** — no build step and no loader, on Node 22.6 and later. That is the point rather than a convenience: this library's whole idea is that a class is the contract, so a script that says `import type { Pump } from '../plant.js'` gets the same typed proxy the rest of your code does. On an older Node, or for a script that would rather be plain JavaScript, save it as `mjs`.

**Each script is its own process.** So it can import whatever it likes; a script that throws or wedges cannot take the MCP server down with it; and starting and stopping are a spawn and a kill rather than a module cache to reason about. They are stopped when the server exits, rather than left holding peer names nobody is serving.

**The network is handed over, not hardcoded.** A script is started with `SOURCE_RPC_HUB`, `SOURCE_RPC_BROKER`, `SOURCE_RPC_PREFIX` and `SOURCE_RPC_TOKEN` set from the flags this server was given, so it reads its broker url rather than carrying one that is right on your machine and wrong on the next. Its working directory is the scripts directory, so relative imports mean what their author meant and `@source-repo/rpc` resolves from the project that directory sits in.

That resolution is also where a sandbox quietly ages: a directory that pinned the library a major ago keeps working — old scripts against their own pinned dependency are legitimate — but new code written there is written against the old API, and nothing fails to say so. So `mcp` and `node` print one line at start when the directory's `@source-repo/rpc` major differs from the CLI's, naming both versions. A statement, never a refusal; matching majors print nothing.

```typescript
// scripts/pump-sim.ts — started with start_script, or `node scripts/pump-sim.ts`
import { RpcServer } from '@source-repo/rpc'

const peer = new RpcServer({ name: 'pumpSim', transports: [{ connect: process.env.SOURCE_RPC_HUB! }] })
peer.exposeClassInstance(new Pump(), 'plant')
await peer.ready()
console.log('pumpSim is on the network')
```

**Scripts get their own dependencies.** A script is an ordinary Node program, so sooner or later one wants something off the registry — a date library, a CSV parser, a driver for whatever is on the other end of the serial port.

| tool | |
| --- | --- |
| `list_packages` | what is declared, and what is actually installed |
| `add_package` | install one into the scripts directory |
| `remove_package` | uninstall it |

The directory gets its own `package.json` and `node_modules`, so nothing is added to the project around it, and a script resolves its imports from next door. That manifest also carries `"type": "module"` — which a `.ts` script needs, because Node decides whether `import` is legal from the nearest manifest, and inside a CommonJS project it would otherwise warn on every run and put the warning in the script's own output.

**Install scripts are skipped by default.** A `postinstall` hook is unreviewed code from the registry running on your machine, and it is the part of `npm install` that is not about files at all. A package that genuinely needs one — anything with a native build — takes `allowInstallScripts`, and the asking is visible in the tool log.

This is not a new grant on top of `--scripts`: a script could already `child_process.exec('npm i …')` by itself. What the tools buy is that the dependency is *declared* — in the tool log and in a committed `package.json` — rather than acquired sideways.

**This is a bigger grant than `--allow-exec`, and separate from it on purpose.** A handler body runs in a context with no filesystem and a time budget; a script is an ordinary Node process with your privileges, which can open sockets and read your disk. Both are development-machine features, and neither is enabled by default in [the container](#in-a-container) — the image that has what they need is the `-dev` one.

### Two images

The published image comes in two flavours, because the CLI is two things.

| | |
| --- | --- |
| `ghcr.io/source-repo/rpc-cli` | what goes near a plant: the commands that are infrastructure, and nothing else in the image |
| `ghcr.io/source-repo/rpc-cli:dev` | the same CLI plus `npm` and `python3`, which `--scripts` and the Python half of `--allow-exec` need in order to work at all |

```
docker run --rm -v "$PWD/scripts:/scripts" ghcr.io/source-repo/rpc-cli:dev \
    mcp --hub http://bus:7843 --scripts /scripts
```

The bare name is the runtime one, and `latest` points at it — whoever pulls without thinking should get the image meant for a plant.

The difference is not cosmetic. The runtime image has **no fixable critical or high vulnerabilities**; the development one carries five, all from npm's own bundled dependencies (`tar`, `undici`, `brace-expansion`). Shipping npm means inheriting every advisory against them, which is the whole reason the runtime image drops it — nothing at runtime shells out to npm, and the CLI is installed by the time it goes. The release scans both: the runtime image blocks a release on anything fixable, the development image is reported and not enforced, because failing on npm's dependencies would mean never releasing.

Neither flag is on by default in the `-dev` image either. It *can* do these things when asked; started with no flags it behaves exactly like the runtime one.

One practical note: `add_package` installs into the scripts directory rather than globally, so a bind-mounted directory has to be writable by uid 1000, which is the `node` user both images run as.

Not one tool per method on the network. A peer set that changes while a model is mid-conversation would mean re-issuing the tool list on every arrival and departure; `describe_peer` hands over the argument types instead, which is the same information in a form that does not go stale.

A call a peer refuses comes back as tool content with `isError`, carrying the reason — `InvalidParams: argument 0: expected number, got string` — rather than as a JSON-RPC failure. A model should read that and fix its call, which it cannot do if the transport swallows it.

To wire it into a client, give it the command and its flags:

```json
{
  "mcpServers": {
    "plant": { "command": "source-rpc", "args": ["mcp", "--broker", "mqtt://localhost:1883"] }
  }
}
```

**stdout carries the protocol and nothing else**, so this is not for interactive use — startup goes to stderr, and a stray `console.log` anywhere in the process would corrupt the stream. There is no MCP SDK behind it: MCP is JSON-RPC 2.0 over newline-delimited stdio, which is little enough to speak directly, and this package is about not needing a second RPC framework.

**Anything a model can reach, it can call.** The peers this lists are real, and `call_method` will happily invoke one that opens a valve. Point it at a network where that is acceptable, or give it credentials that restrict it: `--sign` makes it a peer with an identity, and `authorize` on the servers decides what that identity may do.

**And it can put peers on that network.** `start_fake` adds one — it calls nothing and changes no device, and it refuses a name already in use, but it is a peer other things can find and call. The same `authorize` and `--sign` machinery governs what it may do once it is there. Writing files is the one capability that stays off unless asked for: no `--contracts`, no tools that write.
