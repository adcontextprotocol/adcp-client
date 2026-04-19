---
'@adcp/client': patch
---

Signing: time-bucket the in-memory replay store so `has()` / `insert()` /
`isCapHit()` stay O(1) amortized on a hot keyid pinned near the per-keyid
cap. Entries are grouped by `floor(expiresAt / bucketSizeSeconds)` (default
60s); whole buckets are evicted in one step when their latest expiry has
passed, eliminating the per-call O(N) filter sweep that turned a near-cap
keyid into a quadratic DoS target. Default `maxEntriesPerKeyid` drops from
1,000,000 → 100,000 (still ample for typical traffic; can be raised via
`new InMemoryReplayStore({ maxEntriesPerKeyid })` for large deployments).
The `ReplayStore` interface is unchanged. Closes #582.
