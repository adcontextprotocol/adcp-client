---
'@adcp/sdk': minor
---

feat(discovery): `validateAdAgents` with ads.txt `MANAGERDOMAIN` one-hop fallback (#1717)

Implements RFC 4175 / adcontextprotocol/adcp#4175 — new public
`validateAdAgents(publisherDomain, options?)` helper that resolves a
publisher's `adagents.json` via:

1. Canonical: `https://{publisher}/.well-known/adagents.json` (direct).
2. Pointer indirection: if the canonical file carries
   `authoritative_location` (and no inline `authorized_agents`), follow
   one redirect — reports `discovery_method: 'authoritative_location'`.
3. On HTTP **404 only** — parse `https://{publisher}/ads.txt` for a
   `MANAGERDOMAIN=` directive and attempt
   `https://{managerdomain}/.well-known/adagents.json` — reports
   `discovery_method: 'ads_txt_managerdomain'` and populates
   `manager_domain`.

Per the #4173 resolution of the RFC's open questions:

- Only the IAB directive form `MANAGERDOMAIN=example.com` counts; the
  comment form `# managerdomain=example.com` is rejected.
- Duplicate `MANAGERDOMAIN` lines: **last-wins** (rather than the RFC's
  fail-closed default — IAB-aligned).

Other safety rules carry through from the RFC:

- Fallback fires only on HTTP 404. 5xx / timeouts / invalid JSON / SSRF
  refusals stay terminal on the direct path.
- One hop only — the manager-domain file is never recursed into.
- `publisher → publisher` cycles are rejected.
- `#noagents` trailing comment on a `MANAGERDOMAIN` line excludes that
  entry from fallback discovery (publisher-side opt-out).
- Manager-domain failure (404, parse error, SSRF refusal) is a terminal
  validation failure, never a silent pass.

### New public API

```ts
import { validateAdAgents, type DiscoveryMethod, type AdAgentsValidationResult } from '@adcp/sdk';

const result = await validateAdAgents('publisher.example');
if (result.valid) {
  console.log(result.discovery_method, result.manager_domain, result.adagents);
}
```

Exports added from `@adcp/sdk`:

- `validateAdAgents(domain, options?)` — main entrypoint.
- `parseManagerDomain(adsTxt)` — directive-only parser, exported for
  direct unit testing and adopters who want to consume MANAGERDOMAIN
  outside the validator.
- Types: `DiscoveryMethod`, `AdAgentsValidationResult`,
  `ValidateAdAgentsOptions`.

Routes through `ssrfSafeFetch` for DNS-pin / SSRF-policy defense (same
posture as `PropertyCrawler` and `NetworkConsistencyChecker` post-#1633).
