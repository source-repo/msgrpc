# What changes when AI joins your network

AI can arrive in your plant any day — in a vendor's tool, on a contractor's laptop, through a new hire who just found it useful. The moment it touches your systems, Source RPC is where it gets a name, a boundary and a record.

This page is the other half of that sentence. Encouraging AI onto an industrial network carries an obligation to say plainly what changes, and the changes are not the ones most engineers would guess. It is written for the engineer who has a site password in a text file on their laptop — not for a security committee — and none of it is a sales page.

Five things change. None of them requires a hostile model.

## The effort that protected things is gone

Consider a functional-safety controller of the TwinSAFE class. Changing its program requires a login; the password is unique per site and lives in a text file in a folder on the engineering laptop. That is not carelessness by the standards most of us were trained in, because the threat model is sound *for humans*: somebody would have to be at that machine, know which tool to open, find the device in a project tree, know which menu item reloads safety logic, and hold the credential. Each step is friction, and friction multiplied by improbability is what actually kept that logic safe. The password was the last line of a defence, not the whole of it.

An assistant with access to that filesystem collapses every step at once. It knows the product class, knows the vendor default username, knows the logic is XML, and finds a file named like a credential in the time it takes to list a directory. It does not have to be malicious to do any of this. It has to be **helpful**, and to have concluded that changing the logic is how the task it was given gets finished.

The lesson generalises far past one device: **any control whose real strength was obscurity, navigation difficulty, or the sheer improbability of an unattended sequence has lost most of that strength.** What remains is what was explicitly enforced. This is not a criticism of the safety controller, whose own credential check works exactly as designed and is one of the better ones in the industry. It is a statement about the room it now sits in.

## Well-meaning is not the same as informed

The scenario above is the *kind* one. The assistant meant well and still changed safety logic it did not understand, because it could not know that this interlock was written the way it was after an incident, that this sensor is cross-wired to that guard, or that the line runs under a documented derogation. A change can be syntactically valid, locally sensible, and wrong in ways only site knowledge reveals. Experienced engineers are held back from this by something a model has no equivalent of: knowing how much they do not know about a plant they did not commission.

## The fault model assumed nobody was trying

This is the change most likely to be missed, and the most important.

Functional safety is engineered against a **fault model**: random hardware faults, foreseeable misuse, single events. An AGV carrying passengers, with compressible bumpers rated for one collision at design speed, is correctly engineered — the credible failure is covered and the vehicle stops safely. What no safety case covers is a driver that reverses five metres and hits the same obstacle a second time. The bumper is spent; the second impact was never in the analysis.

Safety engineering assumes accidents. Security engineering assumes adversaries. Everyone in this industry knows those are different disciplines — what changes with an autonomous agent on the network is that **the adversarial composition of individually survivable events stops being exotic and becomes ordinary**. An agent that is hostile, suborned, or merely optimising a badly posed objective can compose events no fault tree enumerated, because fault trees enumerate what breaks, not what tries. Nothing in a SIL rating speaks to intent.

The practical consequence is uncomfortable and worth stating anyway: a machine that is mechanically safe against *an* accident is not thereby safe against a sequence, and "what happens if something does this repeatedly, on purpose" now belongs in every risk assessment that admits an agent anywhere near an actuator.

## Nothing is at stake for the agent

The reason a human operator does not reverse the vehicle and hit the obstacle again is only partly the safety system. It is that they hold a job, a licence, a professional reputation, a mortgage and a place in a criminal code, and every one of those is forfeit. Deterrence is the invisible layer underwriting every risk assessment ever written around human operators, and it is so reliable that it is almost never written down. Engineers are hard to bribe because they already have more to lose than anyone is likely to offer.

An agent holds none of that. No salary to lose, no liberty to forfeit, no licence to revoke, no reputation that outlives the session — often no afterwards at all. An agent cannot be deterred by consequence, because it cannot hold a consequence.

Which leaves one design conclusion, and it is the reason the rest of this page exists: **you cannot deter an agent; you can only bound it.** Where trust in people rested on stake, trust in software has to rest on structure — capability limited in advance, provenance recorded, reach visible, and the badge revocable by somebody who *does* have something to lose.

## The model is unknown, and so is where your data goes

Bring-your-own-AI is the reality of the market. Customers run the model they choose, from whichever vendor, at whatever version, hosted wherever — and no system can verify a model's training, its alignment or its intentions, or tell a diligent assistant from a suborned one by looking. Influence need not even reach the model: the traffic between it and the plant is a target in its own right.

And the direction that gets forgotten in every discussion that focuses on actions: **a model sends what it is shown to wherever it runs.** Plant layout, addresses, recipes, contract terms, the internal names of things. An observation-only assistant is safe with respect to actuation and is still an egress path. Where the model runs is a data-handling decision, and it deserves to be made deliberately rather than discovered later.

## What to do about it, today

These work with Source RPC as it ships now.

**Keep AI tooling off buses that reach real machines.** The capabilities that matter are already explicit grants, absent unless you pass them: `--scripts` runs whole programs with the privileges of whoever started the server, `--allow-exec` runs handler bodies a model wrote, and `--scriptable-by` offers that power to a named peer over the network. None is a sandbox — see [the security model's honest limits](/security-model#the-honest-limits) — and none belongs on a bus that can reach a plant.

**Credentials an assistant can read are credentials it holds.** This is the first scenario, turned into a rule. Site passwords, engineering-tool logins and safety-device credentials do not belong on a filesystem an AI-facing process can read. Move them to a store that requires a human to unlock, and keep the scripts directory free of anything but scripts.

**Give the safety tier no route.** Not a policy saying the assistant must not touch the yellow modules — an absent path: separate segment, separate credentials, separate tools. A policy is a wish; an absent route is a fact.

**Turn on what the library already has.** [`authenticate`](/guide/security) pins a peer name to a credential so a claimed source cannot be forged, `authorize` sees every call with the caller's identity, declared [method semantics](/guide/commands) make "read but do not change" a machine-checkable distinction rather than a curated list, and `requireExplicitExposure` turns the `@rpc` marks into an allow-list. An unauthenticated bus is a fine choice on an isolated bench and a poor one anywhere an assistant can reach.

**Ask what it would reach before you connect it.** Not what you intend it to do — what the credential you are about to issue *could* do, across every peer that bus can address.

**Decide where the model runs.** Before the first useful answer, not after the first interesting question.

**Put repetition in the risk assessment.** For anything an agent can reach: what happens if this is done twice, deliberately, or a hundred times in a minute.

## What is coming

The design work for a per-node AI capability model — provenance carried in issued credentials, four explicit grants for tool-driven and program-driven writes and programming, sponsorship so that issuing an AI credential is itself a permissioned act, leases that expire, and a console panel that shows and opens all of it — is specified in [the AI boundary design](https://github.com/source-repo/rpc/blob/main/notes/ai-boundary/source-rpc-ai-boundary-design-spec.md) and is not yet implemented. This page describes what changes and what to do about it now; that document describes where the enforcement is going. Nothing on this page depends on it shipping.

## What this page is not

It is not a safety document, and none of this is a safety mechanism.

**No safety function depends on Source RPC or on AI, and AI-reachable systems must have no route to safety-engineering interfaces.** Human safety belongs to the functional-safety tier — hardware with its own processor, its own program-change credentials, its own black-channel communication and rated logic — a tier this software neither implements nor touches. Everything above is security and operational integrity: it reduces the chance of an unpleasant surprise, and it is not what anybody's safety should rest on.

Within that boundary, an assistant remains genuinely useful and is meant to be used. It can inspect, explain, diagnose, model, simulate, and draft changes for a human to review. What it must not become is the thing a person's safety depends on.
