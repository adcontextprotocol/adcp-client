---
'@adcp/sdk': patch
---

Preserve a trailing empty query delimiter in default request target URI canonicalization, so signatures and callback URL matching distinguish `/p?` from `/p`. Signing fetch wrappers now reject URLs whose terminal empty query marker could be lost by Fetch before transmission.
