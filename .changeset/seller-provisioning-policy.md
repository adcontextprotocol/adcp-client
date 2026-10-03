---
'@adcp/sdk': minor
---

Expose `ctx.provisioning` to account resolvers (#3094) and add an opt-in `strictAccountReferences` server option. Strict mode becomes the default in the next major release. With `strictAccountReferences: true`:

- a buyer-supplied account reference on a server without a reference-aware `resolveAccount` fails with `ACCOUNT_NOT_FOUND`;
- a seller that declares `account.required_for_products` refuses account-less `get_products` with `ACCOUNT_REQUIRED`;
- `list_accounts.account` is treated as a filter instead of being resolved as the request's account;
- an implicit-mode account whose returned identity metadata disagrees with the supplied natural key is refused (#3091).

Deprecation: by default each case keeps the 14.0 behavior and logs a deprecation warning once per process per warning code (`logger.warn`, plus `process.emitWarning` outside production; later occurrences log at debug level). Move account authorization into `resolveAccount`, then opt in; see `docs/guides/account-resolution.md`.
