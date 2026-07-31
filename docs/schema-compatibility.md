# The schema format, and what may change in it

The schema is the format everything else reads: the `.types.json` files that `extract` writes and `check` polices, the answer `describe()` serves, the contract `serve` stands a fake up from, and the input every ecosystem package consumes. It is versioned by `SCHEMA_VERSION` in `packages/rpc/src/RPC/Schema.ts`, carried as the `schema` field of every document — **independently of the package version**, because a document does not care which npm release wrote it and its readers span packages that release on their own cadences.

This document is the policy for that number. Change `SCHEMA_VERSION` only with this file open, and extend the format only within the rules below.

## What a consumer may assume

A document with `schema: 1` parses according to the types exported from `@source-repo/rpc`: `RpcSchema`, `NamespaceSchema`, `MethodSchema`, `TypeNode` and their relatives. Two obligations come with reading it:

**Unknown optional fields must be ignored, never refused.** The format evolves additively within one version, so a document written by a newer library may carry fields an older reader has no name for. Skipping them is correct; rejecting the document is not.

**An unknown `schema` number must be refused, never guessed at.** A reader that does not know the number does not know the rules the document was written under, and a best-effort parse of a contract is a contract check that silently checks nothing. Refuse with the number named, so the operator learns "this tool is older than this document" instead of a mystery.

## What is additive - no bump

- A new **optional field** on any record: the document root, a namespace, a method, an event, a type field. Readers ignore what they do not know.
- A new **optional section** at any level, under the same rule - `component` on a namespace is the precedent.
- A new **`semantics` value**. A reader that meets one it does not know treats the method as *undeclared*, which the format already defines as "ask before pressing this" - the safe reading is the default reading.
- New **attributes on existing fields** that refine rather than redefine - a `designation` beside a type, a bound beside a number - provided their absence means what it meant before.

## What forces a bump

- Removing or renaming any field, or changing what an existing field means.
- Changing a field's type, including widening one - a reader validating against the old type would refuse valid new documents.
- **A new `TypeNode` kind.** This is the sharp one: a validator that meets a kind it does not know cannot check values against it, and treating it as `any` would silently turn checking off for exactly the values somebody bothered to describe. A new kind is a new format.
- Changing the meaning of validation itself - what `min`/`max` bound, how optionality reads, how unions match.

## The two versions, kept apart

`schema` is the **format** version - this document's subject. `version` on a namespace or document is the **contract** version - the plant's own statement about its API, compared by `check` and declared by callers. They never move together: a plant revising its pump contract bumps `version`; only a change to the shape of the description itself touches `schema`.

## When a bump happens

Writers write the new number. Readers refuse numbers they do not know, per the rule above. A reader that understands several numbers accepts them all and says which it read. Migration tooling between numbers is out of scope until a second number exists - designing conversion for a format that has never changed is how formats grow speculative fields.

## Who reads this format

`extract`, `check`, `conform`, `serve`, the console, the MCP server - and every ecosystem package, starting with the work-queue node, whose contracts are written and checked in this format. That external audience is why the policy exists: inside one repository a format survives on folklore, and the first consumer outside it is why the folklore is now written down.
