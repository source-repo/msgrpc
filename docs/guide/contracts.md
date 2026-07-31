# Contracts and validation

Types are a compile-time promise between a client and a server that share a class. Nothing about MQTT or a browser page guarantees the caller is one of those — a Python historian or a Node-RED flow calling in over MQTT 5 shares none of your types — so a schema lets the server check what it was actually sent.

```typescript
const schema: RpcSchema = {
    schema: 1,
    namespaces: {
        plant: {
            version: '3',
            methods: {
                writeSetpoint: { params: [{ kind: 'number', min: 0, max: 2000 }], returns: { kind: 'number' } }
            }
        }
    }
}

const server = new RpcServer({ transports: [{ brokerurl }], schema })
```

A call that does not match is refused with `InvalidParams` before it reaches the method, and the message names the offending position: `argument 0: expected number, got string (this server serves plant@3)`.

`source-rpc extract` writes this file from your source rather than you writing it by hand. Note what it can and cannot see: `value: number` becomes `{ kind: 'number' }`, because a range like `0..2000` is a runtime invariant that TypeScript does not carry. Extraction gives you shape checking — types, arity, whether an argument is required. Bounds have to be added to the schema or expressed in the type.

The type language is small on purpose. It describes what MsgPack actually carries, so `bytes` (`Uint8Array`) and `date` are values rather than string encodings, and it is checkable without pulling a validation engine into a package that ships to browsers and embedded targets. `ref` names a shared or recursive type; nesting beyond 32 levels is refused rather than exhausting the stack.

The format itself is versioned by the exported `SCHEMA_VERSION`, carried as the `schema` field of every document and independent of the package version. What may be added without touching that number, what forces it up, and what a reader must tolerate or refuse is written down in [`docs/schema-compatibility.md`](https://github.com/source-repo/rpc/blob/main/docs/schema-compatibility.md) — the rules any package consuming these documents can rely on.

`object` describes a known shape and `record` an open one — `{ [tag: string]: Reading }`, which is how plant data usually arrives. A record checks every value against one type and leaves the keys open, or constrains them with `keyPattern`; `maxEntries` bounds it the way `maxItems` bounds an array, since a dictionary is the other shape a caller can grow without limit.

```typescript
readings: { params: [], returns: { kind: 'record', values: { kind: 'ref', name: 'Reading' } } }
```

| option | effect |
| --- | --- |
| `validation: 'described'` | check the namespaces the schema covers, let the rest through (default when a schema is given) |
| `validation: 'required'` | refuse anything the schema does not describe |
| `validation: 'off'` | disable checking without removing the schema |
| `validateResults` | check what handlers return too; off by default, since it is a self-check |

Set `validate: false` on a namespace to skip a hot path where the cost is not worth paying. Validating `writeSetpoint(number)` is not the same proposition as validating a ten-thousand element telemetry array on every publish.

### Serving older callers

Give a client the contract it was built against and it declares the version on every call:

```typescript
const client = new RpcClient(url, { schema: contractTheClientWasBuiltAgainst })
```

The server keeps earlier versions of a namespace under `history`, and compares the caller's contract with the one it now serves. It is a structural comparison, not an equality check, so a caller whose contract still holds keeps working and only a genuine incompatibility is refused — with `IncompatibleVersion` and the reason:

```
plant@1 is not compatible with plant@2: writeSetpoint argument 0 narrowed, so a value the
caller may send is no longer accepted
```

The rule is ordinary function subtyping. **Parameters are contravariant**: the current contract has to accept everything the old one allowed, so widening a parameter is safe and narrowing it is not. **Returns are covariant**: everything the current contract can return has to fit what the old caller expects, so narrowing a return is safe and widening it is not. Adding an optional field or an optional argument is safe; adding a required one is not. Events run the other way, since the server emits and the caller receives.

The comparison happens once per peer and version, not per call, and is conservative: where it cannot prove compatibility it reports incompatibility, since a false "safe" is the expensive direction.

A caller that declares nothing is simply not version-checked — only its arguments are. A caller declaring a version the server has no history for is allowed by default, since truncating history is a legitimate operational choice; `unknownVersion: 'reject'` refuses it instead.

`source-rpc check` runs the same comparison at build time, so a change that would refuse a deployed peer fails the build instead of surfacing when that peer next calls.

## Describing a server

A server can report what it exposes, so a peer or a person can find out without reading the source.

```typescript
const server = new RpcServer({ transports: [{ brokerurl }], exposeIntrospection: true })

const described = await (await client.proxy<Introspection>('msgrpc')).describe()
```

It reports each namespace with its class, its contract version, whether the instance was created at runtime, its methods with types when a schema describes them, and its events with how many peers are currently subscribed. `source-rpc console` renders this in a browser.

`describe` describes itself: the `msgrpc` namespace comes with its own contract, so a peer reading a server sees the type it will get back, and `validation: 'required'` does not refuse the one call made to find out what is there. Its named types are prefixed — `msgrpc.ServerDescription` — because the schema has one type map shared by every namespace, and a plant defining its own `TypeNode` should not find `describe()` described against it. A schema that already defines `msgrpc` is left untouched.

**Off by default, and subject to `authorize` like any other call.** Listing every class, method and live instance is reconnaissance, and instance names on a plant network tend to encode plant structure.

This is msgrpc's own shape rather than a borrowed one. OpenAPI is HTTP-shaped and cannot describe a server pushing events; AsyncAPI models everything as a channel, which fights an RPC surface. Either would mean describing this system in someone else's concepts.
