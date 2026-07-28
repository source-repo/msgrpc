# msgrpc

TypeScript RPC over WebSocket and MQTT, using classes as contracts shared by client and server.

| package | |
| --- | --- |
| [`packages/msgrpc`](packages/msgrpc) | the library — start here |
| [`packages/cli`](packages/cli) | extracts a contract from TypeScript source and checks it for breaking changes |

[`docs/mqtt5-frame-spec.md`](docs/mqtt5-frame-spec.md) describes the MQTT 5 wire format.

```
npm install          # installs both workspaces
npm run build
npm test             # the MQTT tests need a broker; see packages/msgrpc/README.md
```
