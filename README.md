# Source RPC

TypeScript RPC over socket.io and MQTT 5, using classes as contracts shared by client and server.

| package | |
| --- | --- |
| [`packages/rpc`](packages/rpc) | the library — start here |
| [`packages/cli`](packages/cli) | `source-rpc`: extract a contract, check it against a build or a live device, and browse, tap, fake, record and bench a network |

Formerly `msgrpc`. The packages and the command changed name in 3.0; **the protocol did not**. Topic
prefixes are still `msgrpc/v1` and `msgrpc/v2`, introspection is still the `msgrpc` namespace, and
MQTT 5 user properties still carry the `mr-` prefix — renaming those would strand every deployed
peer for no engineering gain.

[`docs/mqtt5-frame-spec.md`](docs/mqtt5-frame-spec.md) describes the MQTT 5 wire format.
[`CHANGELOG.md`](CHANGELOG.md) covers the 2.0.0 rework and what breaks.

```
npm install          # installs both workspaces
npm run build
npm test             # the MQTT tests need a broker; see packages/rpc/README.md
```
