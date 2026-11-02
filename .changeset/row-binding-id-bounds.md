---
'@adcp/reporting-storage': minor
---

Reporting storage (experimental): `row_binding_id` and `credentialRef` accept up to 255 characters, the AdCP identifier bound (#3282).

Both were capped at 128 characters, tighter than every comparable AdCP identifier (`reporting_revision_id`, `resource_ref` and `destination_ref` use `^[A-Za-z0-9_.:-]{1,255}$`), so an adopter that derives binding IDs from AdCP destination references could be refused for no protocol reason. The configuration check, the `adcp_reporting_row_bindings` `CHECK` constraint and the keys of a provider's `clients` map now share one bound. The bound is exported as `REPORTING_ROW_BINDING_ID_MAX_LENGTH` and `REPORTING_ROW_CREDENTIAL_REF_MAX_LENGTH`, and the configuration errors say it.

Why minor and not patch: widening what is accepted breaks nobody, but a stored `CHECK` has to change, so this ships a new versioned migration that `postgresStorage().checkSchema()` requires (`REPORTING_SCHEMA_BEHIND` until applied). Per the stability policy a schema change goes in a minor of `@adcp/reporting-storage`.

Migration note:

1. Run `npx adcp-reporting-storage migrate`: new version `0010`, `reporting_row_binding_id_bounds` (the SQL is exported as `REPORTING_ROW_BINDING_ID_BOUND_MIGRATION`). It drops the old unnamed 128-character `CHECK` and adds `adcp_reporting_row_bindings_row_binding_id_bounds` (255), only when the database still has the old one, so a current schema is untouched and nothing takes a lock. No data migration. A database that applies `REPORTING_ROW_STORAGE_MIGRATION` by hand gets the same change, and a fresh install is created with the new constraint.
2. Until it runs, a binding ID longer than 128 characters passes the configuration check and is refused by the database when the binding registers. Nothing that was valid before is refused.
3. The Python SDK carries the same item (adcp-client-python#1498); keep the shared DDL equal when you upgrade both.

See `docs/migration-reporting-storage-package.md` and `docs/guides/REPORTING-LEDGER.md`.
