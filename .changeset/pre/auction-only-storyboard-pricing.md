---
"@adcp/sdk": patch
---

Construct bids for every discovered auction CPM package in a storyboard buy, preserving authored bids, fixed-price offers, and bidding policies. Add explicit `enrich_request: true` opt-in for schema-valid semantic rejection probes so measurement-term rejection is tested with a valid auction request while malformed-input probes retain their authored payloads.

Preserve the requested deterministic stale-cache age when forwarding `force_upstream_unavailable` to a test-controller store, including zero, and reject invalid ages before invoking the store.
