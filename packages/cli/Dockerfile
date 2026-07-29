# Source RPC tooling in a container: a bus, a console, an MCP server or a recorder, depending on
# what it is asked to run.
#
# It installs the published package rather than building the repository, so it needs no build
# context and `docker build -<Dockerfile` works from anywhere. The version is an argument because a
# bus and the peers talking to it should be pinned together on purpose.
FROM node:22-alpine

ARG VERSION=3.0.0
RUN npm install -g @source-repo/rpc-cli@${VERSION} && npm cache clean --force

# Root is not needed to bind 7843, and a relay that can be reached by anything on the network is
# exactly the process that should not be running as root when it is.
USER node

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
