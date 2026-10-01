---
'@adcp/sdk': patch
---

Preserve a trailing empty query delimiter in default request target URI canonicalization, so signatures and callback URL matching distinguish `/p?` from `/p`.
