---
'@adcp/sdk': minor
---

fix(discovery): per-agent property resolution from adagents.json (#1721)

The TS SDK now honors the per-entry `authorization_type` + selector on
`authorized_agents[]` in `adagents.json`, matching the schema
(`schemas/cache/3.0.11/adagents.json`) and the Python SDK's
`_resolve_agent_properties`. Pre-fix, the TS SDK treated
`authorized_agents[]` as a presence list and attributed every
top-level property to every listed agent — giving different answers
than the Python SDK for the same input file.

### Bug

For the file shape called out in #1721:

```json
{
  "authorized_agents": [
    {"url": "https://wonderstruck.sales-agent.scope3.com", "authorized_for": "..."},
    {"url": "https://interchange.io", "authorized_for": "..."}
  ],
  "properties": [{"property_id": "main_site", "property_type": "website", ...}]
}
```

- Pre-fix TS SDK: both agents authorized for `main_site` (1 property each).
- Python SDK: both agents authorized for 0 properties (no `authorization_type`).
- JSON Schema: file is invalid (no `oneOf` variant matches).

The pre-fix TS behavior produced silently-divergent authorization
answers across SDKs. The fix makes the TS SDK fail closed when the
file omits `authorization_type` or its selector — same as Python.

### New public API

```ts
import {
  resolveAgentProperties,
  listAgentPropertyMap,
  canonicalizeAgentUrl,
  type AuthorizedAgent,
  type AuthorizationType,
  type AdAgentsPublisherPropertySelector,
} from '@adcp/sdk';

const scope = resolveAgentProperties(adAgents, 'https://agent.example/mcp');
if (scope.properties.length > 0) {
  // The agent is authorized for these top-level (or inline) properties.
}
if (scope.unresolvable) {
  // 'agent_not_listed' | 'missing_authorization_type' |
  // 'unknown_authorization_type' | 'missing_selector' | 'no_match' |
  // 'signals_only'
}
```

`resolveAgentProperties(adAgents, agentUrl)` dispatches on
`authorization_type`:

- `property_ids` → filter top-level `properties[]` by `property_id`
- `property_tags` → filter top-level `properties[]` by tag intersection
- `inline_properties` → return the agent entry's own `properties[]`
- `publisher_properties` → return cross-publisher selectors for the
  caller to resolve against other publishers' files
- `signal_ids` / `signal_tags` → no property output (signals agents)

`listAgentPropertyMap(adAgents)` returns
`{ byAgent, unresolved, cross_publisher }` so consumers can iterate
the full per-agent map.

`canonicalizeAgentUrl(url)` is exported for callers doing their own
per-agent matching (e.g., TMP `seller_agent_url` validation).
URL comparison follows the AdCP URL canonicalization rules — case,
default port, percent-encoded unreserved chars, and fragment all
normalized; userinfo, non-http(s) schemes rejected.

### Behavior changes

- `PropertyCrawler.crawlAgents()` now attributes properties per
  agent using `resolveAgentProperties`. Agents that don't appear in
  the publisher's `authorized_agents[]` (or whose entry is missing
  `authorization_type`/selector) get **zero** properties instead of
  the file's entire `properties[]`.
- `PropertyCrawler.fetchAdAgentsJson()` and `fetchPublisherProperties()`
  now also surface the raw parsed `AdAgentsJson` (alongside the
  normalized `properties`) so external callers can run the resolver
  themselves.
- Graceful-fallback unchanged: when a file has `authorized_agents` but
  no `properties` array (the crawler infers a default property), the
  inferred property is still attributed to every claiming agent. The
  fallback only fires for non-conformant files.

### Types

- `AuthorizedAgent` widened to expose `authorization_type` (required by
  schema; typed optional here for backward compat with pre-schema-3
  fixtures), `property_ids`, `property_tags`, `properties`,
  `publisher_properties`, `signal_ids`, `signal_tags`.
- New type `AdAgentsPublisherPropertySelector` — the `adagents.json`
  variant of `PublisherPropertySelector` (discriminated by
  `selection_type: 'all' | 'by_id' | 'by_tag'`). Exposed under a
  distinct name to avoid clobbering the existing registry-flat
  `PublisherPropertySelector`.
