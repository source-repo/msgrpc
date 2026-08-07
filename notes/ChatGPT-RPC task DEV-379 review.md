# RPC task review

**User:** Anonymous  
**Created:** 8/7/2026 13:14:41  
**Updated:** 8/7/2026 14:00:45  
**Exported:** 8/7/2026 14:05:39  
**Link:** [https://chatgpt.com/c/6a75be20-85cc-83eb-8559-885df9f44667](https://chatgpt.com/c/6a75be20-85cc-83eb-8559-885df9f44667)  

## Response:
8/7/2026, 1:14:41 PM

I’ll review this as a protocol, security, and operability question, focusing on whether discovery needs an address at all or can avoid inbound connectivity entirely.

Two additional points emerged: discovery ultimately depends on network topology, and the task appears internally inconsistent about whether the commissioning key is permanent or single-use.

> **Reviewing the design**
>
> I’m identifying the main protocol decision and a key inconsistency: the key is described as long-lived, but acceptance says single-use. I’ll compare discovery approaches and ground the recommendation in the provided architecture.
>
> **Reviewed the design**
>
> 
>
> **Searching RFC 6763 DNS-Based Service Discovery unicast DNS service discovery mDNS local link**
>
>
> **Recommending rendezvous discovery**
>
> I’m recommending outbound rendezvous: the node contacts a configured enrollment endpoint, while the console submits the label’s identifier and commissioning secret. Both sides authenticate, avoiding mDNS, address scanning, inbound access, and reliance on knowing the node’s DHCP address.
>
> **Recommended rendezvous discovery**
>
> 
>
> **Refining commissioning semantics**
>
> I’m tightening the protocol: keep the printed key reusable across commissioning epochs, but make each exchange nonce- and window-bound. I’m also allowing exactly one authenticated claim, using outbound rendezvous and atomic commit to prevent partial configuration.
>
> **Refined commissioning semantics**
>
> 
>
> **Searching the web**
>
>
> **Balancing discovery tradeoffs**
>
> I’m framing discovery as a fundamental rendezvous problem: one endpoint needs a known destination. For isolated plants, I’d prefer managed unicast service discovery or a configured enrollment endpoint over mDNS, while keeping authentication separate from locating the node.
>
> **Balanced discovery tradeoffs**
>
> 
>
> **Searched 16 websites**
>
> 
>
> Worked for 5m 30s

## Review

The task is fundamentally sound. It correctly separates two bootstrap products:

- the Source RPC peer identity and task file; and
- the transport credentials needed before the node can use MQTT at all.

That separation is important because the MQTT bus cannot deliver the credentials required to reach the MQTT bus. The document also correctly concludes that enrolment needs a narrow commissioning path, separate from normal RPC scripting. `Pasted markdown.md`

The remaining discovery problem is real, but it exposes a deeper architectural issue: **the current design has the connection in the wrong direction**.

The text currently says that the node opens a listener and the console connects directly to it. `Pasted markdown.md` That creates several operational problems at once:

- the console must know the node’s current IP address;
- the console needs routed inbound access to that address and port;
- host firewalls must permit the commissioning listener;
- ordinary TLS hostname validation becomes awkward because the target is a DHCP address;
- browser-to-private-host networking creates further deployment complications.

The label did not really create all of those problems. It merely made the direct-connect assumption visible.

## Recommended answer: invert the setup channel

**The node should establish an outbound commissioning connection to a known enrolment service. The console should claim the node through that connection rather than connect to the node’s DHCP address.**

The resulting flow would be:

```text
Bare node
   │
   │ outbound TLS/WSS
   ▼
Source RPC enrolment service / console backend
   ▲
   │ claim by device ID + commissioning key
   │
Local browser console
```

The label carries:

```text
device ID
commissioning secret
possibly a product/model identifier
```

It does not need to carry the node’s address.

When commissioning mode opens, the node connects outward to the enrolment service and publishes only a pending-device record containing approximately:

```ts
interface PendingEnrolment {
  deviceId: string;
  sessionId: string;
  nodeNonce: string;
  ephemeralPublicKey: string;
  expiresAt: string;
  metadata?: {
    product?: string;
    version?: string;
  };
}
```

It must not send the label secret. The console operator scans or enters the label, and the console backend uses the secret to prove that it is entitled to claim that pending session. The commissioning secret can authenticate a transcript containing the device ID, both nonces, the ephemeral keys and the session ID.

After the proof succeeds, the existing design follows naturally:

1. The console backend sends the proposed task file and broker credentials.
2. The node validates the task file.
3. The node tries the supplied broker account without persisting it.
4. The node proves it can connect and participate using the proposed identity.
5. Both sides commit their task files atomically.
6. Commissioning closes.

This preserves the good existing requirement that the broker password be supplied from the console backend rather than exposed to the browser. `Pasted markdown.md`

It also removes the task’s claim that normal TLS cannot be used because no CA will issue a certificate for a DHCP address. That is only true when the console connects to the node. With an outbound connection, the node connects to a stable service hostname, so the enrolment backend can use an ordinary public or plant-CA certificate. The pairing secret then authenticates the particular node and console transaction; TLS protects the transport.

## How the bare node finds the enrolment service

There still has to be one stable piece of network knowledge somewhere. No discovery protocol can avoid the fundamental requirement that either:

- one endpoint knows the other endpoint;
- both know a common rendezvous service; or
- the network supplies discovery information.

For an industrial installation, I would use this ordered mechanism:

### 1. Explicit configured URL

Support an environment variable, service configuration field and command-line override:

```bash
SOURCE_RPC_ENROLMENT_URL=https://source-rpc-enrolment.site.example \
  source-rpc node
```

or:

```bash
source-rpc node \
  --enrolment-url https://source-rpc-enrolment.site.example
```

This is useful for containers, systemd units and sites with centrally managed deployment.

### 2. Unicast DNS-SD as the plant default

A bare node started without an explicit URL should look up a service such as:

```text
_source-rpc-enrolment._tcp.<site-domain>
```

The site domain comes from the host’s DHCP-provided DNS search list. The DNS record returns the stable hostname and port of the enrolment backend.

This is **DNS-SD over ordinary unicast DNS, not mDNS**. DNS-SD is defined using standard SRV and TXT records and can operate through conventional DNS infrastructure. ([IETF Datatracker](https://datatracker.ietf.org/doc/html/rfc6763?utm_source=chatgpt.com)) DHCP can provide the domain search list used to construct such lookups. ([IETF Datatracker](https://datatracker.ietf.org/doc/html/rfc3397?utm_source=chatgpt.com))

That matters because mDNS is intentionally link-local and does not normally work across routers; this is exactly why it is unreliable as the required mechanism between plant VLANs. ([IETF Datatracker](https://datatracker.ietf.org/doc/html/rfc6762?utm_source=chatgpt.com))

This gives plant IT one site-level setup operation rather than one discovery configuration per node:

```dns
_source-rpc-enrolment._tcp.plant.example.  SRV  0 0 443 rpc-console.plant.example.
```

Optionally, TXT records can advertise protocol version or path:

```dns
_source-rpc-enrolment._tcp.plant.example. TXT "version=1" "path=/commissioning"
```

### 3. mDNS only as a convenience fallback

mDNS can remain useful for:

- development;
- bench commissioning;
- flat networks;
- a console and node on the same VLAN.

It should not be required by the protocol or by the acceptance criteria.

### 4. Optional external rendezvous

A vendor-hosted rendezvous could provide zero-configuration discovery when outbound Internet access is available, but it should be optional. Many intended Source RPC installations will be isolated, restricted or explicitly prohibited from depending on a public service.

The rendezvous need not see enrolment contents. It can relay end-to-end-encrypted frames between a node session and a console claim. Nevertheless, dependence on it changes the product’s availability and privacy model, so I would not make it the industrial default.

## Suggested answer to the issue

> Agreed. The label gives us possession authentication, but it does not locate a DHCP host. I do not think the console should discover the node’s address at all.
>
> The setup connection should be reversed: while locally placed in commissioning mode, the bare node opens an outbound TLS/WebSocket connection to the Source RPC enrolment backend. It registers a pending session under its device ID, without sending the commissioning secret. The operator scans the label in the console, and the console backend claims that pending session by proving possession of the label secret.
>
> This removes the need for the console to know or reach the node’s DHCP address, avoids an inbound commissioning port through plant firewalls, and lets the setup channel use ordinary TLS to a stable console hostname.
>
> The node still has to locate the enrolment backend. The managed-plant default should be unicast DNS-SD, for example `_source-rpc-enrolment._tcp.<DHCP search domain>`, backed by an SRV record in plant DNS. That is normal routed DNS, not mDNS. An explicit `--enrolment-url` or environment setting is the override, and mDNS can remain an optional same-VLAN convenience.
>
> Where there is no plant DNS entry, no configured endpoint, no external rendezvous and no local way to enter an address, automatic discovery is impossible: neither side has enough information to initiate the connection. We should make that deployment requirement explicit rather than pretending mDNS can cover it.

## Important inconsistencies to fix in the task

### Static key versus single-use key

The body says that the decision is a stable, long-lived key protected by a locally opened commissioning state. It persists across restarts and can be reused after a deliberate local reopening. `Pasted markdown.md`

The acceptance criteria instead say:

> “The enrolment key is single-use, expires with the window…”

That describes the earlier generated-key design, not the selected label design. `Pasted markdown.md`

I would define two different objects:

- **Commissioning secret:** stable until explicit factory/reset action; printed on the label or equivalent.
- **Commissioning session:** fresh, short-lived and single-use each time the local gate opens.

The stable secret never expires merely because a five-minute window ends. The session nonce, ephemeral keys and proof do.

A revised criterion could say:

> The commissioning secret is stable until explicit reset and is accepted only while commissioning mode has been opened by local action. Every commissioning session has fresh nonces and ephemeral keys, expires with the commissioning window, and can complete at most once.

### Concurrent attempts

The current criterion says two parties attempting one window should cause both to be refused. `Pasted markdown.md` That permits an unauthenticated network client to deny enrolment merely by opening a competing connection.

A stronger rule is:

> Unauthenticated or invalid claims do not affect the session. The first successfully authenticated claim atomically locks the session. Subsequent claims are rejected. If two independently valid claims are detected before the lock is committed, the node closes the session and requires a new local commissioning action.

Only a party possessing the commissioning secret should be able to create an ambiguity that fails the session.

### “Print on demand” and no-shell nodes

The task says the software analogue of a factory label is to generate and print a secret on first run or on demand. `Pasted markdown.md` That works for a host where an installer initially has a terminal, but not for the stronger “no screen and no shell” case.

The task should distinguish:

- **software-host enrolment:** first-run output, package-generated label, deployment manifest or administrator-readable state;
- **appliance enrolment:** factory-applied label, local display or physical service interface.

For an ordinary remote Linux host, someone must initially obtain and preserve the generated secret. Completely unattended installation requires the deployment system to capture it or inject it securely.

## Revised discovery acceptance criteria

I would replace the current single discovery criterion-“the console can find a node that has just been powered on” `Pasted markdown.md`-with:

- A commissioning node initiates an outbound connection; the console is not required to reach an inbound listener on the node.
- The node supports an explicitly configured enrolment-service URL.
- Without an explicit URL, the node can discover the service through unicast DNS-SD in its DHCP-provided DNS search domains.
- mDNS may be supported for same-link convenience but is not required for successful plant deployment.
- The node does not publish its commissioning secret while registering a pending session.
- A console identifies a pending node by device ID and proves possession of the commissioning secret before any configuration is disclosed.
- The enrolment backend is authenticated using normal TLS or a configured plant trust anchor.
- The node’s DHCP address is diagnostic metadata only and is neither printed on the label nor required by the operator.
- Failure to locate an enrolment service produces a clear local log/event stating which discovery methods were attempted.
- Sites using automatic discovery must provide at least one of an explicit enrolment URL, a unicast DNS-SD record or an approved rendezvous service.

This makes the label design workable without importing consumer-network assumptions into the industrial deployment model.

---

**Sources:**

- [RFC 6763 - DNS-Based Service Discovery](https://datatracker.ietf.org/doc/html/rfc6763?utm_source=chatgpt.com)

## Prompt:
8/7/2026, 1:54:41 PM

About the service discovery when running in a local network instead of using the cloud server. The local network is a dev environment but wants to work like an air-gapped system by having it's own MQTT server etc. But it can reach the cloud server.  To make a kind of discovery possibly, to simplify working with all the local nodes, could I add a feature to the cloif: Set this sites enrollment server to not use the cloud but a specific local IP. So when a new node tries to dial home to the only URL it knows, the cloud server, it is told: Bugger off, use this local IP instead

## Response:
8/7/2026, 1:54:41 PM

Yes. For this hybrid development environment, that is probably cleaner than requiring DNS-SD or mDNS.

I would describe it as **cloud-assisted rendezvous**, not LAN discovery:

- Every bare node knows one permanent bootstrap URL.
- The cloud knows which enrolment authority is assigned to each site.
- For a cloud-managed site, the cloud handles enrolment.
- For a locally managed site, the cloud returns a signed instruction saying, in effect, “this site’s authority is at this LAN endpoint.”
- The node then performs the actual enrolment directly with the local server.

That resolves exactly the problem identified in the task: the label provides identity and possession evidence but no DHCP address. It also works better after reversing the connection direction-the node finds and connects to the authority rather than the console finding and connecting to the node. `Pasted markdown.md`

## Recommended flow

1. A new node enters commissioning mode through the required local action.
2. It connects over TLS to the fixed Source RPC cloud bootstrap endpoint.
3. It announces:
   - device ID;
   - protocol version;
   - fresh session nonce;
   - ephemeral public key;
   - optionally a pending-enrolment session ID.
4. The cloud determines which site this pending node belongs to.
5. The site is configured with a local enrolment authority, so the cloud returns a signed route descriptor.
6. The node verifies the descriptor and connects directly to the local enrolment server.
7. The local server verifies the node’s commissioning-key proof and completes enrolment.
8. MQTT credentials, task files and other site secrets travel only between the node and the local server. The cloud never sees them.

That preserves the important separation in the task: the MQTT account has to arrive over the setup channel because the node cannot receive credentials over a broker it cannot yet access. `Pasted markdown.md`

## Do not implement it as an ordinary HTTP redirect

A `302` or `307` to a private address sounds attractive, but I would return an explicit protocol object instead.

For example:

```ts
interface SignedEnrolmentRoute {
  version: 1;

  deviceId: string;
  requestNonce: string;

  siteId: string;
  authority: "local";

  endpoints: Array<{
    url: `https://${string}` | `wss://${string}`;
    priority: number;

    /**
     * Pin either the local server's TLS public key or a site CA.
     */
    serverSpkiSha256: string;
  }>;

  issuedAt: string;
  expiresAt: string;

  /**
   * Normally deny: a site configured for local enrolment should not
   * silently fall back to cloud enrolment.
   */
  fallback: "deny" | "cloud";

  /**
   * Optional signed authorization presented to the local server.
   */
  handoffToken?: string;

  cloudSignature: string;
}
```

An explicit descriptor is better because it can:

- authenticate the local server;
- bind the answer to the requesting device and nonce;
- expire;
- contain multiple endpoints;
- state the fallback policy;
- avoid forwarding cloud request headers, tokens or bodies to the LAN server;
- prevent arbitrary chains of redirects.

The node should accept only one signed bootstrap handoff, not behave as a general redirect-following HTTP client.

## The local server identity matters more than its IP

The cloud should not merely say:

```text
Use 192.168.20.15
```

It should say:

```text
For site X, use wss://192.168.20.15:7443/enrolment,
and expect this server public key.
```

Otherwise DHCP reassignment, an address typo or a malicious machine taking over the address could redirect enrolment.

For the TLS side, there are three reasonable options:

1. A certificate issued by the site’s private CA.
2. A self-signed certificate whose SPKI/public-key fingerprint is included in the signed cloud descriptor.
3. A separate Source RPC server identity key authenticated above the TLS layer.

For the development environment, the second is probably simplest. A public CA normally cannot provide a certificate for an RFC 1918 private IP, but a private CA or pinned self-signed certificate can.

I would also make the cloud setting an endpoint list rather than a single IP, even if the UI initially exposes one field:

```ts
interface SiteEnrolmentConfiguration {
  mode: "cloud" | "local";

  local?: {
    endpoints: Array<{
      url: string;
      serverSpkiSha256: string;
      priority: number;
    }>;

    fallback: "deny" | "cloud";
  };
}
```

That leaves room for:

- a local DNS name;
- IPv4 and IPv6 addresses;
- separate endpoints for different VLANs;
- migration to a new server;
- primary and standby enrolment servers.

## How the cloud determines the site

This part should not be based merely on the node’s public source IP. NAT, VPNs, changing addresses and multiple sites behind one gateway make that unreliable.

There are two good flows.

### Device assigned before startup

The operator scans or enters the node’s device ID in the cloud console and assigns it to a site. When the node calls home, the cloud immediately returns that site’s local authority.

### Device assigned after startup

The node first creates a pending bootstrap session in the cloud. The operator scans the label, selects the site and claims the pending device. The cloud then sends the local route back over the node’s pending connection or on its next poll.

The second flow fits the “start a bare node, then configure it from the console” experience particularly well. The cloud only matches a pending node to a site; possession of the commissioning secret is still proven to the local enrolment server. The cloud route is discovery, not authentication.

## Registering the local server

Rather than allowing an administrator to enter only an arbitrary IP address, I would register the local enrolment server with both its endpoint and identity.

A convenient flow is:

1. The local server generates a stable server identity key.
2. The administrator creates a one-time site registration token in the cloud.
3. The local server uses that token to register:
   - site ID;
   - LAN endpoint or endpoints;
   - server public key;
   - supported protocol versions.
4. The cloud stores the verified server identity.
5. The local server may maintain an outbound heartbeat so the cloud UI can show whether it has recently checked in.

The endpoint can still be edited manually, but the server key prevents a mistaken address from becoming a trusted authority.

## Cloud dependence and caching

This produces an air-gap-like runtime, but it is not truly air-gapped during initial bootstrap. That distinction should be explicit.

After the node has successfully reached and authenticated the local server, it should cache:

- the site ID;
- local endpoint list;
- local server identity;
- the signed route descriptor or equivalent trust state.

Normal Source RPC operation then uses only the local MQTT broker and local services. The cloud is not contacted during ordinary startup.

A sensible lookup policy would be:

```text
1. Use an already trusted local authority.
2. If there is no trusted local authority, contact the cloud bootstrap service.
3. If a cached local endpoint is unreachable, contact cloud for an updated route.
4. Never switch from local enrolment to cloud enrolment unless site policy explicitly permits it.
```

For a genuinely disconnected site, the same signed route descriptor could later be supplied through:

- a configuration file;
- a QR code;
- unicast DNS;
- installation media;
- a command-line option.

The cloud-assisted route therefore does not force a separate enrolment protocol.

## Security boundaries

The cloud response should be restricted in several ways:

- It must be signed by a key pinned in the node software.
- It must be bound to the node’s request nonce.
- It should preferably be bound to the device ID.
- It must have a limited validity period.
- It must specify the expected local server identity.
- The node must speak only the Source RPC enrolment protocol to the returned endpoint.
- It must not forward cloud credentials or authorization headers.
- It must not recursively follow further redirects.
- The cloud must not silently become the enrolment authority when a site is configured as locally authoritative.
- The local commissioning gate and label secret remain mandatory; knowing the local endpoint grants nothing by itself.

A signed handoff token can additionally let the local server verify that the cloud assigned this pending device to its site:

```ts
interface EnrolmentHandoffClaims {
  deviceId: string;
  siteId: string;
  localServerId: string;
  nodeSessionId: string;
  expiresAt: string;
}
```

The token does not need to contain the pairing secret, MQTT password or eventual Source RPC identity.

## Suggested answer for the issue

> Yes. For a development site that operates locally but can reach the cloud, the cloud endpoint can act as a rendezvous service rather than the enrolment authority.
>
> A bare node always contacts the one bootstrap URL compiled into it. The cloud looks up the site assigned to that node or pending enrolment session. When the site is configured for local enrolment, it returns a signed descriptor containing the local enrolment endpoint and the expected server public key. The node then connects directly to that LAN endpoint and performs the complete commissioning exchange locally.
>
> This should not be an ordinary HTTP redirect to an IP address. The response needs to be a Source RPC bootstrap message bound to the node’s nonce, signed by the cloud and containing the identity of the local server. Otherwise an incorrect or reassigned private address could become the enrolment authority.
>
> The cloud is used only to answer “where is this site’s authority?” It does not relay the setup exchange and never receives the broker password, task file or peer signing secrets. After the node has authenticated the local authority, it caches that authority and normal operation remains entirely on the site.
>
> Site selection should come from explicit device or pending-session assignment, not from the node’s public source IP. A site configured as locally authoritative should normally fail closed if its local server is unavailable rather than silently falling back to cloud enrolment.
>
> This is not true air-gapped discovery because a completely new node initially depends on the cloud rendezvous. The same signed local-authority descriptor can later also be supplied through configuration, DNS or offline media for genuinely disconnected installations.

So the friendly wire-level interpretation really can be: **“Bugger off-the cloud is not authoritative for this site. Here is the authenticated local server that is.”**



---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)