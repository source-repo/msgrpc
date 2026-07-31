# @source-repo/queue

The first tool node: a lease-based work queue over Source RPC, on its own version line, built against the library's public APIs only.

```
npm install @source-repo/queue
```

- **Every-value semantics** — work that must not be lost: leases with fencing tokens, acquire-ID replay for uncertain outcomes, retries into dead letters with a paged admin surface, and reject-new-only capacity.
- **At least once, said plainly** — a handler may run more than once; task IDs and lease tokens protect queue state, not arbitrary external side effects.
- **Transport-neutral** — the same program over in-process, socket.io and MQTT 5; the transport never shows through the contract.
- **Tasks carry context** — captured snapshots travel verbatim; `latest` tasks resolve the source host's context when execution starts, and an unresolvable `latest` dead-letters rather than running context-blind.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/queue/README.md). On npm: [@source-repo/queue](https://www.npmjs.com/package/@source-repo/queue).
