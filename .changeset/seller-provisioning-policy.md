---
'@adcp/sdk': minor
---

Expose `ctx.provisioning` to account resolvers (#3094) and add an opt-in `strictAccountReferences` server option. With `strictAccountReferences: true`, a buyer-supplied account reference on a server without a reference-aware `resolveAccount` fails with `ACCOUNT_NOT_FOUND`, and an implicit-mode account whose returned identity metadata disagrees with the supplied natural key is refused (#3091). Strict mode becomes the default in the next major release.

Deprecation: by default, raw handler-bag sellers without `resolveAccount` still pass supplied references to handlers unverified, as in 14.0, and log a one-time deprecation warning per server (`logger.warn`, plus `process.emitWarning` outside production). Implicit identity mismatches log a warning and keep the 14.0 result. Move account authorization into `resolveAccount`, then opt in; see `docs/guides/account-resolution.md`.

Fixes: the framework now enforces a seller's own `account.required_for_products` declaration, refusing `get_products` with `ACCOUNT_REQUIRED` when the request carries no account and authentication resolves none. `list_accounts.account` is treated as a filter instead of being resolved as the request's account.
