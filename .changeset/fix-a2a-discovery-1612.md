---
"@adcp/sdk": patch
---

fix(cli/discovery): three compounding A2A timeout bugs (#1612)

Investigation of the original #1612 symptom against
`wonderstruck.sales-agent.scope3.com` (`storyboard run … --transport a2a`
hanging at 307s+) found three independent bugs whose interaction produced
the observed wall-clock:

1. **`--transport` flag was silently dropped.** CLI accepted only
   `--protocol`. The original repro and many users use `--transport`
   (A2A SDK convention). Now accepted as an alias; explicit `--protocol`
   wins on conflict.

2. **`detectProtocol` returned `'mcp'` on any non-200 response from the
   well-known A2A card path** — including 5xx, 401, 403, 429, and network
   timeouts. A host that returns 503 on `/.well-known/agent.json` is far
   more likely to be A2A-with-an-unhealthy-card than MCP-at-root. New
   classification: 5xx/401/403/429/network-error → A2A suspect, only 4xx
   (other than auth/rate) and clean miss → MCP fallback.

3. **`discoverAgentProfile` had no AbortSignal awareness.** When the SDK
   was misled into trying MCP discovery against a non-MCP root, the
   internal `getAgentInfo()` call could spin past comply()'s timeout
   (we observed 425s of orphaned MCP retries). `comply()` now passes its
   combined timeout/external signal to `discoverAgentProfile`, which
   races the underlying transport calls so the comply pipeline unblocks
   on abort. The orphaned in-flight transport request still resolves in
   the background; the fix bounds caller-visible latency, not the
   transport's own retry budget.

**Empirical verification against Wonderstruck**:

| Invocation | Before | After |
|---|---|---|
| `--transport a2a` (typo for `--protocol`) | 425s | 31s |
| bare URL auto-detect | 425s | 41s |
| `--protocol mcp` against `/mcp` | 60.8s | 31s |

These three fixes are independent — each addresses a distinct failure mode
exposed by the same symptom. The `pollTaskCompletion` hardening from the
prior commits remains relevant for the per-step polling case.
