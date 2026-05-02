---
'@adcp/sdk': patch
---

fix(matrix): blind-fixture testing + façade detection in matrix v2 harness

Closes adcontextprotocol/adcp-client#1225.

The matrix v2 harness was leaking the answer key to Claude — the prompt inlined specific principal-mapping values (e.g., `account.advertiser: "acmeoutdoor.example" → upstream advertiser_id: adv_acme_us`), letting Claude hardcode the entire round-trip without ever calling the upstream. Surfaced empirically on PR #1220's sales-social run: Claude's generated `server.ts` defined an OAuth client but never invoked it from any handler, with this comment:

```ts
// Touch the upstream client at boot so the import isn't tree-shaken in dev,
// and so the OAuth path is exercised even when handlers don't call it.
void fetchUpstreamToken;
```

Storyboard graded `passing` because it only validates AdCP response shape, not whether the agent actually wrapped the upstream.

Two changes to make the test honest:

1. **Strip specific values from the harness prompt.** Adapters now receive the *names* of AdCP fields they'll see (`account.advertiser`, `account.operator`, etc.) but not the *values*. The harness uses values Claude's prompt does not contain. Hardcoding a mapping table won't work.
2. **Discovery + traffic counters on the mock-server.** Each mock exposes:
   - `GET /_lookup/<resource>?<adcp_field>=<value>` — runtime resolution from AdCP-side identifiers to upstream IDs. Replaces the hardcoded mapping table the prompt used to inline.
   - `GET /_debug/traffic` — per-endpoint hit counters. The harness queries this after the storyboard run and asserts headline endpoints (`POST /event/track`, `POST /custom_audience/upload`, etc.) were called ≥ 1 time. Façade adapters that return shape-valid AdCP responses without calling these endpoints fail this check regardless of storyboard pass.

All four specialisms (sales-social, signal-marketplace, creative-template, sales-guaranteed) ship with `/_lookup/<resource>` discovery, `/_debug/traffic` counters, and `bump()` calls on every routed handler. Each carries a per-specialism `expectedHitsForSpecialism()` list in the harness — empty list means no traffic assertion (back-compat for un-instrumented mocks).

Boot summaries also stripped of specific advertiser/operator values so adapters can't read them from the CLI banner.

Refs:
- PR #1220 (sales-social) — the matrix run that surfaced the façade pattern
- Issue #1225 — full design rationale and follow-up scope across all 4 mocks
