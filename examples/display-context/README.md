# Displaying context and component state

A two-peer plant to point `source-rpc console` at, and the reason the console can now show a node's ambient context and draw its state from the contract instead of from whatever the values happen to look like.

## Running it

```sh
npm run build                                    # once, from the repo root
npm run example:contract                         # extract -> contract.json
npm run example:build                            # strip   -> dist/plant.ts
node examples/display-context/dist/plant.ts      # the plant, on :7843
source-rpc console --hub http://localhost:7843   # the console, on :7844
```

Then open the console, select **bakery**, press **observe** on a component, and type a token id into a context panel — `acme.site` on the physical axis, or `acme.work-order` on the logical one.

## What is worth looking at

**The state is drawn from the published interface.** `props` and `state` are declared as ordinary TypeScript interfaces in `plant.ts`; `extract` reads them with ts-morph and writes them into `contract.json` beside the method signatures; `describe()` carries them to the console. So the console draws `zones.top.setpoint` as a tree, knows `door` is one of two words, and labels a field that is currently null instead of omitting it. It has never seen this file.

**A value is editable when a method declares that it sets it.** `@rpc({ semantics: 'idempotent-command', sets: 'setpoint' })` is what puts an editor on `setpoint`, and nothing puts one on `temperature`, because nothing claims it - the oven decides which of its values are commanded and which are measured, and the panel reads that decision rather than inferring one from what the methods are called. Editing calls the method; nothing is written locally, and the number on screen moves when the plant publishes its next snapshot. Try `999` to watch a refusal arrive where the value would have been.

Open `zones` for the case a naming rule could never have reached: `setTopSetpoint` declares `sets: 'zones.top.setpoint'`, so that leaf is editable two levels down while `zones.top.temperature` right beside it - same shape, same type - is not.

**And one setter for three hundred tags.** A marker per field is right for the oven and absurd for `field`, so it declares one method taking a path - `sets: '*'` - and every leaf gets an editor. This plant starts with `allowStatePathWrites: true`, which is what makes that method work at all; without it the host refuses the call and withholds the claim, so the panel would offer nothing. That flag is here because this is a development plant, and would not be on a real one.

Try it on a tag's `value` and watch the number stick until the sweep comes round to it again. Then try `fast`, and watch it refused: `field.set` decides for itself that only `tags.<tag>.value` may be written, which is the part the library deliberately does not supply - a writer handed over by the framework would be a public field with extra steps.

**Context is resolved by the node's own host.** The two axes disagree on purpose here: the oven is physically under the bread line and logically owned by it, while `pastry`'s line is a node on a second host that provides nothing at all. Watch `acme.site` there and the answer comes back from `bakery/$host`, having crossed hosts root to root; watch `acme.work-order` and it arrives from `bakery/line` through the remote owner. `acme.maintenance` is a `collect` token, so the console shows the whole chain nearest first.

The console asks with `contextAt()`, which is the library's resolver started at a node this peer does not own. The alternative - grafting the page into the topology next to whatever it wants to read - would be a claim about the plant that is false, and physical edges refuse it anyway.

**There is no list of tokens to pick from.** Context has no enumeration surface by design: listing what ambient data a plant carries is reconnaissance, and a token whose provider declares `exposure: 'local'` is filtered from remote answers silently rather than refused. An operator types the ids they are entitled to know and the console remembers them per peer.

## The tag field, and why the tree is built the way it is

`field` carries 300 tags, one of which moves five times a second. That is the shape a real screen has, and it is the case a whole-snapshot channel is least kind to: every tick sends all 300 values, so a panel that re-renders on the snapshot re-renders 300 rows to move one number.

It does not. Every leaf subscribes to its own path, and `useSyncExternalStore` compares what comes back - leaf values are primitives, so an unchanged one bails out before React does any work. The branches subscribe to as little as they need to know their shape: a typed object to nothing at all, since its fields come from the contract, and a record to its key list flattened to a string. The panel header reads only `status` and whether data has arrived, both primitives, so it does not drag the tree along behind it.

Measured in headless Chrome, observing `field` alone for fifteen seconds:

| | script | layout |
| --- | --- | --- |
| re-render the tree from the snapshot | 312 ms | 34 ms |
| each leaf subscribes to its own value | 39 ms | 35 ms |

Layout is unchanged, which is the point worth keeping: React's diffing already kept the *DOM* work to the one row that moved. What the arrangement saves is the render pass - the JS spent deciding that 299 rows still say what they said.

## Why the two build steps

The decorators are standard ECMAScript that V8 does not ship, so `node plant.ts` dies at the first `@`. `extract` reads those decorators to write the contract, and `strip` removes them and re-says them as `declareRpcNamespace`/`exposeMethods` calls, leaving a twin whose line numbers still match the original. Node's type stripping runs the result directly.

`dist/` is generated. Edit `plant.ts`.
