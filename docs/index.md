---
layout: home

hero:
    name: Source RPC
    text: One programming model for a network of peers
    tagline: A browser tab, a Node service, and a plant full of devices — over socket.io and MQTT 5. A class is the contract.
    actions:
        - theme: brand
          text: Get started
          link: /guide/getting-started
        - theme: alt
          text: GitHub
          link: https://github.com/source-repo/rpc

features:
    - title: Classes as contracts
      details: The server exposes a live instance; the client gets a typed proxy of the same class. No code generation, no schema files required — and a schema when you want arguments checked.
    - title: State, not polling
      details: A peer is as much what it holds as what it can be told to do. Components publish props and state as ordered snapshots; observers read them synchronously from a local cache, with a status that says whether the picture is still current — and a store shape that plugs straight into useSyncExternalStore.
    - title: Command semantics for machinery
      details: A method declares whether repeating it is free, harmless or dangerous. Callers can tell "did not run" from "may have run", and a durable idempotency hook makes a redelivered command run once.
    - title: Topology and context
      details: Every host answers for where its components sit — physically and logically — with durable epochs, an owner fence on calls, and inherited context resolved across hosts.
    - title: Two transports, one model
      details: socket.io for browsers and anything that dials out; MQTT 5 for the plant, with a documented wire format a plain MQTT.js peer can speak.
    - title: Self-describing networks
      details: Contracts are extracted from source and served at runtime. A console browses the live network, capabilities are found by qualified name, and an MCP server hands it all to an AI assistant.
---
