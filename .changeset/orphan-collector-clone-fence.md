---
'@adcp/reporting-storage': minor
---

Reporting storage (experimental): the orphaned-object collector is fenced against a cloned or restored ledger database (#3292).

A clone or point-in-time restore of the ledger database shares the live database's installation identity, namespace key and configuration, so it also shares `acknowledgeExclusiveNamespace: true`. Its collector saw an older set of references and would have deleted the live database's newer row objects. A real `collectOrphanedRowObjects` pass now claims the namespace first and refuses to delete when another database holds a newer claim.

- **Fence.** A chain of create-only objects, one per epoch, under `{prefix}/{namespace_key}/_collector-fence/`, each holding a random token. The database records its last claim in `adcp_reporting_orphan_collector_fences`. A pass deletes only while the highest epoch in the bucket is exactly the claim the database recorded; it claims the next epoch before it deletes anything and re-reads the fence before every page that deletes. A copy taken before the original's latest claim sees a higher epoch and refuses.
- **Reporting.** A refused binding has `status: 'fenced'` and `fence: { cause, detail, fenceEpoch?, recordedEpoch? }`; the result has a new required `fenced: string[]`, and the maintenance task raises a warning. Causes: `fence_advanced`, `claimed_elsewhere`, `token_mismatch`, `fence_missing`, `fence_regressed`, `fence_unreadable`, `claim_lost`, `migration_required`. `dryRun` reads the fence without claiming it and reports fenced bindings too.
- **Takeover.** New `store.takeOverOrphanCollectorFence({ acknowledgePreviousOwnerGone: true, bindings?, includeReadOnly? })` for a database restored in place or whose predecessor is gone. It claims the next epoch and fences every other copy out.
- **Limit.** Nothing in the database tells a copy from the original until one of them claims, so the first claim wins. Run orphan collection only on the live database, never on a copy of the deployment.

Migration note (minor, breaking only for orphan collection):

1. Run `npx adcp-reporting-storage migrate`: new version `0009`, `reporting_orphan_collector_fence` (additive; the SQL is exported as `REPORTING_ORPHAN_FENCE_MIGRATION`). Until it is applied, a pass reports every binding as `fenced` with cause `migration_required` and deletes nothing, and `postgresStorage().checkSchema()` names `0009` as pending.
2. Run one real pass on the live database before any staging copy runs a collector.
3. A custom store that implements `collectOrphanedRowObjects` for the maintenance task must return `fenced: []`. `ReportingOrphanBindingResultV1.status` gains `'fenced'`.
4. Fence objects live in your object-store prefix. Provider contract is unchanged (create-only `putIfAbsent`, `get`, `list`, `delete`).

See `docs/guides/REPORTING-OPERATIONS.md` and `docs/migration-reporting-storage-package.md`.
