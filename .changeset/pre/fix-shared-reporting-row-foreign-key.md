---
'@adcp/reporting-storage': minor
---

Allow shared row-storage tables to hold rows written by another SDK without requiring its obligations in the JavaScript core ledger. The row-set obligation foreign key is removed; row-set ownership is maintained by each SDK's ledger transactions and retirement process.

Migration: run `npx adcp-reporting-storage migrate` to apply migration 0011 to existing databases. Deployments applying the deprecated `REPORTING_ROW_STORAGE_MIGRATION` directly should reapply it. The migration drops the default `adcp_reporting_row_sets_obligation_id_fkey` constraint; remove any custom-named foreign key to the JavaScript obligations table separately. Row-set and chunk foreign keys within the shared tables remain in place.
