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
- `sync_reporting_receipts` applies the RC3 per-array caps of 100 `receipts` and 100 `adjustment_receipts` independently rather than an invented combined cap, while still refusing a batch that exceeds the 100-entry combined bound RC3 states in `x-adcp-validation.batch_identity`.
- `installConfiguration` enforces the RC3 rule that a `billing` feed requires `required_finality: official`, which was never checked and was only accidentally covered by the receipt store's hard-coded finality.
- Lifecycle reconciliation projects managed health and issues through the same projection the read path uses, so persisted transitions and webhooks agree with `get_reporting_status`.

Lifecycle reconciliation folds consumer receipt severity into obligation health but never persists the receipt issues themselves, because the issue store has no consumer dimension and `get_reporting_status` republishes persisted issues to whichever consumer is reading. Seller-side managed delivery issues are still persisted and notified.

Receipt batch replay is exact only while the destination authorization is current; a revoked entry replays as `failed`. This pre-existing fail-closed exception to the protocol-wide idempotent-replay rule is now stated in the guide rather than implied away.

Additional review-blocker fixes: the materialization and revocation leases are issued from the database clock that already fences their settlement, so host clock skew can no longer strand a pending row or drive unbounded redelivery; an adjustment rejection whose digests agree is accepted, as RC3's `acceptance_match` requires for a semantic disagreement; `installBinding` recomputes the semantic fingerprint before any comparison, and `reportingManagedDeliveryBindingV1` derives it from semantic content so spreading an existing binding cannot smuggle a stale value; `get_reporting_status` scopes `adjustment_receipts` to the adjustments the view actually returns per RC3 `revision_adjustments`, and periods-view receipts to the obligations it returns; `sync_reporting_receipts` refuses malformed or empty batches with a typed `VALIDATION_ERROR` envelope and never reflects an unusable receipt id into the pattern-constrained response field; and lifecycle aggregation runs over an obligated consumer roster so a silent authorized consumer cannot vanish when another accepts.
