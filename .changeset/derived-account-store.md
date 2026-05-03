---
'@adcp/sdk': minor
---

Add `createDerivedAccountStore` — Shape D `AccountStore` factory for
single-tenant `resolution: 'derived'` agents (no `account_id` on the
wire; auth principal alone identifies the tenant). Replaces the ~25–30
LOC of bearer-extract + throw-`AUTH_REQUIRED` + return-singleton
boilerplate that audiostack, flashtalking, single-namespace
retail-media adapters re-derive by hand, and standardizes the correct
`'derived'` declaration (many such adapters today claim `'explicit'`
even though they ignore the wire field).

Closes adcp-client#1462. Completes the four-shape factory family
alongside `InMemoryImplicitAccountStore` (A), `createOAuthPassthroughResolver`
(B), and `createRosterAccountStore` (C). Exported from `@adcp/sdk`,
`@adcp/sdk/server`, and `@adcp/sdk/adapters`.
