---
'@adcp/client': patch
---

Scope replay store by (keyid, @target-uri) instead of keyid alone (adcp#2460). A captured signature on one endpoint can no longer be replayed against another. Pass a `scope` argument to `ReplayStore.has/insert/isCapHit` — existing custom implementations must update their signatures.
