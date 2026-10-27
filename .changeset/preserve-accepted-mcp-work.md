---
'@adcp/sdk': patch
---

Keep accepted seller work alive when an implicit MCP task scope returns a successful nonterminal result (`submitted`, `working`, `input-required`, `auth-required`, or `deferred`). Close the local client and remove scoped cache entries without issuing a destructive session DELETE. Completed tasks and explicit caller-owned workflow scopes retain their normal session termination policy; credential and connection partitions are unchanged.
