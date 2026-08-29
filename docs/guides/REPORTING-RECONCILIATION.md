# Reporting reconciliation

`reconcileReporting` turns the reporting ledger into a buyer-verifiable result. It reads one stable ledger snapshot, checks the expected period set, inspects each current destination materialization, submits any required consumer receipts, and then reads the seller's ledger back before returning.

The helper only returns `definitive: true` when all of these conditions hold:

- the buyer supplies its own complete `expectedPeriods` denominator;
- the seller closes the requested scope and declares its coverage complete;
- every expected report definition, feed, reporting profile, campaign set, and period has an obligation;
- every obligation's history counts match the returned immutable records;
- the current revision has the required finality;
- a verified, unexpired materialization matches the obligation;
- every consumer-receipt obligation has an accepted receipt for the same revision, materialization, row count, control totals, and required verification evidence.

An omitted expected-period denominator can still diagnose delivery, but can never prove completeness. Pass `[]` only when the buyer independently knows that no periods are expected in the requested scope.

```ts
import {
  createHttpsReportingResourceReader,
  reconcileReporting,
} from '@adcp/sdk';

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
    reportDefinitionId: 'billing-v1',
    feedPurpose: 'billing',
    reportingProfile: 'billing-v1',
    mediaBuyIds: ['buy-1', 'buy-2'],
    destinationRef: 'destination-billing-v3',
    deliveryMethod: 'file_transfer',
    requiredFinality: 'official',
    reconciliationMode: 'consumer_receipt',
    coverageRequirement: 'full',
    coverage: {
      status: 'full',
      media_buy_ids: ['buy-1', 'buy-2'],
      fully_covered_media_buy_ids: ['buy-1', 'buy-2'],
      partially_covered_media_buy_ids: [],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: ['package-1', 'package-2'],
      covered_package_ids: ['package-1', 'package-2'],
      unsupported_package_ids: [],
      unknown_package_ids: [],
    },
    reportDefinitionUri: 'https://schemas.seller.example/report-definitions/billing-v1.json',
    reportDefinitionSha256: savedBillingDefinitionSha256,
    schemaVersion: '1',
    schemaUri: 'https://schemas.seller.example/reporting/billing-v1.json',
    schemaSha256: savedBillingSchemaSha256,
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    schemaRefPolicy: 'local_fragment_only',
    officialFinality: {
      policyId: 'billing-close-v1',
      basis: 'contractual_cutoff',
    },
    verificationProfile: 'canonical_digest',
    canonicalization: {
      id: 'billing-rows-v1',
      uri: 'https://schemas.seller.example/canonicalization/billing-rows-v1.json',
      sha256: savedCanonicalizationSha256,
      primaryKeys: ['media_buy_id', 'date'],
    },
    periodStart: '2026-08-01T00:00:00Z',
    periodEnd: '2026-09-01T00:00:00Z',
  }],
  resourceReader: createHttpsReportingResourceReader(),
  credentialProvider: {
    async getCredentials({ obligation }) {
      const destination = await loadSavedDestination(obligation.destination_ref);
      return {
        headers: {
          authorization: `Bearer ${await destinationToken(obligation.destination_ref)}`,
        },
        allowedOrigins: [destination.readerOrigin],
      };
    },
  },
  manifestInspectorOptions: {
    referenceAllowedOrigins: ['https://schemas.seller.example'],
    consumerCommitRef: 'buyer-reporting-ledger:2026-08',
    maxInspectionMs: 60_000,
  },
});

if (!result.definitive) {
  throw new Error('Reporting is not ready for billing');
}
```

When `inspect` is omitted, `resourceReader` enables the built-in manifest path. It verifies the exact manifest bytes before parsing, manifest identity and completeness, every object size and SHA-256, declared compression and format, the pinned row schema and report definition, row count and control totals, and the pinned RFC 8785 canonical-content contract. The bundled decoders cover JSONL and CSV with `none` or `gzip` compression. Configure format/compression decoders for Parquet, Avro, ORC, Zstandard, or Snappy. The aggregate inspection deadline covers credential lookup, reads, reference resolution, custom adapters, validation, and canonicalization.

The HTTPS reader applies the SDK's DNS-pinned SSRF controls, refuses redirects and cross-origin `object_ref` values, and accepts short-lived headers only through the credential provider. `allowedOrigins` must come from the consumer's saved destination configuration; the reader refuses to send credentials to an origin named only by the seller's resource descriptor. For S3, GCS, or Azure, implement `ReportingResourceReader`; it receives the destination-bound context and opaque credentials without placing either in the ledger or receipt. Complex control totals can supply `controlTotalCalculator`; the default handles only report-definition metrics whose declared aggregation is `sum` and whose `source_expression` resolves to numeric row values.

Keep `inspect` as the advanced override for native snapshots. A BigQuery adapter can inspect a table version, while Snowflake or Databricks adapters can verify a shared relation. `ReportingInspectionError.retryable` distinguishes transport/readiness failures from permanent digest, schema, or integrity failures, so permanent failures are never retried. Store receipts in a durable `checkpointStore` so a process restart does not repeat destination work. Set `checkpointScope` to a stable, non-secret seller-and-authenticated-principal identifier; checkpoint keys also include account, obligation, revision, materialization, and destination. The checkpoint preserves the receipt-write idempotency key across uncertain retries.

Totals are returned once per canonical reporting revision. Each entry includes its coverage status and covered/package denominators, so partial evidence cannot be mistaken for full billing totals. Delivering the same revision to a buyer, governance agent, and archive destination does not multiply its rows or financial control totals. Each consumer still authenticates independently and submits its own receipt; one consumer's acceptance never implies another's.
