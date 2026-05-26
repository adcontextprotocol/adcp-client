---
'@adcp/sdk': patch
---

Tighten beta.11 server payload migration around `get_products.cache_scope`.

Server-facing `get_products` payload aliases and `productsResponse()` now require
`cache_scope` whenever `products` are returned or a wholesale-feed response is
`unchanged`. Unchanged responses still omit `products`, but must echo
`cache_scope`. Strict response validation catches plain JavaScript adopters that
bypass TypeScript.

Framework response defaulting now infers `cache_scope: 'public'` only when there
is no inline account and no auth-derived/resolved account. Account-scoped
requests fail closed unless the adapter explicitly chooses `public` or
`account`, and sandbox/test-controller seeded merges no longer hide missing
account-scoped scope.
