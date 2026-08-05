# @source-repo/sparkplug

Sparkplug B integration for Source RPC networks.

This package is the open substrate for projecting selected Source RPC components as standard Sparkplug Edge Nodes, Devices and metrics. It starts with the protocol/session machinery the projection needs: the vendored Sparkplug B protobuf definition, topic helpers, birth/death payload builders and the Edge Node session sequence discipline.

The commercial product and tools around this will be named Source Spark. This package stays the open mechanism.

## Status

Early M1/M2 substrate. It can encode Sparkplug payloads, publish a minimal Edge Node NBIRTH/NDEATH over MQTT, answer `Node Control/Rebirth` NCMD by republishing NBIRTH, observe retained/live Primary Host `STATE`, validate basic Host-side lifecycle rules and project a small read-only value shape into Node metrics with NDATA-by-diff. No live Source RPC component subscription yet, no ingestion yet, and no command mapping yet.

## First milestone

- vendored `sparkplug_b.proto`
- committed generated TypeScript protobuf descriptors
- protobuf encode/decode helpers for the M1 metric types
- TypeScript substrate for topics, sequence numbers and birth/death payloads
- MQTT Edge Node session shell with clean session, NDEATH Will, NBIRTH publish, NCMD rebirth handling, Primary Host `STATE` observation and graceful NDEATH close
- tests for topic validation, `seq` wrap, `bdSeq` reuse, broker-backed NBIRTH/NDEATH delivery, broker-backed `Node Control/Rebirth`, retained/live Host `STATE`, graceful reconnect `bdSeq` advance and ungraceful Will delivery
- first Host-side validator for NBIRTH/NDEATH ordering, `bdSeq`, rebirth `seq` and retained lifecycle message checks
- first read-only Node metric projection helper: explicit paths to Sparkplug metrics, initial NBIRTH metrics and changed-only NDATA

The next step is wiring the projection helper to a live Source RPC component channel, then adding Device-level DBIRTH/DDATA.
