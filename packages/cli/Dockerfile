# Source RPC tooling in a container: a bus, a console, an MCP server or a recorder, depending on
# what it is asked to run.
#
# It installs the published package rather than building the repository, so it needs no build
# context and `docker build -<Dockerfile` works from anywhere. The version is an argument because a
# bus and the peers talking to it should be pinned together on purpose.
#
# Two targets, because the CLI is two things. `runtime` is the default and is what goes near a
# plant: the commands that are infrastructure, and nothing else in the image. `dev` is the same CLI
# with the tools its development features actually need - npm for `add_package`, python3 for a fake
# whose handlers are Python. Neither of those belongs on a bus, and leaving them out of `runtime` is
# most of why it scans clean.
#
#   docker build -t rpc-cli packages/cli                      # runtime, the default
#   docker build -t rpc-cli:dev --target dev packages/cli

# The active LTS line rather than the maintenance one, because that is where security fixes land
# first. Deliberately a floating major: every release rebuild then picks up the current patch, which
# is worth more against known CVEs than the reproducibility a pinned digest would buy - the version
# that actually shipped is recorded in the image label either way.
#
# Node 24 also runs TypeScript directly, which is what lets `--scripts` serve a `.ts` file with no
# build step.
FROM node:24-alpine AS base

# `apk upgrade` because the base image is only as patched as the day it was published, and most of
# what a scanner finds against a week-old tag is already fixed upstream.
ARG VERSION=3.1.0
RUN apk upgrade --no-cache \
    && npm install -g @source-repo/rpc-cli@${VERSION} \
    && npm cache clean --force

# 7843 the bus (`rpc`), 7844 the console's web port (`console`). The plaintext pair on purpose: a
# container usually sits behind something that has already terminated TLS. Given --cert and --key
# the CLI moves itself to 8843/8844 (`rpc-tls`, `console-tls`), which then need publishing instead.
# All EXPOSE only - documentation for `docker run`, not a hole in anything.
EXPOSE 7843 7844

# The entrypoint is the whole CLI, so this one image is `broker`, `console`, `mcp`, `record` and the
# rest: `docker run … console --hub http://bus:7843 --host 0.0.0.0`. broker is the default because
# it is the one that is infrastructure rather than a tool someone is holding.
ENTRYPOINT ["source-rpc"]
CMD ["broker"]

# ----------------------------------------------------------------------------------------------
# The image for a development machine: the CLI plus what its development features need.
#
# npm stays, because `--scripts` lets a model install a dependency for a script and that is the
# whole point of the tool. python3 is here for the same reason: `--allow-exec` accepts a fake whose
# handlers are a Python program, and without an interpreter that half simply does not run.
#
# Neither flag is enabled here. This image *can* do those things when asked; it does not offer them
# by default, and a container started with no flags behaves exactly like the runtime one.
#
# It carries npm's own bundled dependencies - tar, undici, brace-expansion - and therefore inherits
# every advisory against them. That is the trade this target exists to make, and it is why the two
# are separate rather than one image with everything in it.
FROM base AS dev

RUN apk add --no-cache python3

LABEL org.opencontainers.image.source="https://github.com/source-repo/rpc" \
      org.opencontainers.image.url="https://github.com/source-repo/rpc" \
      org.opencontainers.image.documentation="https://github.com/source-repo/rpc/tree/main/packages/cli#readme" \
      org.opencontainers.image.title="Source RPC CLI (development)" \
      org.opencontainers.image.description="Source RPC CLI with npm and python3, for --scripts and --allow-exec. Development machines only; use the untagged image on a plant." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

# Root is not needed to bind 7843, and a relay reachable by anything on the network is exactly the
# process that should not be running as root when it is.
#
# `add_package` installs into the scripts directory rather than globally, so what has to be writable
# is the mount, not the image: bind a host directory here and it needs to be writable by uid 1000.
USER node

# ----------------------------------------------------------------------------------------------
# The default target: what goes near a plant.
FROM base AS runtime

# npm goes. It is a build-time tool - nothing at runtime shells out to it, and the CLI is already
# installed by the time it is removed. Keeping it means shipping its bundled dependencies and
# inheriting every advisory against them, none of which this image is in a position to use. This is
# the difference between a scan that is clean and a scan full of findings nobody can act on.
#
# The features that would want it - `--scripts`, and Python handlers - are what `dev` is for.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /root/.npm

# `source` is the one that does the work: GitHub Packages links an image to a repository by this
# label and nothing else, and an unlinked package page shows no README, no licence and no way back
# to the source. The rest are what a registry lists the image by.
LABEL org.opencontainers.image.source="https://github.com/source-repo/rpc" \
      org.opencontainers.image.url="https://github.com/source-repo/rpc" \
      org.opencontainers.image.documentation="https://github.com/source-repo/rpc/tree/main/packages/cli#readme" \
      org.opencontainers.image.title="Source RPC CLI" \
      org.opencontainers.image.description="A Source RPC bus, browser console, MCP server or traffic recorder - whichever command it is given." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

USER node
