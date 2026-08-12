---
'@adcp/sdk': patch
---

Reject replay test vectors in `adcp signing verify-vector` by preloading nonce fixtures with the request's canonical target scope.
