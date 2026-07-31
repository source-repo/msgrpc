# @source-repo/rpc

The library: classes as contracts over socket.io and MQTT 5, with the machinery a plant needs and a browser tolerates.

```
npm install @source-repo/rpc
```

- **Command semantics** — `query`, `idempotent-command`, `non-repeatable-command` declared on the contract; graded execution defaults, a bounded mailbox, conflation for setpoint-shaped commands, and a durable idempotency hook.
- **Observable components** — `RpcComponent<Props, State>` with cached snapshots, epoch/revision ordering, per-channel `initializing | live | stale | closed`, and a store that plugs into `useSyncExternalStore`.
- **Command authority** — `$acquire`/`$release`, the plant's arbitration concept: granted, visible in every snapshot, always expiring, with only declared methods ever gated.
- **Topology** — every host answers for its components' `parent` and `owner` with durable epochs, CAS mutations, and an owner fence on calls (`$with({ ownerEpoch })`).
- **Structural context** — `defineRpcContext` tokens resolved through one declared axis, across hosts, with atomic remounts and bounded, explicit capture.
- **Security** — per-connection authentication, per-frame signing (HMAC or Ed25519), `authorize()` on every call and subscription, TLS with a plant's own CA.

Full documentation: [the guide](../guide/getting-started.md) and the [CHANGELOG](https://github.com/source-repo/rpc/blob/main/CHANGELOG.md). On npm: [@source-repo/rpc](https://www.npmjs.com/package/@source-repo/rpc).
