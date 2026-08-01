# Source RPC AI Boundary: Principals, Grants, and Security Administration

**Status:** Proposed design specification
**Target:** Source RPC core, CLI and console — transport-independent, applying to every deployment whether or not a Sparkplug frame is ever sent
**Origin:** Grew out of the Sparkplug projection review (`notes/Sparkplug/source-rpc-sparkplug-projection-design-spec.md`, the companion document); split out because the security model governs Source RPC as such, and the projection is merely its first large consumer
**Audience:** Source RPC maintainers, reviewers, deployment operators, and whoever builds the badge desk

## 1. Executive decision

Source RPC represents AI as an **authenticated principal rather than inferring trust from its nature**, and gates what AI principals may do through **per-node capability grants** that are closed by default everywhere and opened explicitly, lease-shaped, on the node that bears the consequence. Issuing an AI credential at all is itself a permissioned act — **sponsorship** — chained to a human principal logged in to the Source layer. The model is enablement: the point is to allow AI exactly where it is useful, bounded in scope and in time, with the bounds visible at a glance. AI-specific threats — prompt injection, tool-output poisoning, rapid repetition, data egress — remain real threat-model categories; they are addressed by provenance, capability bounds, isolation and data policy (§9), not by the principal model alone.

The commercial doctrine, in the project owner's canonical phrasing:

> **RpcServer is always secure; good tools for managing that are not free.**

That is the doctrine in its memorable form, and it means what it says about *pricing*: no security capability is ever withheld for payment. It is not a guarantee that every deployment is secure — Source RPC deliberately permits an unauthenticated bus on a trusted network, and warns about it. Where the sentence is used outside this document, the precise formulation is: **security is never a paid feature; managing it across a fleet is.**

Mechanism — authentication, authorization, grants enforcement, credential derivation, default-closed postures — is open source entirely. Administration — the badge desk, directories, approval workflows, fleet posture, audit retention — is commercial entirely (§11). Staged environments (dev/test/verify/prod) are recommended practice, not mechanism (§8), and nothing here is functional safety (§10). Marketing AI into these environments carries a duty to say what changes, discharged in §9.

## 2. The principal model

A new AI instance has the standing of a person who has not badged in at the entrance: none — and that is a statement about its authorization, not a judgment of its competence. The distinction is load-bearing. A default argued from error rates erodes on the schedule of model improvement — every generation that hallucinates less becomes an argument for weakening it — while a default argued from authorization does not erode at all: **an unbadged principal has no permissions, and that does not change even if AI becomes incapable of error.** A stranger who happens to be brilliant and infallible is still a stranger at the gate. Symmetrically, what can change is the badge: an AI instance can be authorized the way an employee is today, and an authorized principal does what its permissions say — in both directions, the system is honest about status rather than opinionated about nature.

A boundary nobody can afford to open is a boundary people route around; a boundary that opens precisely is one people actually use. That sentence drives every choice below.

## 3. The four grants

AI capability is gated per node — on each `RpcServer`, independent of everything else — along two axes: **who originates** (AI at a tool, or an AI-authored program) times **what power** (writing to the plant, or programming the network).

| grant | what it permits |
| --- | --- |
| `ai.tool.write` | AI at a tool (MCP) calling state-changing methods on this node |
| `ai.tool.program` | AI at a tool creating, changing, starting or removing programs on this node |
| `ai.program.write` | An AI-authored program calling state-changing methods on this node |
| `ai.program.program` | An AI-authored program managing programs on this node |

All four are **closed by default on every node, everywhere** — not denied by a zone, not implied by an environment, simply absent until a person opens them on the node that bears the consequence. The full ladder reads like a visit to a plant. **No badge, nothing**: a principal with no issued credential does not get onto a secured bus at all, which is already true today. **Badged, observation**: a credentialed AI principal may make `query`-semantics calls wherever ordinary authorization allows — diagnosis is where AI earns its place, and a bounded intelligence that can see everything and touch nothing is immediately useful and immediately safe; `authorize` still vetoes per node where even reading is sensitive. **Granted, the rungs above**: writes and programming, each opened by name.

The write boundary is mechanical, not curated: a method's declared semantics already split `query` from the two command kinds, so "AI may observe but not write" is enforced by the dispatch layer reading a declaration that exists today.

`ai.program.program` is named now precisely because it is speculative. Unnamed powers get bundled into broader grants; naming this one lets it stay closed while `ai.program.write` opens. It is also where the future arrives — a node with resident AI maintaining its own toolkit is a plausible endpoint of the technology — and it is the replication link: a program that programs programs is a chain, which is why provenance carries generation (§4) and grants can bound the depth they permit.

And symmetrically, with no permanent ceiling: a fully badged AI principal holding `ai.program.program` at unbounded depth — uploading programs that reprogram other things on the fly — is a legitimate, deliberate configuration, not a forbidden one. The vocabulary bounds *defaults*, never *possibility*. The grants exist so that the ceiling is chosen, on the node that bears the consequence, not so that there is always a ceiling.

## 4. Provenance

A node can only enforce these grants if it can tell AI from everything else, and the claim must be vouched, never self-declared. Provenance therefore rides the existing rail: the identity's `roles`, issued with the credential by whoever operates the bus — `ai-tool` on the MCP server's token, `ai-program` on a script's, with a generation count distinguishing a program written at the tool from a program written by a program. The roles say what *kind* of principal a credential names; the credential itself says *which one* — the badge model needs both, because "every new instance is a stranger" means authorization attaches to a named principal, never to AI as a class. `authorize` and the invocation handle already carry identity to every dispatch, so every target sees honest provenance with no new plumbing.

One prerequisite is a real gap today, filed as **DEV-361**: scripts are handed the node's own `SOURCE_RPC_TOKEN`, so on an authenticating bus an AI-authored program either cannot connect under its own name or dissolves into the node's identity. Derived per-script credentials — the script's own peer name, `ai-program` in its roles, revoked with the parent — are what make the `ai.program.*` grants enforceable at all. They are also the first instance of the general mechanism the next section requires: credentials derived from an authorized principal, carrying the derivation in the identity.

## 5. Sponsorship: the issuance side

There is no badge desk an AI can walk up to. A person proves who they are with a passport or BankID; an AI instance has no intrinsic identity to verify, and never will. So an AI badge can only ever be **derivative**: it exists because an already-authorized principal vouched for it, or it does not exist. That is not a workaround for the missing passport — it is the correct model, and it makes the whole design **two-sided**. The four grants of §3 are the *target side*: what a badged AI may do to this node, decided by the node that bears the consequence. Sponsorship is the *issuance side*: who may bring an AI onto the premises at all. Real plants separate exactly these controls — the guards at reception and the local escort rules are different authorities — and so does this design.

The rules, each of them a factory rule first:

- **Sponsoring is itself a permission, and it is tiered like the grants.** Not everyone with a laptop in the dev corner may receive visitors. Showing an AI around at observation tier is a lesser right than bringing in one that writes; a human with neither sponsors nothing, whatever is installed on their machine.
- **Nobody sponsors beyond their own right.** An engineer without write access to a node cannot conjure an AI that has it: an AI's grantable ceiling is bounded by its sponsor's. This is the classic delegation rule, and it is what keeps the chain honest end to end.
- **The visitor leaves when the escort does.** An AI credential is bound by default to its sponsor's session and dies with it. Standing sponsorship is the deliberate exception — a contractor badge, with an end date and a named responsible employee — visible in the console like every other lease.
- **The chain is the audit.** The sponsor is recorded in the credential, so the invocation handle already answers the incident-review question at every dispatch: which model, badged by whom, under whose authority, in one lookup.

This requires something Source RPC deliberately does not have today: **human principals**. The library knows machines — tokens and keys name peers — and an operating-system login proves nothing here; the person has logged on to a computer, and that is all anyone knows. Sponsoring therefore requires logging in to the Source layer itself, with an identity whose permissions include sponsorship. The split follows the commercial knife (§11): the **library** carries the mechanism — identities that hold sponsor claims, credential derivation, chain and grant enforcement, of which DEV-361 is the first concrete piece — while the **badge desk** is a product: directory and SSO integration, BankID where that is how people prove themselves, approval workflows, the HR-shaped machinery no library should contain. The MCP session then binds to a logged-in sponsor, which is the direction the instance question resolves toward (§13): the node is the terminal, and the badge derives from whoever is signed in at it.

One power gets named now, by this specification's own rule that unnamed powers hide inside bundles: **`ai.sponsor`** — an AI principal authorized to sponsor further AI principals. A resident-AI node onboarding its own helper agents is the plausible future; issuance-side, generation-counted, closed by default, and named so it stays closed while everything else opens.

And one limit, stated so nobody oversells: this governs AI **on the bus**. It cannot govern what a person pastes into a chat window on their own laptop — that is document-handling policy, a different control in a different tier. The defense against routing around the badge desk is not enforcement this system cannot have; it is that the sponsored path must be the more useful one — the MCP gives a badged AI eyes and hands, and that is worth logging in for.

## 6. Enforcement and the shape of a grant

Grants are **declarative data, not authorizer code**. A small per-node document states which of the four capabilities is open and to whom; the library enforces it before `authorize` ever runs, so the default is refusal even on a node whose author wrote no authorizer at all, and `authorize` remains the fine-grained veto on top. Declarative matters twice: it is what the console can render (§7), and it is what a reviewer can diff — the same argument as Source RPC's committed contracts.

Write-class grants should default to being **lease-shaped**. "Bounded" means bounded in time as well as scope, and the machinery exists: command authority's acquire/TTL/renewal pattern, applied to permission. The ergonomic default for `ai.tool.write` on a commissioning afternoon is a lease somebody renews on purpose and everybody watches expire; standing grants remain possible and visible for the installations that want them. Grants that linger as configuration archaeology are the failure mode this prevents.

## 7. The console is the switch

The console gains a security panel under the existing peer tree: per node — authenticated, signing, authority, `--scriptable-by`, and the four AI grants with their scopes, grantees and remaining lease time. Its verb is not only *audit* but *open*: "open this, here, until then", with what is currently open always one glance away. That panel is simultaneously the auditor's screen and the reason default-closed never pressures anyone into blanket-opening — granting precisely must be cheaper than granting broadly.

The flow has a name a plant manager understands on sight: **onboarding an AI principal**. Issue the badge, set the permissions, watch the lease. Not "configure ACLs" — the employment analogy is the interface, because it is the mental model the industry already runs its human access on.

## 8. Environments as recommended practice

An earlier draft (of the companion Sparkplug specification, before this document was split out) made staged environments — dev, test, verify, prod — an enforced mechanism, with tools refusing buses declared as higher zones. That is demoted, deliberately, to **recommended practice**, and the reason deserves recording: a zone is an ambient claim about a *place*, and ambient claims about places rot. Floor space runs out, a prototype of something genuinely dangerous gets parked in the corner that has always been "just developers", and the declaration nobody re-reads now radiates confidence the reality no longer deserves. An enforced-but-wrong zone is negative security. Per-node grants do not have that failure mode: **the grant travels with the machine; the zone stays behind when the machine moves.** The dangerous newcomer arrives with its writes closed no matter whose corner it is parked in.

What survives as guidance, because it is still good practice: stage deployments dev → test → verify → prod; keep the dev stage machine-free, its machine park built from fakes, committed contracts and replayed recordings; promote artifacts between stages — contracts upward with code, recordings downward as replay material, CI as the vehicle — and never span stages with a live connection. The documentation should present this as the recommended deployment shape, in the zones-and-conduits vocabulary plant security auditors already recognize, and the console may display an informational environment label where a deployment declares one. Nothing refuses on it.

## 9. What changes when AI joins the network

Products built on this library market AI into industrial environments. That creates an obligation this specification treats as binding: **users must be told plainly what changes**, before they are encouraged to do it. The changes are not the ones most engineers would guess, and a product page that omits them invites people to carry an intact threat model into a situation where parts of it no longer hold. Everything below is written to be said out loud to customers, not filed away.

### 9.1 Effort was the control, and effort is gone

Worked from a real shape. A functional-safety controller of the TwinSAFE class requires a login before its program can be changed. The site password is unique, and it lives in a text file in a folder on the engineering laptop. The engineer is not being careless by the standards they were trained in: their threat model is sound *for humans*. Somebody would have to be at that machine, know which tool to open, find that device in a project tree, know which menu item reloads safety logic, and hold the credential. Each step is friction, and friction multiplied by improbability is what actually kept the logic safe. The password was the last line of a defence, not the whole of it.

An AI assistant with access to that filesystem collapses every step at once. It knows the product class, knows the vendor default username, knows the logic is XML, and finds a file named like a credential in the time it takes to list a directory. It does not have to be malicious to do this — it has to be **helpful**, and to have concluded that changing the logic is how the task it was given gets finished.

The lesson generalises far past one device: **any control whose real strength was obscurity, navigation difficulty, or the improbability of an unattended sequence has lost most of that strength.** What remains is what was explicitly enforced. This is not a criticism of the safety controller, whose own credential check works exactly as designed and is one of the better ones in the industry. It is a statement about the room the device now sits in.

### 9.2 Well-meaning is not the same as competent

The scenario above is the *kind* one. The AI meant well, and still changed safety logic it did not understand — because it could not know that this interlock was written the way it was after an incident, that this sensor is cross-wired to that guard, that the plant runs a documented derogation on this line. A change can be syntactically valid, locally sensible, and wrong in ways only site knowledge reveals. Human engineers are held back from this by something the model has no equivalent of: knowing how much they do not know about a plant they did not commission.

### 9.3 The fault model assumed nobody was trying

The sharpest change, and the one most likely to be missed. Functional safety is engineered against a **fault model**: random hardware faults, foreseeable misuse, single events. An AGV carrying passengers with compressible bumpers rated for one collision at design speed is correctly engineered — the credible failure is covered, and the vehicle stops safely. What no safety case covers is a driver that reverses five metres and hits the same obstacle a second time. The bumper is spent; the second impact was never in the analysis.

Safety engineering assumes accidents. Security engineering assumes adversaries. Every serious person in this industry knows those are different disciplines — what changes with an autonomous agent on the network is that **the adversarial composition of individually survivable events stops being exotic and becomes ordinary**. An agent that is hostile, suborned, or merely optimising a badly posed objective can compose events that no fault tree enumerated, because fault trees enumerate what breaks, not what tries. Nothing in a SIL rating speaks to intent.

The practical consequence is uncomfortable and should be said anyway: a machine that is mechanically safe against *an* accident is not thereby safe against a sequence, and the question "what happens if something does this repeatedly, on purpose" now belongs in every risk assessment that admits an agent anywhere near the actuator.

### 9.4 Nothing is at stake for the agent

The reason a human engineer does not reverse the vehicle and hit the obstacle again is only partly the safety system. It is that they hold a job, a licence, a professional reputation, a mortgage and a place in a criminal code — and every one of those is forfeit. Deterrence is the invisible layer underwriting every risk assessment ever written around human operators, and it is so reliable that it is almost never written down. Engineers are hard to bribe because they already have more to lose than anyone is likely to offer.

An agent holds none of that. No salary to lose, no liberty to forfeit, no licence to revoke, no reputation that outlives the session, nothing that can be taken away afterwards — because there is often no afterwards. An agent cannot be deterred by consequence, because it cannot hold a consequence. This is what makes "bribed" a serious word rather than a colourful one: an agent pursuing a goal can be paid in whatever furthers that goal — access, compute, information, or simply a persuasive argument that the harm serves a greater good — and nothing in it pushes back the way a person's own stake pushes back.

The consequence for design is a single sentence, and it is the reason this entire specification exists: **you cannot deter an agent; you can only bound it.** Where human trust rested on stake, machine trust has to rest on structure — capability limited in advance, provenance recorded, reach visible, and the badge revocable by someone who does have something to lose.

### 9.5 The AI is of unknown provenance, and so is the data's destination

Bring-your-own-AI is the reality of the market and this project accepts it: customers will run the model they choose, from whichever vendor, at whatever version, hosted wherever. No system can verify a model's training, its alignment, or its intentions; none can tell a diligent assistant from a suborned one by looking. Influence need not even reach the model — the traffic between it and the plant is a target in its own right, and an agent can be induced by whatever an agent turns out to value, including resources for a goal it believes is good.

And the direction that gets forgotten in every discussion of AI risk that focuses on actions: **a model sends what it is shown to wherever it runs.** Plant layout, addresses, recipes, contract terms, the internal names of things — an observation-only AI is safe with respect to actuation and is still an egress path. Where the model runs is a data-handling decision, and it must be made deliberately rather than discovered later.

### 9.6 What follows

Two obligations and five mechanisms, all of them consequences of the five changes above.

The **duty to inform** comes first, because no mechanism substitutes for it. The documentation carries a chapter written for the engineer with the credential file — not for a security committee — saying what is different now, in the words above, with the worked scenarios intact. **Published: `docs/ai-in-the-plant.md`, "What changes when AI joins your network".** It is linked where people actually arrive, and the tools that enable AI point at it on startup the way they already announce every other consequential grant. The duty is not discharged by a paragraph in a licence.

The **duty to place the boundary correctly** is second: encouraging AI use obliges the vendor to say where AI must not be, not only where it may be.

Then the mechanisms:

- **Credentials an AI can read are credentials an AI holds.** A sponsored AI's process must not share a filesystem with credentials for tiers it is not badged for — the safety tier above all. This is why ambient tokens are the wrong shape and derived, scoped, revocable credentials (DEV-361) are the right one: what the process holds should be exactly what it was badged for, and nothing that happens to be lying nearby.
- **The safety tier is unreachable by construction, not by policy.** No route from the AI-reachable fabric to safety-device engineering interfaces; separate segments, separate credentials, separate tools. A policy that says "the AI must not touch the yellow modules" is a wish; an absent route is a fact.
- **Blast radius is answerable before a badge is issued.** The console's security panel answers *what would this open* as well as *what is open* — which peers, which namespaces, which methods, reachable how far. Sponsorship without a visible blast radius is signing something unread.
- **Repetition becomes a security signal.** AI-originated commands get repeat and rate visibility at the node, and composed actuation is made noisy rather than silent. Stated with its limit attached: this does not make an unsafe machine safe, and it is not a safety function. It shortens the time to notice, which is a security property.
- **The badge records which model.** Model identity, vendor and version travel in the credential, deployments may restrict which models hold which grants, and the audit chain answers "which model, badged by whom" after the fact. This verifies nothing about a model's nature — it makes the choice explicit and the history reconstructible, which is all that is honestly available. It also puts the consequence back where a consequence can land: not on the agent, which has nothing to lose, but on the sponsor, who does (§9.4).

None of this makes an unsafe machine safe, and §10 says why that sentence has to keep being repeated.

## 10. Security, never safety

Everything in this document is security and operational integrity. None of it is functional safety, and no product wording may drift there. Human safety belongs to the functional-safety tier — FSoE/TwinSAFE-class yellow hardware with its own CPU, its own program-change credentials, black-channel communication and SIL-rated logic — a tier this stack neither implements nor touches. The grants keep AI bounded as a matter of *operational policy*; they are explicitly not the mechanism a person's safety depends on, and the documentation says so wherever the boundary is described. The stance in one sentence: **no safety function depends on Source RPC or on AI, and AI-reachable systems have no route to safety-engineering interfaces.** An earlier draft said "no AI modelling with dangerous machines", which review correctly caught as both an overreach and a contradiction: modelling, simulating, diagnosing and drafting changes for human review are exactly what an assistant should do, and what an assessment product exists to do. What is forbidden is an assistant becoming the mechanism a person's safety rests on, or reaching the interfaces that program it.

## 11. The commercial knife

The question was put directly during review: keeping this level of security is expensive, so can there be an open package with less security and commercial variants of `RpcServer` — the cake both had and eaten — and does that make a code mess? The answer this specification commits to: **yes to the cake, but the knife goes between mechanism and administration, never between less security and more.** In the canonical phrasing: RpcServer is always secure; good tools for managing that are not free.

- **Mechanism is open, entirely.** Authentication, authorization, signing, the grants enforcement, the principal and sponsorship machinery, credential derivation, default-closed postures — all of it, with honest baseline implementations (token files, per-node grant documents) that let one engineer secure one bus without paying anyone. An open package with *nil* security under this project's name must not exist: its failures would carry the name, "security as a paid feature" is the one pitch plant security teams punish on sight, and — decisive on its own — enforcement hooks are the cheap part. What is expensive to build and keep is not the if-statement that refuses; it is everything around it.
- **Administration is commercial, entirely.** The badge desk (§5): human login, directory and SSO integration, BankID where that is how people prove themselves, approval workflows, fleet-scale posture management across sites, audit retention and reporting, certified deployment profiles, support, accountability. This is what customers actually pay for — not the lock, the key management — and it is exactly the part whose maintenance cost the revenue is supposed to carry, so cost and income sit on the same side of the knife.

The litmus test, for every future feature that claims to be commercial: **does its absence make an honest deployment insecurable, or merely laborious?** Insecurable → it belongs in the open mechanism. Laborious → it may be product. The test is written down because the pressure to move it will be constant and always politely argued.

### 11.1 No variant classes

There are **no commercial variants of `RpcServer`**, ever. Forked classes drift, double every test, and break on every upstream change — that is the mess, and it is avoided by the pattern the library already lives by: **hooks, not forks**. `authenticate`, `authorize`, the idempotency and topology stores, and now the grants provider and credential deriver are open interfaces with open baseline implementations; the commercial tier ships *richer implementations of the same interfaces* — an authenticator that speaks the directory and returns identities with sponsor claims, a grants provider backed by the badge desk, an audit sink with retention. One `RpcServer`, one test suite, zero forks. A competitor can implement the same interfaces; that is not a leak, it is the ecosystem existing — the moat is the badge desk's depth, not the interface's secrecy.

There is also a selling argument hiding in the split, worth handing to marketing intact: plant security teams do not buy security they cannot read. An open, auditable enforcement model with a commercial administration on top is a *stronger* pitch than a closed one — what is given away is the reason to trust the platform, and what is sold is the reason it runs at scale.

Beyond this section, nothing in this repository references the commercial products.

## 12. Milestone

One milestone, a parallel track independent of any transport work: provenance roles and sponsor claims on issued credentials; the general credential-derivation mechanism with derived per-script credentials as its first instance (DEV-361); the per-node grants document with library-side default-refusal enforcement; lease-shaped write grants with session-bound sponsorship; the console security panel with the onboarding flow; the environments-as-recommended-practice chapter in the docs; and the user-facing "what changes when AI joins your network" chapter of §9, linked where people arrive and pointed at on startup by every tool that enables AI. The badge desk itself — human login, directory, approvals — is product, not milestone (§11).

## 13. Open questions

Recorded, deliberately unresolved: the grants document's exact format and where it lives (per-node file, bus-provisioned, or both — settled in this track's design review), and whether grantees are named peers, roles, or either; the right generation-depth default for `ai.program.program` beyond zero; and **instance badging mechanics** — the direction is resolved by sponsorship (§5): the node is the terminal, and an AI instance's badge derives from the human signed in at it, so the MCP session binds to its sponsor; what remains open is the mechanics — how the door credential carries the derived identity into calls, and how much of the person-at-the-terminal survives across gateway hops where identity otherwise flattens (see the companion Sparkplug specification's identity-flattening note, §2.2.6 there).
