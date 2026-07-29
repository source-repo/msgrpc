# Writing a simulator

You need something on the network that is not there yet: a device that has not been built, a device that exists but is in a cabinet in another country, or a device that exists and works and therefore will not fail on request — which is exactly what you need it to do.

Source RPC has four answers to that, and they are a ladder. Each rung costs more to write and buys behaviour the one below cannot express. The useful skill is knowing when to stop climbing.

| | what it is | when it is enough |
| --- | --- | --- |
| [1. A fake from the contract](#1-a-fake-from-the-contract) | every method answers a value of the declared shape | a screen needs something to draw |
| [2. A script of returns and failures](#2-canned-answers-and-deliberate-failures) | canned answers, staged errors, events on a timer | a test needs a *particular* answer, or a failure |
| [3. Handlers with state](#3-handlers-with-state) | method bodies over shared variables | the answer depends on what was called before it |
| [4. A peer of your own](#4-a-peer-of-your-own) | an ordinary program using the client package | it does more than answer calls |

Rungs 3 and 4 run code you supplied. They are development-machine features, off unless a flag says otherwise, and [the container](deploying-a-network.md) ships without them. That is deliberate and is discussed in [the security model](security-model.md#running-code-you-supplied).

## 1. A fake from the contract

```
source-rpc serve --contract plant.types.json --hub http://bus:7843 --name plantServer
```

Every method the contract declares now answers with a value of its declared type, and refuses arguments the real device would refuse — because the fake is handed the same schema and runs the same validator. A console can select it, an HMI can bind to it, and a form can be filled in against it.

Generated values are **deterministic**, and bounded where the contract carries bounds: a `number` declared `0..2000` comes back as `1000`, not as noise. A fake whose readings wander is pleasant to look at and impossible to assert on.

The one thing it cannot do is be wrong on purpose.

## 2. Canned answers and deliberate failures

```
source-rpc serve --contract plant.types.json --script fake.json --hub http://bus:7843
```

```json
{
  "returns": { "plant.read": { "celsius": 84, "bar": 3.2 } },
  "fails":   { "plant.halt": "Unauthorized" },
  "emits":   [{ "event": "plant.alarm", "every": 2000 }]
}
```

`returns` replaces the generated answer for one method. `fails` answers with an RPC error code instead. `emits` sends a declared event on a timer, which is how the receiving half of an HMI gets something to receive.

**`"Timeout"` is the one worth knowing.** It does not answer with a timeout error — it never answers at all, so the caller's *own* timeout is what fires. That is the failure an HMI handles worst, and the one you otherwise stage by pulling a cable out of a switch.

Only the named method is affected. The rest of the peer keeps working, so a test can break one thing rather than the device.

## 3. Handlers with state

Everything above answers the same thing every time. What it cannot express is a device that *reacts*: a pump that ramps toward the setpoint it was last given, a batch that will not start twice, a valve that reports closed until something opens it. Those are the behaviours an HMI is usually wrong about, and they need a variable and a method that can see its arguments.

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

Each handler is a function called with the caller's arguments, sharing the mutable `state`. A handler wins over `returns` for the same method, so one script can carry both: bodies for what it simulates, canned values for the rest.

For a simulation with more arithmetic than a one-liner wants to hold, `python` runs a program instead. It is started once and keeps state in its own variables:

```json
{
  "python": {
    "targets": ["plant.read", "plant.setSetpoint"],
    "program": "sp = {'v': 20}\n@rpc('plant.setSetpoint')\ndef s(bar):\n    sp['v'] = bar\n@rpc('plant.read')\ndef r():\n    return {'celsius': sp['v']}"
  }
}
```

`@rpc('namespace.method')` comes from a shim wrapped around your program — nothing to import, and `python3` on `PATH` is the only requirement. Anything the program prints that is not a reply goes to stderr, so debugging with `print` works.

A handler that never returns is cut off rather than wedging the peer, and one that throws fails its call and leaves the rest of the fake serving.

## 4. A peer of your own

A fake answers calls. Sooner or later you want something that also *makes* them: a program that drives a start-up sequence, watches for an alarm and reacts, bridges two networks, or stands up six devices at once with a shared model behind them.

That is not a fake with more script in it. That is a program.

```typescript
// scripts/pump-sim.ts
import { RpcServer } from '@source-repo/rpc'
import type { Panel } from '../plant.js'

const peer = new RpcServer({ name: 'pumpSim', transports: [{ connect: process.env.SOURCE_RPC_HUB! }] })
peer.exposeClassInstance(new Pump(), 'plant')
await peer.ready()

// The point of rung 4: it calls out as well as answering.
const panel = await peer.proxy<Panel>('panel', 'hmi1')
await panel.remote!.annunciate('pump simulator online')
```

Run it with `node scripts/pump-sim.ts` — Node runs TypeScript directly from 22.6, so there is no build step and `import type` gives you the same typed proxy the rest of your code has.

To let a model manage these, give the MCP server a directory:

```
source-rpc mcp --hub http://bus:7843 --scripts ./scripts
```

It can then write, read, change, start and stop them, and read back what they printed. Each runs as its own process, is handed the network in its environment rather than hardcoding it, and is stopped when the server exits. See [the CLI README](https://github.com/source-repo/rpc/tree/main/packages/cli#peers-kept-as-scripts).

## Which rung

Start at 1 and stop as soon as it is enough. Most screens never need past 2.

Climb to 3 when a test says *"and then read it back"* — that sentence is the tell that the answer depends on history.

Climb to 4 when the thing you are writing has its own reason to be on the network, rather than existing to answer somebody else. If you find yourself writing a state machine inside a JSON string, you passed the rung two steps ago.

## What none of them do

**They do not prove the real device behaves this way.** A simulator encodes what you believe; `source-rpc check --peer` compares a live device against the contract, and `source-rpc record` / `replay` compares a replacement against what the original actually did. Those are the tools that check your belief. A fake agrees with you by construction.
