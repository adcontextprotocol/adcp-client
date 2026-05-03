---
"@adcp/sdk": minor
---

Extend framework-side inline `account_id` refusal to `resolution: 'derived'` platforms (#1468). Previously a buyer that sent `{ account_id: "foo" }` to a `'derived'` agent received a silent drop; now the framework returns `INVALID_REQUEST` with `field: account.account_id` before `accounts.resolve` runs — matching the `'implicit'` enforcement added in 6.7 (#1365). Buyers relying on the auth-principal path (no `account_id` on the wire) are unaffected.
