---
"@adcp/sdk": minor
---

feat(adapters): add optional `list?` callback to `createDerivedAccountStore` for spec-compliant `list_accounts` support

`'derived'`-mode sellers can now expose `list_accounts` for account discovery and spec compliance (every seller must expose `list_accounts` OR `sync_accounts`) without changing their resolution mode. The `account_id` refusal for `'derived'` platforms is unchanged — `list?` is for discovery only. See `docs/guides/account-resolution.md` § `'derived'` mode for the multi-tenant derived pattern and the `account_id` constraint.
