---
'@adcp/sdk': minor
---

Framework-side refusal of inline `account_id` for `resolution: 'derived'`
agents (closes adcp-client#1468). Mirrors the long-standing `'implicit'`
enforcement (#1364): the framework now throws
`AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` *before*
reaching `accounts.resolve` whenever a `'derived'`-mode platform receives
a buyer-supplied `account_id` on the wire.

Single-tenant agents (audiostack, flashtalking, single-namespace
retail-media) declare `account_id` is meaningless on the wire; previously
the framework silently dropped buyer-supplied ids and the resolver
returned the singleton anyway, leaving cargo-culted requests undetectable.
The refusal makes the wire-contract violation surface cleanly to the
buyer with a single-tenant message (no `sync_accounts`-first guidance,
since that step does not exist in derived mode).

Hand-rolled `'derived'` stores get the enforcement automatically — not
just users of `createDerivedAccountStore`. The brand+operator union arm
is still permitted.

Implementation: `refuseImplicitAccountId` (closed #1364) renamed to
`refuseInlineAccountIdWhenForbidden` and extended to fire on both
`'implicit'` and `'derived'` resolution modes with mode-specific error
messaging.
