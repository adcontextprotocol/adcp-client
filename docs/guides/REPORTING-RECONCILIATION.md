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

## Consumer status and posting deadlines

`reconcileReporting` also plans the rc.3 **consumer-status** loop: the statements the buyer owes the
seller about what it did and did not receive. Every plan lands on
`ReportingReconciliationResult.consumerStatuses`; the subset actually written appears on
`postedConsumerStatuses`, item-local rejections on `failedConsumerStatuses`.

Nothing is posted until a plan is `overdue`, and `overdue` needs a deadline. **If no deadline can be
derived the SDK posts nothing — by design.** That is the single most common surprise here, so the
resolution order is worth knowing:

| # | Source | Notes |
|---|---|---|
| 1 | `obligation.expected_at` | The seller's own commitment. Normalized, never echoed verbatim. |
| 1a | — *(present but unreadable)* | **Nothing is derived and rows 2–3 are not consulted.** A present `expected_at` is the seller's real deadline; a locally derived one would disagree with it and the statement would be refused on every run. Only the seller can fix the value. |
| 2 | `ExpectedReportingPeriod.officialAfterSeconds` when `requiredFinality` is `official`, falling back to `deliverySlaSeconds`; `deliverySlaSeconds` otherwise | Added to the period end. `reporting-schedule.json` defines only `delivery_sla`, with no finality qualifier — `official_after` is an SDK-local extension — so `deliverySlaSeconds` is the spec-defined answer for a seller that does not carry it. **Record `officialAfterSeconds >= deliverySlaSeconds`.** A shorter one dates the statement before the seller's own `expected_at`, which `expected_period` makes invalid, and the body takes no clock input — so it is rebuilt identically and refused on every run. You will see it in `failedConsumerStatuses`, not as silence. |
| 3 | `obligation.schedule.delivery_sla` | Last resort, only when you pinned nothing above **and an obligation exists** — so it is never available for `obligation_missing`, which is exactly what the pins are for. Deliberately last: it is as seller-controlled as `expected_at`, and preferring it would let a seller move its own deadline. |

The deadline is then that instant plus `ExpectedReportingPeriod.automatedRecoveryWindowSeconds`. That
window is advertised on the delivery **capabilities**, not on the obligation, so the ledger cannot
supply it — **without it nothing is ever overdue and nothing is ever posted.** Record it when you
accept the configuration generation.

`received` and `content_mismatch` additionally require `client.getMediaBuyDelivery`, because both
must carry a digest the buyer recomputed from rows it actually read.

### Why a plan was not posted

`plan.suppressed` says which, and `plan.reason` says what to do about it.

| `suppressed` | Meaning | Your move |
|---|---|---|
| `unchanged` | The current leaf already says exactly this. | Nothing. Re-posting would supersede a statement with its own duplicate. |
| `deadline_unknown` | No deadline could be derived: a pin is missing, the seller's `expected_at` is unreadable, or the deadline overflowed the representable range. | `reason` names which, and for an overflow it names **the field that overflowed** — one of your own pins, the seller's `schedule.delivery_sla`, or `automatedRecoveryWindowSeconds`. Record the pin it names; for an unreadable `expected_at` only the seller can fix it. |
| `consumption_unavailable` | No exact-revision reader is wired. | Supply `client.getMediaBuyDelivery`. |
| `posting_unavailable` | No poster is wired, so there is nothing to append to. | Supply `client.syncReportingStatus`. |
| `period_identity_unknown` | `period.source_timezone` could not be read. Three causes: the seller's value is not a recognized IANA zone; your own `periodSourceTimezone` pin is not; or neither is. | `reason` names which, and quotes the values. Correct the pin, or take the seller's value up with the seller — and note that only the seller can fix its own value, because substituting one is what `iana_timezone` forbids. A pin naming a genuinely *different but valid* zone does **not** suppress: it posts under the seller's spelling and sets `plan.periodZoneBeyondPin` (see the alerting list below). **A link and its canonical name are one zone** — `Japan` and `Asia/Tokyo`, `US/Eastern` and `America/New_York` — and set nothing at all. |
| `local_budget_exhausted` | A read ceiling was reached before the revision could be consumed. | **`reason` names the ceiling.** `ledgerLimits.maxRevisionRows`, `maxPages` and `maxLoadMs` are yours to raise. `maxRevisionBytes` may only *tighten* the SDK's 256 MiB size ceiling — a larger value is **refused** with `INVALID_LEDGER_LIMITS`, because that ceiling bounds the SDK process's memory. Never reported as a seller failure. A row nested deeper (64 levels) **or wider (262,144 containers)** than the reader walks is `unreadable` / `reader_incompatible` instead, because no conformant tabular row has either shape. |
| `leaf_undisclosed` | Your chain has more than one unsuperseded leaf, or the seller named a current leaf it did not return. | A seller-side defect either way; the buyer declines to guess which leaf to supersede. |
| `chain_indeterminate` | The revision chain forked, or a head names a predecessor you never saw. | A seller-side defect. The buyer stays silent rather than blaming the seller for what it could not read. |

**Pin the spelling your seller uses.** For a period with no matching obligation there is no seller echo to adopt, so your `periodSourceTimezone` goes on the wire as you wrote it — and a seller comparing that field byte-for-byte refuses `Japan` when its own configuration says `Asia/Tokyo`, even though they are one zone. Zone *identity* is what the SDK compares; the seller's ingest may not be so forgiving.

**Alert on any `suppressed` value other than `unchanged`.** `unchanged` is the healthy steady state — every posted period comes back `unchanged` on the next reconcile — but the other seven mean this period will never post until something changes.

Two more conditions deserve an alert, because neither sets `suppressed`:

- **`plan.deadlineBeyondPin` is set.** The deadline came from the seller and you cannot vouch for it locally — either it is later than your pinned expectation by more than your recovery window (`pinned` carries what you expected), or **you recorded no pin at all**, so there was nothing to check it against (`pinned` is absent). It is still honoured — the spec makes the seller's instant authoritative — but left unwatched it is indistinguishable from "not due yet", and a seller can use it to opt out of the loop entirely. `plan.deadlineSource` says which input it came from; `buyer_pin` is the only one you can verify by yourself, and it never sets this flag.
- **`plan.periodZoneBeyondPin` is set.** Your `periodSourceTimezone` pin and the seller's echoed `period.source_timezone` are both recognized IANA zones naming *different* zones. The statement is still posted, under the seller's value — that is the only spelling its ingest accepts, and silence would remove the record for exactly the adopters careful enough to pin one. But your independent expectation of the period's identity did not hold, so its boundaries may have been generated from a different calendar than the seller used. A link and its canonical name never set this.
- **`overdue: true`, unsuppressed, and absent from `postedConsumerStatuses`.** Look in `failedConsumerStatuses`.

A failed reconcile is worth one more check. `reconcileReporting` re-reads the ledger *after* it syncs receipts, so a failure can happen with real work already durably written. When it does, the thrown `ReportingReconciliationError` carries **`error.submittedReceipts`** — the receipts a successful run would have returned. Retrying is idempotent if you wired a `checkpointStore`: the same receipt id and idempotency key are replayed and the seller answers `unchanged`. Without one, receipt ids are generated per attempt and an already-accepted receipt is terminal, so a retry conflicts instead.

Some suppressions are the seller's doing and you cannot configure your way out of them — `leaf_undisclosed` and `chain_indeterminate` in particular. Those are worth escalating out of band rather than retrying.
