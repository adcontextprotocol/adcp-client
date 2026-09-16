---
'@adcp/sdk': patch
---

Fix eight seller Managed Delivery and Reconciled Billing review blockers.

- Managed delivery no longer overwrites Core obligation health, so an installed managed table cannot downgrade an `action_required` coverage failure to `waiting` or `delayed` while keeping its issue.
- Destination revocation no longer erases a consumer receipt verdict. `reconciliation_status` is settled from the append-only receipt chain and the full materialization history, which also removes a schema-invalid `pending` obligation carrying only a `RECEIPT_REJECTED` issue.
- Receipt evidence honours the obligation's own `required_finality`, so a snapshot-finality `consumer_receipt` contract can reconcile instead of having every receipt refused.
- `runManagedDeliveryWorker` enforces the advertised `authorization_revocation_seconds`: cleanup attempts are clipped to the promised instant, retry leases never outlast the window, and a breached grant is reported as `revocationsOverdue`.
- The receipt idempotency cache stores a compact per-entry verdict and rehydrates bodies from the append-only receipt table, with a 30-day retention sweep so a consumer at the batch cap is throttled rather than permanently locked out.
- `canonical_adjustment_sha256` follows the pinned canonicalization contract instead of changing wire content for every Core adopter, and revisions or adjustments stored before the canonical digests existed replay without a false immutability conflict.
- `sync_reporting_receipts` applies the RC3 per-array caps of 100 `receipts` and 100 `adjustment_receipts` independently rather than an invented combined cap.
- Lifecycle reconciliation projects managed health and issues through the same projection the read path uses, so persisted transitions and webhooks agree with `get_reporting_status`.
