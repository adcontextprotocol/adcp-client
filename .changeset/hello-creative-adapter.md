---
"@adcp/sdk": minor
---

Add `examples/hello_seller_adapter_creative.ts` — a worked starter for the `creative-template` specialism that mirrors the signals-adapter pattern.

Implements `build_creative` (with render-poll loop), `preview_creative`, `sync_creatives`, and `list_creative_formats` (via v5 escape hatch until PR #1331 lands). Includes upstream HTTP client wrappers, workspace-based account resolution, BuyerAgentRegistry, idempotency store, and format-slot translation from upstream `slot_id` vocabulary to AdCP `asset_id`. Also adds a `### Hello Adapters` section to `examples/README.md` for discoverability.
