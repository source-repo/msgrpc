# Source RPC AI Boundary: Principals, Grants, and Security Administration

**Status:** Proposed design specification
**Target:** Source RPC core, CLI and console — transport-independent, applying to every deployment whether or not a Sparkplug frame is ever sent
**Origin:** Grew out of the Sparkplug projection review (`notes/Sparkplug/source-rpc-sparkplug-projection-design-spec.md`, the companion document); split out because the security model governs Source RPC as such, and the projection is merely its first large consumer
**Audience:** Source RPC maintainers, reviewers, deployment operators, and whoever builds the badge desk

## 1. Executive decision

Source RPC treats AI as a **principal, never as a threat category**, and gates what AI principals may do through **per-node capability grants** that are closed by default everywhere and opened explicitly, lease-shaped, on the node that bears the consequence. Issuing an AI credential at all is itself a permissioned act — **sponsorship** — chained to a human principal logged in to the Source layer. The model is enablement: the point is to allow AI exactly where it is useful, bounded in scope and in time, with the bounds visible at a glance.

The commercial doctrine, in the project owner's canonical phrasing:

> **RpcServer is always secure; good tools for managing that are not free.**

Mechanism — authentication, authorization, grants enforcement, credential derivation, default-closed postures — is open source entirely. Administration — the badge desk, directories, approval workflows, fleet posture, audit retention — is commercial entirely (§10). Staged environments (dev/test/verify/prod) are recommended practice, not mechanism (§8), and nothing here is functional safety (§9).

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

This requires something Source RPC deliberately does not have today: **human principals**. The library knows machines — tokens and keys name peers — and an operating-system login proves nothing here; the person has logged on to a computer, and that is all anyone knows. Sponsoring therefore requires logging in to the Source layer itself, with an identity whose permissions include sponsorship. The split follows the commercial knife (§10): the **library** carries the mechanism — identities that hold sponsor claims, credential derivation, chain and grant enforcement, of which DEV-361 is the first concrete piece — while the **badge desk** is a product: directory and SSO integration, BankID where that is how people prove themselves, approval workflows, the HR-shaped machinery no library should contain. The MCP session then binds to a logged-in sponsor, which is the direction the instance question resolves toward (§12): the node is the terminal, and the badge derives from whoever is signed in at it.

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

## 9. Security, never safety

Everything in this document is security and operational integrity. None of it is functional safety, and no product wording may drift there. Human safety belongs to the functional-safety tier — FSoE/TwinSAFE-class yellow hardware with its own CPU, its own program-change credentials, black-channel communication and SIL-rated logic — a tier this stack neither implements nor touches. The grants keep AI bounded as a matter of *operational policy*; they are explicitly not the mechanism a person's safety depends on, and the documentation says so wherever the boundary is described. The stance in one sentence: **no AI modelling with dangerous machines — and even that line is not what safety relies on.**

## 10. The commercial knife

The question was put directly during review: keeping this level of security is expensive, so can there be an open package with less security and commercial variants of `RpcServer` — the cake both had and eaten — and does that make a code mess? The answer this specification commits to: **yes to the cake, but the knife goes between mechanism and administration, never between less security and more.** In the canonical phrasing: RpcServer is always secure; good tools for managing that are not free.

- **Mechanism is open, entirely.** Authentication, authorization, signing, the grants enforcement, the principal and sponsorship machinery, credential derivation, default-closed postures — all of it, with honest baseline implementations (token files, per-node grant documents) that let one engineer secure one bus without paying anyone. An open package with *nil* security under this project's name must not exist: its failures would carry the name, "security as a paid feature" is the one pitch plant security teams punish on sight, and — decisive on its own — enforcement hooks are the cheap part. What is expensive to build and keep is not the if-statement that refuses; it is everything around it.
- **Administration is commercial, entirely.** The badge desk (§5): human login, directory and SSO integration, BankID where that is how people prove themselves, approval workflows, fleet-scale posture management across sites, audit retention and reporting, certified deployment profiles, support, accountability. This is what customers actually pay for — not the lock, the key management — and it is exactly the part whose maintenance cost the revenue is supposed to carry, so cost and income sit on the same side of the knife.

The litmus test, for every future feature that claims to be commercial: **does its absence make an honest deployment insecurable, or merely laborious?** Insecurable → it belongs in the open mechanism. Laborious → it may be product. The test is written down because the pressure to move it will be constant and always politely argued.

### 10.1 No variant classes

There are **no commercial variants of `RpcServer`**, ever. Forked classes drift, double every test, and break on every upstream change — that is the mess, and it is avoided by the pattern the library already lives by: **hooks, not forks**. `authenticate`, `authorize`, the idempotency and topology stores, and now the grants provider and credential deriver are open interfaces with open baseline implementations; the commercial tier ships *richer implementations of the same interfaces* — an authenticator that speaks the directory and returns identities with sponsor claims, a grants provider backed by the badge desk, an audit sink with retention. One `RpcServer`, one test suite, zero forks. A competitor can implement the same interfaces; that is not a leak, it is the ecosystem existing — the moat is the badge desk's depth, not the interface's secrecy.

There is also a selling argument hiding in the split, worth handing to marketing intact: plant security teams do not buy security they cannot read. An open, auditable enforcement model with a commercial administration on top is a *stronger* pitch than a closed one — what is given away is the reason to trust the platform, and what is sold is the reason it runs at scale.

Beyond this section, nothing in this repository references the commercial products.

## 11. Milestone

One milestone, a parallel track independent of any transport work: provenance roles and sponsor claims on issued credentials; the general credential-derivation mechanism with derived per-script credentials as its first instance (DEV-361); the per-node grants document with library-side default-refusal enforcement; lease-shaped write grants with session-bound sponsorship; the console security panel with the onboarding flow; and the environments-as-recommended-practice chapter in the docs. The badge desk itself — human login, directory, approvals — is product, not milestone (§10).

## 12. Open questions

Recorded, deliberately unresolved: the grants document's exact format and where it lives (per-node file, bus-provisioned, or both — settled in this track's design review), and whether grantees are named peers, roles, or either; the right generation-depth default for `ai.program.program` beyond zero; and **instance badging mechanics** — the direction is resolved by sponsorship (§5): the node is the terminal, and an AI instance's badge derives from the human signed in at it, so the MCP session binds to its sponsor; what remains open is the mechanics — how the door credential carries the derived identity into calls, and how much of the person-at-the-terminal survives across gateway hops where identity otherwise flattens (see the companion Sparkplug specification's identity-flattening note, §2.2.6 there).
