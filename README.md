# Source RPC

TypeScript RPC over socket.io and MQTT 5, using classes as contracts shared by client and server.

| package | |
| --- | --- |
| [`packages/rpc`](packages/rpc) | the library — start here |
| [`packages/cli`](packages/cli) | `source-rpc`: extract a contract, check it against a build or a live device, and browse, tap, fake, record and bench a network |

The packages and the command changed name in 3.0; **the protocol did not**. Topic
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

Source RPC listens on **7843** (`rpc`), and anything of its serving a browser on **7844**
(`console`) — adjacent, and clear of the 80xx range where everything else on a developer's machine
already is. One process needs one of them: a page and its RPC share a listener.

With a certificate they become **8843** (`rpc-tls`) and **8844** (`console-tls`): a thousand above
rather than beside, so no firewall range can open a clear-text port while meaning to publish only
the encrypted one. `source-rpc broker --cert … --key …` moves itself there without being told.

```
docker compose -f docker-compose/docker-compose.yml up -d   # the MQTT broker the tests need
docker compose -f docker-compose/network.yml up -d          # a whole network: MQTT, a bus, a console
```

The CLI is also an image — `ghcr.io/source-repo/rpc-cli` — whose entrypoint is the command itself,
so one image is the bus, the console, the MCP server or the recorder depending on what it is asked
to run.
