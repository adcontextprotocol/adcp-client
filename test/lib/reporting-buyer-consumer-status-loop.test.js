const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
} = require('../../dist/lib/reporting/ledger/index.js');
const {
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { reconcileReporting } = require('../../dist/lib/reporting/reconciliation.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SLA_SECONDS = 3_600;
const RECOVERY_SECONDS = 3_600;

/**
 * Both halves of the rc.3 loop, wired to each other.
 *
 * The buyer client is the SDK's own seller: `get_reporting_status` for the
 * ledger, `get_media_buy_delivery` for the exact-revision read that earns a
 * `received`, and `sync_reporting_status` for the append. Nothing is stubbed,
 * so a statement the buyer plans has to survive the same `validateStatus` a
 * real seller would run it through — which is the only way to catch a buyer
 * that posts statements a conformant seller rejects.
 */
async function harness({ rows = [{ media_buy_id: 'fixture-media-buy', impressions: 3, spend: '1.2500' }] } = {}) {
  const store = new MemoryLedgerStore();
  const request = redactedReportingSourceRequestV1();
  let currentRows = rows;
  const source = createInlineReportingSourceExecutor(() => currentRows, redactedReportingSourceOfferingV1);
  const producer = createReportingProducer({
    store,
    source,
    offerings: [redactedReportingSourceOfferingV1],
    contact: { name: 'Reporting operations' },
  });
  const anchor = Date.parse(request.period.start);
  await producer.installConfiguration({
    account: request.account,
    sourceScope: request.sourceScope,
    delivery_config_id: request.delivery_config_id,
    delivery_config_version: request.delivery_config_version,
    offeringId: request.offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
    sourceTimezone: 'UTC',
    schedule: {
      anchor: request.period.start,
      periodMilliseconds: DAY,
      deliverySlaMilliseconds: SLA_SECONDS * 1_000,
      recoveryWindowMilliseconds: RECOVERY_SECONDS * 1_000,
    },
    sourceSettings: request.sourceSettings,
    contract: request.contract,
  });
  // The install clock is later than the fixture period; move the immutable test
  // generation to a controlled period without changing its semantics.
  [...store.configurations.values()][0].installedAt = new Date(anchor).toISOString();

  const context = { account: { account_id: request.account.account_id }, sessionKey: 'buyer-1' };
  const resolveConsumerId = ctx => `session:${ctx.sessionKey}`;
  const getReportingStatus = createReportingStatusHandler(store, { resolveConsumerId });
  const getMediaBuyDelivery = createReportingDeliveryHandler(store);
  const syncReportingStatus = createSyncReportingStatusHandler(store, { resolveConsumerId });

  const client = {
    getReportingStatus: params => getReportingStatus(params, context),
    getMediaBuyDelivery: params => getMediaBuyDelivery(params, context),
    syncReportingStatus: params => syncReportingStatus(params, context),
    syncReportingReceipts: async () => ({ status: 'completed', results: [] }),
  };

  return {
    store,
    request,
    producer,
    client,
    anchor,
    setRows(next) {
      currentRows = next;
    },
    /** Advance the seller's observation boundary, which the buyer reads as `ledger_as_of`. */
    observeAt(ms) {
      store.ledgerAsOf = new Date(ms).toISOString();
    },
    reconcile(now, expectedPeriods, overrides = {}) {
      return reconcileReporting({
        client,
        request: { account: request.account },
        expectedPeriods,
        now: new Date(now),
        inspect: async () => ({ rowCount: 0, controlTotals: [] }),
        ...overrides,
      });
    },
  };
}

/** The buyer's own record of the accepted configuration generation. */
function expectedPeriod(request, anchor, overrides = {}) {
  return {
    deliveryConfigId: request.delivery_config_id,
    deliveryConfigVersion: request.delivery_config_version,
    reportDefinitionId: request.report_definition_id,
    feedPurpose: 'analytics',
    reportingProfile: request.contract.reportingProfile,
    mediaBuyIds: [...request.coverage.mediaBuyIds],
    destinationRef: undefined,
    deliveryMethod: undefined,
    requiredFinality: 'snapshot',
    reconciliationMode: 'delivery_only',
    coverageRequirement: 'full',
    coverage: {
      status: 'full',
      media_buy_ids: [...request.coverage.mediaBuyIds],
      fully_covered_media_buy_ids: [...request.coverage.mediaBuyIds],
      partially_covered_media_buy_ids: [],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: [],
      covered_package_ids: [],
      unsupported_package_ids: [],
      unknown_package_ids: [],
    },
    reportDefinitionUri: request.contract.reportDefinitionUri,
    reportDefinitionSha256: request.contract.reportDefinitionSha256,
    schemaVersion: request.contract.schemaVersion,
    schemaUri: request.contract.schemaUri,
    schemaSha256: request.contract.schemaSha256,
    schemaDialect: request.contract.schemaDialect,
    schemaRefPolicy: request.contract.schemaRefPolicy,
    verificationProfile: 'manifest_checksums',
    periodStart: new Date(anchor).toISOString(),
    periodEnd: new Date(anchor + DAY).toISOString(),
    // Both pins come from the accepted generation and the advertised delivery
    // capabilities; without them the buyer cannot date or schedule a statement.
    deliverySlaSeconds: SLA_SECONDS,
    automatedRecoveryWindowSeconds: RECOVERY_SECONDS,
    ...overrides,
  };
}

describe('rc.3 buyer consumer-status loop, end to end against the SDK seller', () => {
  test('posts revision_missing, then says nothing, then supersedes it with a consumed received', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());

    // Past expected_at + the recovery window, with no revision published.
    const overdueAt = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(overdueAt);
    const first = await seller.reconcile(overdueAt, expected);

    assert.equal(first.postedConsumerStatuses.length, 1);
    assert.deepEqual(first.failedConsumerStatuses, []);
    const missing = first.postedConsumerStatuses[0];
    assert.equal(missing.consumerStatus, 'revision_missing');
    assert.equal(missing.supersedesReportingStatusId, undefined, 'nothing to supersede on an empty chain');
    // `expected_period`: a missing status is valid only at or after expected_at.
    // The seller's own validateStatus rejects anything earlier, so a statement
    // dated from the period end would have failed instead of being recorded.
    assert.ok(Date.parse(missing.statusAsOf) >= seller.anchor + DAY + SLA_SECONDS * 1_000);

    // Nothing changed, so there is nothing to say. Re-posting would supersede a
    // statement with its own duplicate on every reconcile, forever.
    const second = await seller.reconcile(overdueAt + HOUR, expected);
    assert.deepEqual(second.postedConsumerStatuses, []);
    assert.equal(second.consumerStatuses[0].suppressed, 'unchanged');
    assert.equal(
      second.consumerStatuses[0].supersedesReportingStatusId !== undefined,
      true,
      'the buyer still names the leaf it would have superseded'
    );

    // The seller publishes. Now the buyer has something new to say — but only
    // after it has actually read the revision.
    const committed = await seller.producer.runWorker({
      now: () => new Date(seller.anchor + DAY + 4 * HOUR),
      maxIterations: 2,
    });
    assert.equal(committed.revisionsCommitted, 1);
    const [revision] = await seller.store.listRevisions(
      [...seller.store.obligations.values()][0].reporting_obligation_id
    );
    seller.observeAt(seller.anchor + DAY + 5 * HOUR);

    const third = await seller.reconcile(seller.anchor + DAY + 5 * HOUR, expected);
    assert.equal(third.postedConsumerStatuses.length, 1);
    assert.deepEqual(third.failedConsumerStatuses, []);
    const received = third.postedConsumerStatuses[0];
    assert.equal(received.consumerStatus, 'received');
    assert.equal(received.reportingRevisionId, revision.reporting_revision_id);
    // Recomputed from the rows the buyer paged, not copied from the ledger.
    assert.equal(received.observedRevisionContentSha256, revision.wireRevision.revision_content_sha256);
    // One chain, two statements, the second naming the first. `immutability`
    // fails a statement atomically if it omits or misnames the current leaf.
    const chain = seller.store.consumerStatements;
    assert.equal(chain.length, 2);
    assert.equal(chain[0].consumer_status, 'revision_missing');
    assert.equal(chain[1].consumer_status, 'received');
    assert.equal(chain[1].supersedes_reporting_status_id, chain[0].reporting_status_id);
    assert.equal(received.supersedesReportingStatusId, chain[0].reporting_status_id);
    // `time`: a statement may never be dated before the one it supersedes.
    assert.ok(Date.parse(received.statusAsOf) >= Date.parse(missing.statusAsOf));

    // And once it is said, it stays said.
    const fourth = await seller.reconcile(seller.anchor + DAY + 6 * HOUR, expected);
    assert.deepEqual(fourth.postedConsumerStatuses, []);
    assert.equal(fourth.consumerStatuses[0].suppressed, 'unchanged');
  });

  test('a revision whose rows do not hash to its digest is unreadable, not received', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A row the buyer reads that is not the row the digest covers. This is the
    // case that makes copying `revision_content_sha256` out of the ledger
    // indefensible: the ledger still says the revision is fine.
    const honest = seller.client.getMediaBuyDelivery;
    seller.client.getMediaBuyDelivery = async params => {
      const page = await honest(params);
      return {
        ...page,
        reporting_rows: page.reporting_rows.map(row => ({ ...row, impressions: Number(row.impressions ?? 0) + 1 })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    const posted = result.postedConsumerStatuses[0];
    assert.equal(posted.consumerStatus, 'unreadable');
    assert.equal(posted.failureCode, 'integrity_mismatch');
    assert.equal(posted.observedRevisionContentSha256, undefined, 'a digest that did not verify is not evidence');
  });

  test('a revision covering less than the obligation froze posts content_mismatch', async () => {
    const seller = await harness();
    const at = seller.anchor + DAY + 3 * HOUR;
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    seller.observeAt(at);
    const [revision] = await seller.store.listRevisions(
      [...seller.store.obligations.values()][0].reporting_obligation_id
    );

    // Stage a seller whose published revision covers less than the accepted
    // generation froze. The obligation's `covered_package_ids` is the frozen
    // fact; the revision's is what it actually delivered. Coverage is revision
    // *metadata*, so the binding digest still verifies — which is the point:
    // the buyer consumed the exact bytes and they contradict the contract.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: page.periods.map(period => ({
          ...period,
          coverage: { ...period.coverage, package_ids: ['fixture-package'], covered_package_ids: ['fixture-package'] },
        })),
      };
    };
    const expected = [
      expectedPeriod(seller.request, seller.anchor, {
        coverage: {
          ...expectedPeriod(seller.request, seller.anchor).coverage,
          package_ids: ['fixture-package'],
          covered_package_ids: ['fixture-package'],
        },
      }),
    ];

    const result = await seller.reconcile(at, expected);

    assert.equal(result.postedConsumerStatuses.length, 1);
    const posted = result.postedConsumerStatuses[0];
    assert.equal(posted.consumerStatus, 'content_mismatch');
    assert.equal(posted.mismatchCode, 'coverage_short');
    // `revision_binding`: content_mismatch names the exact bytes it read, with
    // a digest the buyer recomputed rather than one it copied.
    assert.equal(posted.observedRevisionContentSha256, revision.wireRevision.revision_content_sha256);
  });

  test('an item-local rejection is surfaced with its errors, not silently dropped', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A configuration generation this seller has never seen. The buyer plans
    // obligation_missing for it, and the seller rejects the statement
    // item-locally as an ineligible period.
    const expected = [
      expectedPeriod(seller.request, seller.anchor, { deliveryConfigId: 'fixture-delivery-config-unknown' }),
    ];
    const result = await seller.reconcile(at, expected);

    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(result.failedConsumerStatuses.length, 1);
    assert.equal(result.failedConsumerStatuses[0].plan.consumerStatus, 'obligation_missing');
    assert.ok(result.failedConsumerStatuses[0].errors.length > 0, 'the seller told the buyer why; keep it');
  });

  test('obligation_missing derives expected_at from the buyer pin and the seller accepts it', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A seller that omitted the period from its ledger. Staged at the wire
    // because this SDK's own producer refuses to serve a ledger with a gap —
    // which is exactly why obligation_missing exists for the ones that do.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: [],
        revisions: [],
        pagination: { ...page.pagination, total_count: 0 },
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.missingExpectedPeriods.length, 1);
    // Accepted by the real `validateStatus`, not rejected as premature. A
    // statement dated from the period end fails there with 'missing status
    // precedes expected_at', so this assertion is the regression test for it.
    assert.deepEqual(result.failedConsumerStatuses, []);
    assert.equal(result.postedConsumerStatuses.length, 1);
    const posted = result.postedConsumerStatuses[0];
    assert.equal(posted.consumerStatus, 'obligation_missing');
    assert.equal(posted.reportingObligationId, undefined, 'valid with no seller-issued identity');
    assert.equal(posted.statusAsOf, new Date(seller.anchor + DAY + SLA_SECONDS * 1_000).toISOString());
    assert.equal(
      posted.deadline,
      new Date(seller.anchor + DAY + (SLA_SECONDS + RECOVERY_SECONDS) * 1_000).toISOString()
    );

    // And the same statement dated from the period end — what the reconciler
    // used to send — is refused outright, so the assertion above is not
    // measuring a distinction the seller ignores.
    const premature = await seller.client.syncReportingStatus({
      account: seller.request.account,
      idempotency_key: 'reporting-status-premature-0001',
      statuses: [
        {
          reporting_status_id: 'adcp-sdk.premature000000000000000000',
          delivery_config_id: seller.request.delivery_config_id,
          delivery_config_version: seller.request.delivery_config_version,
          report_definition_id: seller.request.report_definition_id,
          period: {
            start: new Date(seller.anchor).toISOString(),
            end: new Date(seller.anchor + DAY).toISOString(),
            source_timezone: 'UTC',
          },
          consumer_status: 'obligation_missing',
          status_as_of: new Date(seller.anchor + DAY).toISOString(),
        },
      ],
    });
    assert.equal(premature.results[0].result, 'failed');
    assert.match(premature.results[0].errors[0].message, /expected/i);
  });

  test('without an exact-revision reader the buyer plans received but never attests it', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    delete seller.client.getMediaBuyDelivery;

    const result = await seller.reconcile(at, expected);
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(result.consumerStatuses[0].consumerStatus, 'received');
    assert.equal(result.consumerStatuses[0].suppressed, 'consumption_unavailable');
    assert.equal(result.consumerStatuses[0].observedRevisionContentSha256, undefined);
  });
});
