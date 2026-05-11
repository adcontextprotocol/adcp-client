---
"@adcp/sdk": patch
---

fix: reset alias cache at phase boundaries in storyboard runner (#1657)

`$generate:uuid_v4#alias` placeholders now produce fresh UUIDs at each phase boundary instead of leaking the same cached UUID across phases. Independent setup phases that share an alias name (e.g., two phases both using `#setup`) previously received the same UUID, causing sellers to return stale state from their idempotency cache on the second phase. The fix creates a new context object identity at each phase entry (after the `shouldSkipPhase` skip), dropping the WeakMap-keyed alias cache while preserving all `$context.*` values as plain spread properties.
