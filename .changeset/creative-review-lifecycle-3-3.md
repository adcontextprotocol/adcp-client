---
"@adcp/sdk": minor
---

Add version-aware media-buy lifecycle validation for AdCP 3.3 creative review. `getMediaBuyTransitions(adcpVersion)` and the optional version argument on the existing transition helpers permit `pending_start` to return to `pending_creatives` when seller review creates buyer work before activation. Older releases retain their existing graph, and active, paused, and terminal-state protections remain unchanged. The storyboard `status.monotonic` invariant uses the same release-specific graph, honoring the seller's response version before the requested pin, including nested media-buy reads.

Support `update_creative_start_policy` as an operational action in buyer preflight and seller action projection, with explicit live seller authority and exact package scope rather than a fabricated commercial change term. Require the 3.3 contract, preserve independent `sync_creatives` routing, and consume the startup field's task and update bindings from schema generation without changing the SDK's default AdCP pin.
