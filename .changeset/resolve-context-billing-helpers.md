---
"@adcp/client": minor
---

Thread `ResolveContext` into `AccountStore.getAccountFinancials` and `AccountStore.reportUsage`; add `refAccountId` helper.

Platforms fronting upstream billing APIs (Snap, Meta, retail-media) need the OAuth principal when posting usage rows or reading spend data. `getAccountFinancials` and `reportUsage` now accept an optional `ctx?: ResolveContext` second parameter carrying `authInfo` and `toolName` — the same pattern already established by `accounts.resolve`.

`refAccountId(ref?)` is a new exported helper that safely extracts `account_id` from the `AccountReference` discriminated union, eliminating per-adopter casting boilerplate in `accounts.resolve` implementations.

Both changes are non-breaking: existing `AccountStore` implementations that omit the second parameter compile and run unchanged.
