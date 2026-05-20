---
'@adcp/sdk': minor
---

feat(discovery): `fetchAgentAuthorizationsFromDirectory` for AAO inverse-lookup (#1885 part 2)

Adopts AdCP spec PR [adcontextprotocol/adcp#4828](https://github.com/adcontextprotocol/adcp/pull/4828) ([issue #4823](https://github.com/adcontextprotocol/adcp/issues/4823)). Given an `agent_url`, fetch the set of publishers whose `adagents.json` authorizes it from an AAO-compatible directory via `GET /v1/agents/{agent_url}/publishers`. Part 2 of #1885; Part 1 (inline resolution) shipped separately as #1891.

**API**

```ts
import { fetchAgentAuthorizationsFromDirectory } from '@adcp/sdk';

for await (const publisher of fetchAgentAuthorizationsFromDirectory(myAgentUrl, {
  directoryUrl: 'https://aao.example.com',
  status: ['authorized'],
})) {
  console.log(publisher.publisher_domain, publisher.properties_authorized);
}
```

The returned iterator transparently pages — consumers iterate `DirectoryPublisherEntry` values without managing cursors. A `.toArray()` convenience drains the iterator for small directories.

**Options:** `directoryUrl` (required), `since`, `status`, `cursor`, `limit`, `timeoutMs`, `userAgent`, `signal`.

**Trust model.** The directory is discovery, not authorization. Each `DirectoryPublisherEntry` tells the operator which publisher's `adagents.json` to verify directly via the SDK's per-domain primitives. The publisher's own file remains the trust root; `properties_authorized` / `status` are operator-facing summaries.

**Defensive parsing.** Counterparty-controlled response fields are validated per the AAO `agent-publishers.json` schema; malformed publisher entries are dropped (witness, not translator). HTTP 4xx/5xx and non-JSON-object responses surface as errors.

**SSRF safety.** Outbound HTTP routes through the SDK's existing `ssrfSafeFetch` — private IPs, link-local, loopback, and metadata-service hosts are refused. Adopters with internal directories enable internal probes via the SDK's probe policy.

**No default `directoryUrl`.** The SDK does not default to a canonical AAO host — directory choice is an operator trust decision. Adopters explicitly opt into a specific directory.

**New public exports:**

- `fetchAgentAuthorizationsFromDirectory(agentUrl, options)`
- `DirectoryPublisherEntry`, `DirectoryLookupPage`, `FetchAgentAuthorizationsOptions`, `AgentAuthorizationsIterator`, `DirectoryDiscoveryMethod`, `DirectoryPublisherStatus` types

**References:**

- Spec issue: [adcontextprotocol/adcp#4823](https://github.com/adcontextprotocol/adcp/issues/4823)
- Spec PR: [adcontextprotocol/adcp#4828](https://github.com/adcontextprotocol/adcp/pull/4828)
- Schema: [`agent-publishers.json`](https://github.com/adcontextprotocol/adcp/blob/main/static/schemas/source/aao/agent-publishers.json)
- Companion PR (Part 1, merged): #1891
