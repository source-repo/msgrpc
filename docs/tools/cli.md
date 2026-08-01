# The command line

The command is `source-rpc`, from [`@source-repo/rpc-cli`](https://www.npmjs.com/package/@source-repo/rpc-cli). ESM only, Node 22 or later.

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
source-rpc mcp       serve the network to an MCP client over stdio
source-rpc peers     who is on the network right now
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

## peers, describe, call, watch

The console's verbs for a shell rather than a browser. Same network flags as `console`, one answer each, and an exit code:

```
source-rpc peers --hub http://bus:7843
source-rpc describe plantServer --hub http://bus:7843
source-rpc call plantServer plant.writeSetpoint 1200 auto --hub http://bus:7843
source-rpc watch plantServer plant.alarm --hub http://bus:7843
```

```
$ source-rpc describe plantServer --hub http://bus:7843
plantServer (contract 3) — arguments checked

plant@3  Plant
  writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
  read(): { celsius: number, bar: number }
  event alarm(string, number)  0 subscribers
```

**`call` exits 1 when the peer refuses**, which is the point: a smoke test is a line in a CI file rather than a program that parses output.

```
$ source-rpc call plantServer plant.writeSetpoint 3000 --hub http://bus:7843
msgrpc: plantServer.plant.writeSetpoint failed: InvalidParams: argument 0 is above the maximum 2000
$ echo $?
1
```

### Arguments come from the contract

A shell has only strings, so the peer is described first and **its own contract decides what each word means**. `1200` is a number where the schema says `number` and the text `1200` where it says `string`; `auto` matches a literal in a union; an object argument is JSON; `date` takes an ISO string and `bytes` takes hex. Where a peer publishes no contract the rule is JSON-if-it-parses and the literal text otherwise, so `42` is a number and `hello` is a string rather than a syntax error.

A word that cannot be what the contract asks for is refused before anything is sent, and the argument is named rather than numbered:

```
$ source-rpc call plantServer plant.writeSetpoint warm
msgrpc: argument 0 (value): expected a number, got 'warm'
```

`--args '[1200, "auto"]'` skips all of that and sends the array as it parses, for a call the contract cannot describe or a value the shell would mangle.

### Output

`--json` on every verb. Without it the output is for reading; with it, for `jq`. Which one is wanted is not guessed from whether stdout is a tty, because that guess is wrong exactly when it matters — in CI.

`call` puts the result on stdout and the timing on stderr, so a pipe carries the value and nothing else while a person still sees what it cost:

```
$ source-rpc call plantServer plant.read --hub http://bus:7843 | jq .celsius
84
```

`watch` writes one event per line as JSON, since it is the verb most likely to be piped somewhere and a stream that is pleasant to read is a stream nothing can parse:

```
$ source-rpc watch plantServer plant.alarm --hub http://bus:7843
msgrpc: watching plantServer.plant.alarm. Ctrl-C to stop.
{"at":1749047112004,"peer":"plantServer","namespace":"plant","event":"alarm","args":["pressure high",2]}
```

Ctrl-C drops the server's subscription as well as stopping the stream, rather than only walking away from it — a debugging session should not leave listeners behind on a device that outlives it.

### Waiting for a peer

`ready()` means the links are up, not that presence has arrived, and over MQTT retained presence lands a moment after the subscription does. Each verb waits up to `--wait` (5 s) for the peer to become addressable and then says so plainly, rather than failing intermittently for reasons nobody can reproduce:

```
$ source-rpc call plantServr plant.read --hub http://bus:7843
msgrpc: plantServr did not appear within 5000 ms. Run 'source-rpc peers' to see who is there.
```

### Sending a command twice on purpose

A redelivered *packet* is already handled — the server recognises the request id and answers from what it recorded rather than running the method again. What that cannot cover is a second **attempt**: a script that retries, or an operator pressing the button again, is a new request, and only the caller knows the two are one intent.

`--idempotency-key` is how the caller says so:

```
source-rpc call filler filling.dispense 500 --idempotency-key batch-4417 --hub http://bus:7843
```

Run that twice and the batch is dispensed once; the second call is answered from the record of the first. Run it without the key and it is dispensed twice, which is the correct reading of two commands that did not claim to be one.

It only means anything for a method declared `non-repeatable-command` on a server given a durable idempotency store — see [Commands](https://github.com/source-repo/rpc/tree/main/packages/rpc#commands). Without a store the key is carried and ignored, so a retry loop in a shell script is not protection by itself.

## Declaring the contract

The namespace is declared in the source, because static analysis cannot see the name a class is eventually exposed under at some `exposeClassInstance` call elsewhere. Methods opt in with `@rpc`, so the contract is the allow-list rather than everything on the prototype chain.

```typescript
import { rpc, rpcNamespace } from '@source-repo/rpc'

@rpcNamespace('plant', { version: '2' })
export class Plant {
    declare rpcEvents: { alarm: [message: string, severity: number] }

    @rpc async writeSetpoint(value: number, mode?: 'auto' | 'manual') { ... }
    async internalOnly() { ... }        // unmarked, so absent from the contract
}
```

Events are declared as a property type rather than inferred from `emit()` calls, which cannot be read statically with any confidence.

## extract

```
source-rpc extract --project tsconfig.json --out msgrpc.types.json
```

It describes **the files your tsconfig includes**, not everything they import. A decorated class in a dependency belongs to that dependency's contract, not yours.

Nothing is executed: the decorators are read from the syntax tree, so `extract` never runs your code.

### What it refuses to describe

Anything the type language cannot represent is **reported, never emitted as `any`**, and a run with any diagnostic writes no file. A schema that quietly degrades on the parts it could not read still looks like protection while checking nothing.

```
msgrpc: 3 types could not be described
  plant.fetch return is generic (T), which has no runtime type to check (src/plant.ts:6)
  plant.subscribe argument 0 is a function, which cannot be checked on the wire (src/plant.ts:12)
  plant.lookup return is a Map, which MsgPack does not carry; use an object or an array (src/plant.ts:18)
```

So far: generics, function parameters, `Map` and `Set`, and a type that is part dictionary and part declared shape — `{ name: string; [tag: string]: unknown }` — which would need describing both halves at once. Dropping either one produces a contract that looks checked and is not.

At most 25 diagnostics are printed, followed by a count of the rest.

### What it can and cannot see

`Date` and `Uint8Array` come through as values rather than encodings of them, because MsgPack carries both. Recursive types become named references. `Promise<T>` is unwrapped.

An index signature becomes a `record`, so `{ [tag: string]: Reading }` is described by its value type with the keys left open, and a wrong reading is still caught. `{ [id: number]: string }` gets a key pattern instead of a numeric key type, because a JS object key is always a string on the wire.

A generic instantiation is inlined rather than named: `Record<string, number>` and `Record<string, string>` share the symbol `Record`, so keying both under it would quietly make the second a reference to the first's value type.

What it cannot see is anything the type system does not carry. `value: number` becomes `{ kind: 'number' }` — a range like `0..2000` is a runtime invariant, invisible to TypeScript. Extraction gives you shape checking: types, arity, whether an argument is required. Bounds have to be added to the schema afterwards or expressed in the type.

## check

```
source-rpc check --project tsconfig.json --against msgrpc.types.json
```

Compares the source against a stored contract using the **same comparison the server applies at runtime** to a caller declaring an older version, so a change that would refuse a deployed peer fails the build instead:

```
$ source-rpc check
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
msgrpc: 1 breaking change against msgrpc.types.json
$ echo $?
1
```

Parameters may widen and returns may narrow; the reverse breaks callers. Adding an optional argument or field is safe, adding a required one is not. Events run the other way, since the server emits and the caller receives.

`extract --keep-history` moves the previous contract into `history` when the version changes, which is what lets both this check and the server recognise an older caller.

### Checking the device rather than the build

`check` against source catches a change before it ships. What it cannot answer is the question asked on site: the contract says this device offers `writeSetpoint(value, mode?)` — is that what the box on the wall is actually running?

```
$ source-rpc check --peer plantServer --against plant.types.json --hub http://bus:7843
  plant.writeSetpoint argument 0 narrowed, so a value the caller may send is no longer accepted
  plant.read no longer exists
  plant.event alarm is no longer emitted, so a subscription to it would never fire
msgrpc: 3 breaking changes between plant.types.json and plantServer
$ echo $?
1
```

The peer describes itself and the answer runs through **the same comparison** the server applies to a caller declaring an older version — so a device behind its own contract is reported in exactly the words a stale caller would have got, and `check` in CI and `check --peer` on site agree about what "breaking" means.

A namespace the peer does not serve at all is reported apart from one that changed. **A peer running without a schema is reported as unchecked, not as passing**: it describes its method names and nothing else, and calling that "no breaking changes" would be the most useful-sounding lie available.

## diff

Why does cell 3 behave differently from cell 2? Usually because one of them is running last season's firmware.

```
$ source-rpc diff cell2 plantServer --hub http://bus:7843
cell2  vs  plantServer

  plant contract version
    cell2: 3
    plantServer: 4

  plant.read
    cell2: read(): { celsius: number(0..100), bar: number(0..10) }
    plantServer: —

  plant.writeSetpoint
    cell2: writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
    plantServer: writeSetpoint(value: number(0..500), mode?: "auto" | "manual"): boolean

  plant event alarm
    cell2: emitted
    plantServer: —
```

Signatures are compared as they read rather than structurally, because the answer is going to be read by a person standing in front of two cabinets. It exits 1 when anything differs, so a script can assert that two cells match; `--json` gives the same as data.

## serve

A peer built from a contract rather than from code, so an HMI has something to talk to and a test has a device willing to fail on request — which a real one is not.

```
source-rpc serve --contract plant.types.json --hub http://bus:7843 --name fakePlant
```

```
$ source-rpc describe fakePlant --hub http://bus:7843
fakePlant — arguments checked

plant@3  Fake
  halt()
  read(): { celsius: number(0..100), bar: number(0..10) }
  writeSetpoint(value: number(0..2000), mode?: "auto" | "manual"): boolean
  event alarm(string, number(1..3))  0 subscribers
```

It answers every method with a value of the declared shape, and **refuses what the real peer would refuse** — it is given the same schema, so the same validator runs:

```
$ source-rpc call fakePlant plant.writeSetpoint 3000 --hub http://bus:7843
msgrpc: fakePlant.plant.writeSetpoint failed: InvalidParams: argument 0: 3000 is above the maximum 2000
```

The contract is the one already extracted and committed for the deployed peer, so the stand-in cannot drift from it: `source-rpc check` fails the build when it would.

### What it generates

Deterministic, and inside whatever the type language carries — a fake whose readings wander is pleasant to look at and impossible to assert on.

| the schema says | you get |
| --- | --- |
| `number` with `min`/`max` | the midpoint, rounded if `integer` |
| `string` with `minLength`/`maxLength` | `sample`, padded or trimmed to fit |
| a union of literals | the first one that is not `null` |
| an object | its **required** fields only |
| an array | one element |
| `bytes` | four bytes, or `maxBytes` of them |
| `date` | now — a device reporting the epoch reads as a broken clock |

`pattern` is the one it cannot honour; satisfying an arbitrary regular expression is a different problem, so a constrained string comes back as the placeholder. A recursive type stops rather than descending forever.

### Scripting it

```
source-rpc serve --contract plant.types.json --script fake.json --fail plant.halt=Unauthorized --hub http://bus:7843
```

```json
{
  "returns": { "plant.read": { "celsius": 84, "bar": 3.2 } },
  "fails":   { "plant.writeSetpoint": "Timeout" },
  "emits":   [{ "event": "plant.alarm", "every": 2000 }]
}
```

`returns` replaces the generated answer. `fails` answers with an RPC error code instead — `Unauthorized`, `Forbidden`, `InvalidParams` and so on — and **`Timeout` is the special one: the call is never answered at all**, so the caller's own timeout is what fires. That is the failure an HMI handles worst and the one you otherwise stage by pulling a cable. Only the named method is affected; the rest of the peer keeps working, so a test can break one thing rather than the device.

`emits` sends a declared event on a timer, with parameters of the declared shape unless the script supplies them — the receiving half of an HMI otherwise has nothing to receive.

`--fail <ns.method=Code>` is the same thing without a file, and is repeatable.

**It says it is a fake** on startup and in the class name a console shows, because a stand-in mistaken for the device is worse than no stand-in at all.

### Simulating something that reacts

`returns` answers the same thing every time, which is enough for a screen that needs something to draw and not enough for the behaviour an HMI is usually wrong about: a pump that ramps toward the setpoint it was last given, a batch that will not start twice, a valve that reports closed until something opens it. Those need a variable and a method that can see what it was called with.

So a script may carry `state` and give methods a body. **This runs code the script supplied, so it is off unless `--allow-exec` is given**, and a script that asks for it without the flag is refused at startup rather than served with the handlers quietly dropped.

```
source-rpc serve --contract plant.types.json --script pump.json --allow-exec --hub http://bus:7843
```

```json
{
  "state": { "celsius": 20, "setpoint": 20 },
  "handlers": {
    "plant.setSetpoint": "(bar) => { state.setpoint = bar; return null }",
    "plant.read": "() => ({ celsius: state.celsius += Math.sign(state.setpoint - state.celsius) })"
  }
}
```

Each handler is a JavaScript function, called with the arguments the caller sent, sharing the mutable `state`. A handler wins over `returns` for the same method, so a script can carry both: bodies for what it simulates, canned values for the rest.

For a simulation with more arithmetic in it than a one-liner wants to hold, `python` runs a program instead. It is started once and keeps its own state in its own variables, which is usually why you reached for it:

```json
{
  "python": {
    "targets": ["plant.read", "plant.setSetpoint"],
    "program": "sp = {'v': 20}\n@rpc('plant.setSetpoint')\ndef s(bar):\n    sp['v'] = bar\n@rpc('plant.read')\ndef r():\n    return {'celsius': sp['v']}"
  }
}
```

`@rpc('namespace.method')` is supplied by a shim wrapped around the program; nothing needs importing and `python3` on `PATH` is the only requirement. Whatever the program prints that is not a reply is forwarded to stderr, so debugging with `print` works.

**What the flag is and is not.** It is the security boundary. The JavaScript context has no `require`, no `process` and no filesystem, and a handler that never returns is cut off rather than wedging the peer — but `node:vm` is documented as not being a security mechanism, and Python is a subprocess with the privileges of whoever started it and no confinement at all. This is the right tool for a simulator on a development machine and the wrong thing to reach from a plant network, which is why [the container](#in-a-container) ships without the flag and both `serve` and `mcp` say on startup when it is on.

## record and replay

The question a plant asks constantly and no test framework answers: *this new device is supposed to behave like the old one — does it?* Capture a session from the working plant, replay it at the replacement, and compare the answers.

```
source-rpc record --out session.jsonl --hub http://bus:7843
source-rpc replay session.jsonl --against newPlant --hub http://bus:7843
```

`record` opens a tap wherever it can — a broker's `bus` over socket.io, its own subscription over MQTT — and writes one frame per line:

```
{"msgrpc":"recording","version":1,"at":1785283506726,"filter":{"payloads":true},"sources":["plantBus"]}
{"at":1785283509702,"source":"hmi-3","target":"plantServer","kind":"POST","namespace":"plant","method":"read","id":"396f…","params":[]}
{"at":1785283509705,"source":"plantServer","target":"hmi-3","kind":"SUCCESS","id":"396f…","ms":3,"result":{"celsius":84}}
```

jsonl, so `grep`, `jq` and `wc -l` work on it. Lines are appended as they arrive, so a process killed mid-session still leaves what it saw — a recording is most wanted from the run that ended badly.

**Payloads are on by default here**, where the tap has them off: a recording without arguments and results cannot be replayed, which is the only reason to make one. `--no-payloads` turns them off and `record` says on startup that it is writing them.

### Replaying

`replay` re-issues the recorded calls, in their original spacing, and compares each answer with the one that was recorded:

```
$ source-rpc replay session.jsonl --hub http://bus:7843
  ≠ plantServer plant.read: expected {"celsius":84,"bar":3.2}, got {"celsius":12,"bar":3.2}
source-rpc replay: 12 calls, 9 matched, 3 differed, 0 failed, 0 uncompared
$ echo $?
1
```

**It exits 1 when anything differed or failed**, so a conformance check is a line in a CI file.

- `--against <peer>` sends every call to one peer instead of its original addressee, which is how a session captured from `plantServer` is played at `plantServer-v2`.
- `--speed <n>` scales the original gaps; `0` sends with no waiting. The spacing is kept by default because a device that only misbehaves at the rate it actually sees should be given that rate.
- **A call that failed the same way it failed when recorded is a match.** A replacement that refuses what the old one refused is behaving, and marking that a failure would make every recording of a real plant unusable.
- A call recorded without payloads is reported, not sent empty — calling the method with nothing and comparing that is a worse answer than saying the recording cannot be replayed.
- Nothing recorded to compare against is counted apart as *uncompared* rather than as a pass.

`Date` and `Uint8Array` are tagged in the file (`{"$date":…}`, `{"$bytes":…}`) and restored on the way back. JSON carries neither, and a timestamp that replayed as a string is not what the device received — which is the same reason this library speaks MsgPack.

Events are recorded but not replayed: sending a device's own events back at it would be a different thing entirely.

## bench

A device is fine at one call a second. What does it do at twenty? Finding that out is ordinarily done by writing a script, and it is always the same script.

```
$ source-rpc bench plantServer plant.read --rate 40 --for 3000 --hub http://bus:7843
plantServer plant.read  120 calls in 3.0s at 40/s
  ms   min 1  p50 3  p90 4  p95 4  p99 5  max 5
  ok   120   failed 0
```

**Percentiles rather than an average**, because an average hides exactly the calls worth knowing about: a device answering in 2 ms with one reply in four seconds averages out to something that looks healthy.

Failures are counted by code, since a device refusing arguments and a device that stopped answering are different findings with the same shape:

```
$ source-rpc bench plantServer plant.writeSetpoint 9999 --rate 20 --for 1500
plantServer plant.writeSetpoint  30 calls in 1.5s at 20/s
  ok   0   failed 30
       InvalidParams: 30
$ echo $?
1
```

Errors under load are the finding, so any failure exits 1. Arguments are coerced from the peer's own contract, exactly as `call` does.

`--concurrency` bounds how many calls may be outstanding at once; past that they are **not sent and counted as fallen behind**. Piling calls onto a device that is already behind measures the queue rather than the device, and a run that did it would report healthy latencies for a device that is drowning.

## broker

```
source-rpc broker --port 7843
```

A bus for networks that have no MQTT broker to share. It runs until Ctrl-C, relaying between the peers that connect to it and telling each of them who else is there — which is what MQTT gives you through retained presence and per-peer topics, over one WebSocket port instead.

```
source-rpc broker plantBus on ws 127.0.0.1:7843
  + cellBus (:7843)
  + panel1 (:7843)
  + hmi (:7843)
```

Started bare it serves this machine only: the default bind is `127.0.0.1`, the same instinct as the console's, and it says so on startup. `--host 0.0.0.0` is what puts the bus on the network — the broker then states what that means, and without `--auth` what it means is that anything able to reach the port can join. Before 4.4.0 the broker bound every interface silently, so a deployment that relied on that now passes `--host 0.0.0.0` and gets a sentence naming the consequence it had all along.

Peers join it by dialling out, which is also the only thing a browser page can do:

```typescript
const panel = new RpcServer({ name: 'panel1', transports: [{ connect: 'http://bus:7843' }] })
panel.exposeClassInstance(new Panel(), 'panel')      // now callable by anything else on the bus
```

There is no separate broker implementation and there should not be: this is an `RpcServer` that exposes nothing. A peer addressing the broker by name gets `ClassNotFound`, which is the truth — it is a switchboard, not a service.

### Joining two brokers

`--upstream` dials another broker, and the two become one network. Each side's peers are advertised to the other, and a call crosses without either end knowing there was a hop:

```
source-rpc broker --port 7843 --name plantBus --host 0.0.0.0
source-rpc broker --port 8086 --name cellBus --host 0.0.0.0 --upstream http://plant:7843
```

A peer on `cellBus` is then callable from `plantBus` and the other way round. Repeat `--upstream` to join more than one. Loops are handled — a peer is never advertised back along the link it came from, and frames carry a hop count and are dropped after 8 relays — so brokers dialling each other in a ring settle rather than storm.

### Authenticating the bus

Without `--auth` the broker relays for anything that can reach the port, and every peer name on it is an unchecked claim. It says so on startup. `--auth` is what changes that: a file of bearer tokens, each naming the one peer it admits.

```json
{
    "token": "the-one-this-broker-presents-upstream",
    "tokens": {
        "3f9a…": "plantServer",
        "c710…": { "name": "hmi", "roles": ["operator"] }
    }
}
```

```
source-rpc broker --auth /run/secrets/bus.json
source-rpc broker plantBus on ws 127.0.0.1:7843, authenticating
```

`tokens` is what this broker accepts. `token` is what it presents when it dials an `--upstream`, so a broker joining another needs both: it is a bus to one side and a peer to the other. Every other command takes `--auth` too, and uses the `token` to join a hub that authenticates.

**One token per peer.** A token that maps to a name is evidence of who is calling; a single token everyone shares proves only that the caller got inside the fence. The peer presents it as its `credentials`, and its `--name` has to be the name the token was issued for — the bus drops frames claiming any other source, so a mismatch reads as every call timing out rather than as a refusal.

The flag names a path, never a secret, because `ps` is readable by everyone on the box. For a container there are `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS`, which say the same two things.

Two consequences worth knowing. The tap is gated with everything else, so `bus.tap()` is reachable only by a peer this broker admits. And an upstream broker is a peer of this one, not an operator of it: frames relay across the join as before, but a call to this broker's own `bus` namespace from across it is refused, because a connection this broker dialled is not one it authenticated.

### In a container

The broker is the piece of Source RPC that is infrastructure rather than a tool someone is holding, which is what makes it worth an image. [`Dockerfile`](https://github.com/source-repo/rpc/blob/main/packages/cli/Dockerfile) builds one whose entrypoint is the whole CLI, so a single image is a bus, a console, an MCP server or a recorder depending on the command:

```
docker run -d -p 7843:7843 \
    -e SOURCE_RPC_TOKENS='{"3f9a…":"plantServer"}' \
    ghcr.io/source-repo/rpc-cli:3           # no command: the default is the broker, bound wide -
                                            # inside a container the -p mapping decides reachability

docker run --rm -e SOURCE_RPC_TOKEN=3f9a… ghcr.io/source-repo/rpc-cli:3 \
    peers --hub http://bus:7843 --name plantServer        # any other command, same image
```

[`docker-compose/network.yml`](https://github.com/source-repo/rpc/blob/main/docker-compose/network.yml) runs the whole thing — an MQTT broker, the bus, and a console watching both — which is the shape a plant deploys:

```
echo "CONSOLE_TOKEN=$(openssl rand -hex 32)" > docker-compose/.env
docker compose -f docker-compose/network.yml up -d
open http://localhost:7844
```

Note what the compose file does with the console, because it is the part that is easy to get wrong. `--host 0.0.0.0` is needed for the page to be reachable from outside the container at all, and it means anything that can reach the published port can call whatever the console is allowed to call — so the port is published to `127.0.0.1` rather than to every interface. The bus is not: peers have to reach it, and `--auth` is what makes that safe rather than the firewall.

### What it is not

**Not a store-and-forward broker.** Nothing is queued for a peer that is not connected: a frame is handed to a peer that is there now, or reported as unroutable. If a peer needs to receive what was sent while it was down, that is what MQTT and `persistentSession` are for.

**Not authenticated.** It listens on every interface and relays for whoever connects, without checking who they are, and it says so on startup. Put it behind a network you trust, or build one from the library with `authenticate` and a `relay` rule.

**The tap is only as gated as the broker is.** Anyone who can reach an unauthenticated broker can call `bus.tap()` and mirror everything crossing it. They could always have read the same traffic by impersonating a peer; this is merely one call. `authenticate` and `relay` are what restrict it, and the broker says as much on startup.

## Scripting another node

[`--scripts`](#peers-kept-as-scripts) is the local case: a model writing and running programs on the machine it is talking to. On a bench with a Linux box, a Windows PLC and a couple of devices, the time goes on the machines it cannot reach — a remote desktop each, a file copied by hand, and the mistake you make on the fourth one.

`--scriptable-by <peer>` offers that same capability to a named peer as an ordinary RPC namespace, so every script tool takes a `node` argument and one of them reaches the next machine along:

```
save_script  { name: "ramp", source: "…" }                  # this node, the default
save_script  { name: "ramp", source: "…", node: "plc-3" }   # the machine across the hall
```

**The grant is made on the node being scripted, not by the one doing the scripting.** Name nobody — the default — and the namespace is not published at all, so a machine with `--scripts` can script itself and nothing can script it.

### It has to be signed through a bus

Identity is per connection, and **does not survive a relay**. A bench authenticates to the bus; the node being scripted is connected to the bus as well, so it has no connection to the bench and no way to learn who it is. It refuses, which is correct — the alternative is trusting a name that arrived through a third party. No flag changes this, because the information is not there to have.

A signature is on the frame rather than on the link, so it survives whatever the broker did in between. A relayed test hall is therefore MQTT with `--sign` at both ends, each key file naming the other peer:

```
# on the node being scripted
source-rpc mcp --broker mqtt://bus:1883 --sign node.json --scripts ./scripts --scriptable-by bench

# on the bench
source-rpc mcp --broker mqtt://bus:1883 --sign bench.json --scripts ./scripts
```

On a machine with no model attached — a PLC in the corner of the hall — run `node` instead of `mcp`. Same capability, nothing else in it, and no stdio protocol sitting unused beside the part that matters:

```
source-rpc node --scripts ./scripts --scriptable-by bench --broker mqtt://bus:1883 --sign plc.json
```

Both flags are required there. A node with no directory has nothing to offer and one that names nobody offers it to nobody; either way it would join the bus, take a peer name and do nothing, which is a configuration that reads as though it works.

The two arrangements that work — this one, and a bench connected directly to the node — each have a test. The secret in those key files is what has to reach the far machine out of band: a remote desktop, a phone call, paper. Deliberately not something the bus can hand over, since a bus able to distribute the key to script a node is a bus able to script the node.

## Ports

`7843` is the Source RPC port and `7844` is the web port. Both are defaults, so neither has to be typed. They are deliberately not in the 80xx range, which is where everything else on a developer's machine already is — a default that collides with whatever is on 8080 today is a default nobody keeps.

| | |
| --- | --- |
| `1883` | MQTT |
| `8083` | MQTT over WebSocket |
| `7843` | `source-rpc broker` |
| `7844` | `source-rpc console` |

**A process needs only one of them.** The console serves its page and its RPC on the same listener — socket.io answers `/socket.io` and everything else is the static app — so `7844` is one port, not a pair. The second number exists because a bus and a console usually run on the same host, not because either needs two.

## Flags

Every flag of every command, for when you know what you want and need the spelling. Nothing here is new: each one is explained where its command is.

| flag | commands | default | meaning |
| --- | --- | --- | --- |
| `--project <tsconfig.json>` | extract, check | `tsconfig.json` | the project to read |
| `--out <file>` | extract | `msgrpc.types.json` | where to write the contract |
| `--against <file>` | check | `msgrpc.types.json` | the contract to compare against |
| `--peer <name>` | check | — | ask a live peer what it serves instead of reading source; needs `--broker`/`--hub` |
| `--keep-history` | extract | off | move the previous contract into `history` when the version changed |
| `--broker <url>` | console, mcp, verbs | — | an MQTT network, e.g. `mqtt://localhost:1883` |
| `--hub <url>` | console, mcp, verbs | — | a socket.io network, e.g. `http://hub:7843`. One of `--broker`/`--hub` is required; both watches both |
| `--prefix <topic>` | console, mcp, verbs | the transport's own | must match the network you are watching |
| `--port <n>` | console | `7844`, or `8844` with `--cert` | |
| `--host <address>` | console, broker | `127.0.0.1` | see the warning each prints before widening this |
| `--base-path <path>` | console | `/` | publish under a path, for a reverse proxy that forwards the prefix instead of stripping it. See [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `--timeout <ms>` | console, mcp, verbs | `10000` | call timeout |
| `--name <peer>` | console | `console-<three words>` | how the console identifies itself to the network |
| `--sign <keyfile>` | console, mcp, verbs, serve | — | HMAC keys, so it can talk to a signed network |
| `--insecure-tls` | console, mcp, verbs, serve | off | accept any certificate on an `https`/`wss`/`mqtts` link. Unsafe by design: for a development bus with a self-signed certificate, never a plant |
| `--cert <file>` `--key <file>` | console, broker | — | serve TLS. Together they make the console HTTPS and the bus WSS, and move the default port to 8844 / 8843 |
| `--contracts <dir>` | mcp | — | let it save and load contracts here; without it those tools are not offered |
| `--scriptable-by <peer>` | mcp | — | let that peer script this node over the network, repeatable; needs `--scripts`. Without it nothing can script this machine. See [Scripting another node](./cli.md#scripting-another-node) |
| `--contract <file>` | serve | — | the contract to serve; every namespace in it is exposed |
| `--script <file>` | serve | — | canned returns, deliberate failures and events on a timer |
| `--fail <ns.method=Code>` | serve | — | answer with that RPC error code; repeatable. `Timeout` never answers |
| `--out <file>` | record | — | where to write the recording, as jsonl |
| `--peer <name>` | record | — | only frames this peer sent or received |
| `--namespace <name>` | record | — | only this namespace |
| `--no-payloads` | record | off | leave arguments and results out |
| `--for <ms>` | record | — | stop after this long, instead of waiting for Ctrl-C |
| `--against <peer>` | replay | the original addressee | send every call here instead |
| `--speed <n>` | replay | `1` | higher is faster; `0` sends with no waiting |
| `--rate <n>` | bench | `10` | calls per second to aim for |
| `--for <ms>` | bench | `10000` | how long to keep going |
| `--concurrency <n>` | bench | `50` | calls outstanding before the rest count as fallen behind |
| `--name <peer>` | mcp | `mcp-<three words>` | how it identifies itself to the network |
| `--name <peer>` | verbs | `cli-<three words>` | how it identifies itself to the network |
| `--wait <ms>` | verbs | `5000` | how long to wait for the peer to appear before giving up |
| `--json` | verbs | off | machine-readable output |
| `--args <json>` | call | — | the whole argument list as a JSON array, instead of words |
| `--idempotency-key <key>` | call | — | names the command, so two attempts under one key are one command rather than two. See [Sending a command twice on purpose](#sending-a-command-twice-on-purpose) |
| `--port <n>` | broker | `7843`, or `8843` with `--cert` | listens on every interface |
| `--name <peer>` | broker | `broker-<three words>` | how the broker identifies itself |
| `--upstream <url>` | broker | — | join another broker; repeatable |
| `--auth <file>` | broker, console, mcp, verbs, serve | — | bearer tokens: which to accept, and which to present. See [Authenticating the bus](#authenticating-the-bus) |
| `--quiet` | broker | off | stop logging peers arriving and leaving |
