# Reporting reconciliation

`reconcileReporting` turns the reporting ledger into a buyer-verifiable result. It reads one stable ledger snapshot, checks the expected period set, inspects each current destination materialization, submits any required consumer receipts, and then reads the seller's ledger back before returning.

The helper only returns `definitive: true` when all of these conditions hold:

- the buyer supplies its own complete `expectedPeriods` denominator;
- the seller closes the requested scope and declares its coverage complete;
- every expected period has an obligation;
- every obligation's history counts match the returned immutable records;
- the current revision has the required finality;
- a verified, unexpired materialization matches the obligation;
- every consumer-receipt obligation has an accepted receipt for the same revision, materialization, row count, control totals, and required verification evidence.

An omitted expected-period denominator can still diagnose delivery, but can never prove completeness. Pass `[]` only when the buyer independently knows that no periods are expected in the requested scope.

```ts
import { reconcileReporting } from '@adcp/sdk';

const result = await reconcileReporting({
  client: seller,
  request: {
    account: { account_id: 'account-1' },
    period: {
      start: '2026-08-01T00:00:00Z',
      end: '2026-09-01T00:00:00Z',
    },
  },
  expectedPeriods: [{
    deliveryConfigId: 'billing-feed',
    deliveryConfigVersion: 3,
    periodStart: '2026-08-01T00:00:00Z',
    periodEnd: '2026-09-01T00:00:00Z',
  }],
  async inspect({ revision, materialization }) {
    // Read the pinned table version or file manifest with the destination's
    // native SDK. Recompute the evidence required by the negotiated profile.
    return {
      rowCount: revision.row_count,
      controlTotals: revision.control_totals,
      canonicalContentDigest: revision.canonical_content_digest,
      nativeVersionRef: materialization.resource?.native_version_ref,
      manifestSha256: materialization.resource?.manifest_sha256,
      consumerCommitRef: 'buyer-reporting-ledger:2026-08',
    };
  },
});

if (!result.definitive) {
  throw new Error('Reporting is not ready for billing');
}
```

`inspect` is deliberately transport-specific. A BigQuery adapter can inspect a snapshot or table version, a Snowflake or Databricks adapter can verify a shared table version, and an S3 adapter can validate the manifest and every object checksum. Store receipts in a durable `checkpointStore` so a process restart does not repeat destination work.

Totals are returned once per canonical reporting revision. Delivering the same revision to a buyer, governance agent, and archive destination does not multiply its rows or financial control totals. Each consumer still authenticates independently and submits its own receipt; one consumer's acceptance never implies another's.
