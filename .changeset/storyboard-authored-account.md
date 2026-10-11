---
'@adcp/sdk': patch
---

Preserve authored account IDs and natural-key identities instead of replacing them with the account captured from prior storyboard steps. This applies to product/signal discovery, media-buy creation, updates and reads, task queries, and operation-scoped test-controller directives. Steps without an authored identity continue to use the captured or harness account. Natural keys inherit context sandbox routing, falling back to the harness setting when context omits it; authored IDs identify seller-managed accounts, so sandbox runs must author IDs belonging to sandbox accounts.

Keep unresolved authored identities visible to the runner so media-buy/task steps skip missing prerequisites instead of testing a different account. Account-free discovery retains its existing context fallback. Deliberately malformed expect-error fixtures remain unchanged.

Custom storyboards that used literal placeholder account IDs must supply a seller ID or a context reference; those placeholders are no longer replaced with the harness account.
