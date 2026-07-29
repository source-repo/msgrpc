# Deploying a network

From nothing to a plant network you can watch: a message bus, the peers on it, and a console in a browser.

The shape this ends in is the one the pieces were designed for — devices on an MQTT broker, screens on a WebSocket, and one console watching both because a peer is addressed by name rather than by which link it happens to be on.

```
   browser tab              browser tab
   hosting a service        running the console
            │                       │
            └───────────┬───────────┘
                        │  WebSocket (socket.io)
                  ┌─────┴──────┐
                  │    bus     │  :7843   relays; exposes nothing
                  └─────┬──────┘
                        │  MQTT 5
        ┌───────────────┼───────────────┐
        │               │               │
   plantServer       cellSrv         ovenSrv
```

## The quickest whole thing

```
echo "CONSOLE_TOKEN=$(openssl rand -hex 32)" > docker-compose/.env
docker compose -f docker-compose/network.yml up -d
open http://localhost:7844
```

That is an MQTT broker, a bus, and a console watching both. Everything below is what those three services are doing and how to change it.

## Do you need a bus at all?

If every peer can reach one MQTT broker, no. The broker is the bus, presence comes from retained messages, and Source RPC adds nothing you have to run.

You need one when something cannot speak MQTT or cannot listen — a browser tab above all, which can do neither. `source-rpc broker` gives those peers what MQTT would have given them: addressing by name, presence, and the ability for any peer to call any other.

```
source-rpc broker                       # :7843, relays for whoever connects
```

There is no separate broker implementation and there should not be: it is an `RpcServer` that exposes nothing and forwards everything. Two of them joined with `--upstream` become one network, with loop handling — a peer is never advertised back down the link it arrived on, and frames carry a hop count.

## Ports

| | |
| --- | --- |
| `1883` / `8083` | MQTT, and MQTT over WebSocket |
| `7843` | Source RPC — an `RpcServer`, or `source-rpc broker` |
| `7844` | anything serving a browser, such as `source-rpc console` |
| `8843` / `8844` | the same two, with TLS |

Deliberately clear of the 80xx range, where the rest of a developer's work already lives. **One process needs one port** — the console serves its page and its RPC on the same listener — so the second number is for running a bus and a console on one host, which is the ordinary case.

Given `--cert` and `--key`, the CLI moves itself to the 88xx pair without being told. A thousand above rather than adjacent, so no firewall range can open a clear-text port while meaning to publish only the encrypted one.

## Authenticate the bus before you expose it

Without `--auth`, the broker relays for anything that can reach the port and every peer name on it is an unchecked claim. It says so on startup.

```json
{
  "token": "the-one-this-broker-presents-upstream",
  "tokens": {
    "3f9a…": "plantServer",
    "c710…": { "name": "hmi", "roles": ["operator"] }
  }
}
```

```
source-rpc broker --auth /run/secrets/bus.json
source-rpc broker plantBus on port 7843, authenticating
```

One token per peer, not one for the bus — the reasoning is in [the security model](security-model.md#tokens-one-per-peer). Each peer presents its token as `credentials`, and its `name` must be the one that token was issued for.

## In containers

The image's entrypoint is the CLI itself, so one image is whichever command it is given:

```
docker run -d -p 7843:7843 \
    -e SOURCE_RPC_TOKENS='{"3f9a…":"plantServer"}' \
    ghcr.io/source-repo/rpc-cli                       # no command: the default is broker

docker run --rm -e SOURCE_RPC_TOKEN=3f9a… ghcr.io/source-repo/rpc-cli \
    peers --hub http://bus:7843 --name plantServer    # any other command, same image
```

`--auth` takes a path and is right for a mounted secret; `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS` say the same two things and are right for a compose file. Neither is ever a command-line flag, because `ps` is readable by everyone on the box.

The image does **not** enable `--allow-exec` or `--scripts`. Both run code that did not come from your repository and are development-machine features.

It also does not contain what they would need. There are two images:

| | |
| --- | --- |
| `ghcr.io/source-repo/rpc-cli` | what this page is about. No package manager, no interpreter — nothing a bus has any use for. Zero fixable critical or high vulnerabilities. |
| `ghcr.io/source-repo/rpc-cli:dev` | the same CLI with `npm` and `python3`, for a development machine running `--scripts` or Python handlers |

`latest` points at the first, so pulling without thinking gets the one meant for a plant. The development image carries npm's bundled dependencies and their advisories; that is the trade it exists to make, and it is why the two are separate rather than one image with everything in it.

## The console

```
source-rpc console --broker mqtt://localhost:1883 --hub http://bus:7843
```

One list covers both networks, and each peer is called over the link it was found on. Discovery costs nothing — every peer announces itself, so there is no scan and no configured host list.

Two things to get right when publishing it:

**`--host`.** The default `127.0.0.1` is not reachable from outside a container, and `0.0.0.0` means anything that can reach the published port can call whatever the console is allowed to call. Publish the port to loopback, or put an authenticating proxy in front. The compose file does the former.

**Behind a reverse proxy**, the page works out where it was served from, so a stripping rule needs no configuration at either end:

```nginx
location /tools/console/ {
    proxy_pass http://console:7844/;      # trailing slashes on both lines
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Both paths must end in `/`, and the `Upgrade` headers are what let socket.io leave long polling for a WebSocket. For a proxy that forwards the prefix instead of stripping it, tell the console where it lives with `--base-path /tools/console`.

## Watching a network that is already misbehaving

The tap is armed by a call rather than a flag, because a bus that has to be restarted before it can be watched will not be watched — the run worth looking at is the one already going wrong.

```
source-rpc call plantBus bus.tap '{"peer":"plantServer","payloads":true}' --hub http://bus:7843
source-rpc watch plantBus bus.frame --hub http://bus:7843
```

It pairs a call to its reply and reports the method and the latency, neither of which is in the reply itself. `source-rpc record` writes the same stream to a file, which `replay` can then send at a replacement device.

## Before it is a plant

- **Pin versions.** The image tags are exact, minor and major; a bus and the peers talking to it should be pinned together on purpose.
- **Rebuild sometimes.** The published image is scanned weekly and the release blocks on anything fixable, but a published image is frozen at the day it was built. Since the Dockerfile floats on its base tag and runs `apk upgrade`, re-running the release build is usually the whole of the fix.
- **`source-rpc check` in CI**, so a contract change that would refuse a deployed caller fails a build instead of a plant.
- **`source-rpc check --peer`** against the real device after a firmware update, which compares what the box actually serves against the contract callers were built against.
- **TLS with your own CA** rather than `--insecure-tls`. See [the security model](security-model.md#tls).
- **Read the limits.** Delivery is at least once unless a durable idempotency store guards the method, and relaying is not brokering — nothing is queued for a peer that is not connected.
