---
"@adcp/sdk": minor
---

**breaking** — `accounts.resolution: 'derived'` now enforces inline-`account_id` refusal (closes #1469, mirrors recipe #10 for `'implicit'`).

Pre-6.7, a buyer sending `{ account_id: "foo" }` to a `'derived'`-resolution (single-tenant) agent received the singleton response silently — the field was discarded with no signal. The framework now refuses it with `AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` before `accounts.resolve` is called, consistent with the `'implicit'` enforcement added in #1364.

The error message for `'derived'` is distinct from `'implicit'`: it says "single-tenant agent — account is derived from your auth credential" and does not mention `sync_accounts` (which is irrelevant and unsupported for derived-mode agents).

**Migration:** See recipe #10b in `docs/migration-6.6-to-6.7.md`. Adopters whose `resolve()` reads `ref.account_id` under `'derived'` mode must remove that branch — the refusal fires before `resolve()` is called.

Internal rename: `refuseImplicitAccountId` → `refuseInlineAccountIdWhenForbidden` (private function, not exported).
