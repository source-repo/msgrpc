# Command authority

"A command completes before someone else modifies the state" has two levels, and serialised execution only solves the first. Across a sequence — read, decide, ramp, verify — an operator holds *authority*: the plant's arbitration concept, not a mutex. Local/remote, HMI-in-control, the teach pendant that owns the arm.

Any observable component can be held:

```typescript
const oven = await client.component<Oven>('oven', 'ovenServer')

const grant = await oven.$acquire(60_000)        // ttl in ms; a lease always expires
await oven.setMode('manual')                     // guarded methods now run for this peer
await oven.$release()
```

`$acquire` when free is a grant; by the current holder, a renewal that extends the lease; by anyone else, a refusal naming who is in control. `$acquire(ttl, { take: true })` is the break-in every plant panel has — atomic, visible, and a new generation — and who may use it is `authorize()`'s decision like every other call.

## Only declared methods are gated

```typescript
class Oven extends RpcComponent<OvenProps, OvenState> {
    @rpc({ semantics: 'idempotent-command', requiresAuthority: true })
    async setMode(mode: string) { ... }

    @rpc({ semantics: 'idempotent-command' })
    async stop() { ... }        // deliberately undeclared: never behind a held lease
}
```

That is the safety rule stated positively: an E-stop is written without the flag and is therefore *structurally* incapable of being blocked by a lease. Declaring `requiresAuthority` on a class that is not a component is refused at expose time — a safety-adjacent declaration that silently gates nothing would be the worst failure mode.

A call from a non-holder is refused with the `NotInControl` code, naming the holder — or saying "nobody is in control — $acquire it first". The check runs when the call arrives *and again after any queue wait*, because the wait is exactly where a takeover or an expiry lands.

## Visible to everyone

Who holds the unit rides every component snapshot as `authority: { holder?, expiresAt?, generation }` — readable state, not a secret. Every change — grant, renewal, takeover, release, expiry — emits `authorityChanged` on the component with a reason, because a snapshot can say who is in control now but not whether the last holder released or was expired out.

The `generation` counter moves on every grant, takeover, release and expiry — but **not** on a holder's renewal, so extending a lease never fences out the holder's own queued commands. It is the within-epoch cousin of the topology layer's durable `ownerEpoch`; for fencing a call on *that*, see [the owner fence](./topology.md#the-owner-fence).
