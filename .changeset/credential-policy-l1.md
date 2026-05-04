---
'@adcp/sdk': minor
---

Add opt-in `credentialPolicy` server config that scans incoming buyer args for credential-shaped keys at any depth and rejects with `INVALID_REQUEST` when configured `'authInfo-only'`. Closes the buyer-args credential-smuggling vector class (top-level, nested `context`, nested `ext`) observed across three rounds of review on PR scope3data/agentic-adapters#248. Default `'lax'` preserves existing behavior; opt in to enforce. Patterns extensible via `credentialPolicy.patterns.extend` or fully replaceable via `credentialPolicy.patterns.matcher`. Per-tool overrides via `credentialPolicy.tools`. Rejection envelope reports paths only and skips `params.context` echo so the offending value does not round-trip through the response. See #1529.
