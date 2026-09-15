const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
} = require('../../dist/lib/reporting/ledger/index.js');
const { createHash } = require('node:crypto');

const {
  canonicalJsonV1,
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

/** In-memory `ReportingPendingConsumerStatusStore`. */
function pendingConsumerStatusStore() {
  const entries = new Map();
  const id = key =>
    [
      key.accountId,
      key.deliveryConfigId,
      key.deliveryConfigVersion,
      key.reportDefinitionId,
      key.periodStart,
      key.periodEnd,
    ].join('|');
  return {
    entries,
    async get(key) {
      return entries.get(id(key));
    },
    async put(key, pending) {
      entries.set(id(key), pending);
    },
    async clear(key) {
      entries.delete(id(key));
    },
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

  test('a read that throws is unreadable/transport_failed', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    seller.client.getMediaBuyDelivery = async () => {
      throw new Error('connection reset by peer');
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.postedConsumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(result.postedConsumerStatuses[0].failureCode, 'transport_failed');
    // The provider's own error text is untrusted; the wire carries a closed
    // code precisely so agents dispatch on it instead.
    assert.doesNotMatch(result.postedConsumerStatuses[0].reason, /connection reset/);
  });

  test('a reader that cannot serve the exact revision is unreadable/reader_incompatible', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getMediaBuyDelivery;
    seller.client.getMediaBuyDelivery = async params => {
      // Rows, but no binding: a reader that does not implement the exact
      // revision selector cannot produce consumption evidence, and guessing
      // that the rows are complete would be the forgery this loop must avoid.
      const { reporting_revision_binding: _binding, ...page } = await honest(params);
      return page;
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.postedConsumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(result.postedConsumerStatuses[0].failureCode, 'reader_incompatible');
  });

  test('a metric promised by the pinned definition and absent from the rows is metric_missing', async () => {
    const seller = await harness();
    const at = seller.anchor + DAY + 3 * HOUR;
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    seller.observeAt(at);
    const [revision] = await seller.store.listRevisions(
      [...seller.store.obligations.values()][0].reporting_obligation_id
    );

    // metric_missing is a row-level predicate: it cannot be decided from
    // revision metadata, so it is only reachable once the reconciler has
    // actually consumed the rows.
    const expected = [
      expectedPeriod(seller.request, seller.anchor, {
        committedMetrics: ['impressions', 'spend', 'viewable_impressions'],
      }),
    ];
    const result = await seller.reconcile(at, expected);

    assert.equal(result.postedConsumerStatuses.length, 1);
    const posted = result.postedConsumerStatuses[0];
    assert.equal(posted.consumerStatus, 'content_mismatch');
    assert.equal(posted.mismatchCode, 'metric_missing');
    assert.match(posted.reason, /viewable_impressions/);
    assert.equal(posted.observedRevisionContentSha256, revision.wireRevision.revision_content_sha256);
  });

  test('a lost response does not produce a second statement, and an exact retry replays', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // The seller records the batch and the response never gets back.
    const honest = seller.client.syncReportingStatus;
    let sent;
    seller.client.syncReportingStatus = async params => {
      sent = params;
      await honest(params);
      throw new Error('socket hang up');
    };
    const lost = await seller.reconcile(at, expected);
    assert.equal(seller.store.consumerStatements.length, 1, 'the seller did record it');
    // Recorded, not thrown: a throw from a later batch would discard the record
    // of everything the earlier ones already appended, and those statements are
    // durably the caller's leaves whether or not this call returns.
    assert.deepEqual(lost.postedConsumerStatuses, []);
    assert.equal(lost.failedConsumerStatuses.length, 1);
    assert.match(lost.failedConsumerStatuses[0].errors[0].message, /socket hang up/);

    // Re-plan from scratch against a ledger that discloses nothing about the
    // chain — the case where suppression cannot save the buyer, so the ID and
    // the batch key have to carry the weight on their own. Both are derived
    // from the statement's content, so the reconstructed request is
    // byte-identical to the one whose response was lost.
    seller.client.syncReportingStatus = honest;
    const honestRead = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honestRead(params);
      return {
        ...page,
        consumer_statuses: [],
        periods: page.periods.map(({ current_consumer_status_id: _leaf, ...period }) => ({
          ...period,
          consumer_status_count: 0,
        })),
      };
    };
    let replanned;
    seller.client.syncReportingStatus = async params => {
      replanned = params;
      return honest(params);
    };

    const retry = await seller.reconcile(at + HOUR, expected);
    assert.equal(replanned.idempotency_key, sent.idempotency_key, 'the batch key is derived from the body');
    assert.deepEqual(replanned.statuses, sent.statuses, 'and the body reconstructs byte-identically');
    assert.equal(seller.store.consumerStatements.length, 1, 'a replay is not a second statement');
    assert.equal(retry.postedConsumerStatuses.length, 1, 'the buyer sees it as posted, because it is');
    assert.deepEqual(retry.failedConsumerStatuses, []);

    // With the chain visible again, there is simply nothing left to say.
    seller.client.getReportingStatus = honestRead;
    seller.client.syncReportingStatus = honest;
    const next = await seller.reconcile(at + 2 * HOUR, expected);
    assert.deepEqual(next.postedConsumerStatuses, []);
    assert.equal(next.consumerStatuses[0].suppressed, 'unchanged');
    assert.equal(seller.store.consumerStatements.length, 1);
  });

  test('running out of the read budget stays silent rather than accusing the seller', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A revision that never stops paging. The buyer's own page limit is what
    // ends the read, and a limit the buyer set is not evidence that the seller
    // published bytes it could not consume.
    const honest = seller.client.getMediaBuyDelivery;
    let page = 0;
    seller.client.getMediaBuyDelivery = async params => {
      const { pagination: _cursor, ...firstPage } = params;
      const response = await honest(firstPage);
      page += 1;
      return { ...response, pagination: { has_more: true, cursor: `endless-${page}` } };
    };

    const result = await seller.reconcile(at, expected, { ledgerLimits: { maxPages: 1 } });
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.deepEqual(result.failedConsumerStatuses, []);
    assert.equal(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.notEqual(result.consumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(seller.store.consumerStatements.length, 0, 'nothing was said at all');
  });

  test('the posted wire body carries exactly the fields the statement needs', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const [revision] = await seller.store.listRevisions(
      [...seller.store.obligations.values()][0].reporting_obligation_id
    );
    const obligation = [...seller.store.obligations.values()][0];

    const honest = seller.client.syncReportingStatus;
    let body;
    seller.client.syncReportingStatus = async params => {
      body = params;
      return honest(params);
    };
    const result = await seller.reconcile(at, expected);

    assert.equal(result.postedConsumerStatuses.length, 1, 'posted matches owed');
    assert.equal(body.statuses.length, 1);
    const wire = body.statuses[0];
    assert.deepEqual(Object.keys(wire).sort(), [
      'consumer_status',
      'delivery_config_id',
      'delivery_config_version',
      'observed_revision_content_sha256',
      'period',
      'report_definition_id',
      'reporting_obligation_id',
      'reporting_revision_id',
      'reporting_status_id',
      'status_as_of',
    ]);
    assert.equal(wire.consumer_status, 'received');
    assert.equal(wire.reporting_obligation_id, obligation.reporting_obligation_id);
    assert.equal(wire.reporting_revision_id, revision.reporting_revision_id);
    assert.equal(wire.observed_revision_content_sha256, revision.wireRevision.revision_content_sha256);
    assert.deepEqual(wire.period, {
      start: new Date(seller.anchor).toISOString(),
      end: new Date(seller.anchor + DAY).toISOString(),
      source_timezone: 'UTC',
    });
    assert.match(wire.reporting_status_id, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.match(body.idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    // No chain pointer on the first statement, and no failure/mismatch fields
    // on a clean read — the spec forbids carrying either here.
    assert.equal(wire.supersedes_reporting_status_id, undefined);
    assert.equal(wire.mismatch_code, undefined);
    assert.equal(wire.failure_code, undefined);
  });

  test('a lost received response replays byte-identically when the statement is remembered', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const pending = pendingConsumerStatusStore();

    const honestPost = seller.client.syncReportingStatus;
    let sent;
    seller.client.syncReportingStatus = async params => {
      sent = params;
      await honestPost(params);
      throw new Error('socket hang up');
    };
    const lost = await seller.reconcile(at, expected, { pendingConsumerStatusStore: pending });
    assert.equal(lost.failedConsumerStatuses.length, 1);
    assert.equal(seller.store.consumerStatements.length, 1);
    assert.equal(seller.store.consumerStatements[0].consumer_status, 'received');
    assert.equal(pending.entries.size, 1, 'an unconfirmed statement is remembered');

    // Re-plan against a ledger that discloses nothing about the chain, so
    // suppression cannot help — and re-consume, so `consumedAt` genuinely moves.
    const honestRead = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honestRead(params);
      return {
        ...page,
        consumer_statuses: [],
        periods: page.periods.map(({ current_consumer_status_id: _leaf, ...period }) => ({
          ...period,
          consumer_status_count: 0,
        })),
      };
    };
    let replanned;
    seller.client.syncReportingStatus = async params => {
      replanned = params;
      return honestPost(params);
    };

    const retry = await seller.reconcile(at + HOUR, expected, { pendingConsumerStatusStore: pending });
    // `status_as_of` for received is the buyer's own consumption instant and
    // cannot be re-derived, so the statement is replayed rather than rebuilt.
    assert.deepEqual(replanned.statuses, sent.statuses, 'byte-identical body');
    assert.equal(replanned.idempotency_key, sent.idempotency_key, 'and therefore the same batch key');
    assert.equal(seller.store.consumerStatements.length, 1, 'a replay is not a second statement');
    assert.deepEqual(retry.failedConsumerStatuses, [], 'a replay is not an idempotency conflict either');
    assert.equal(retry.postedConsumerStatuses.length, 1);
    assert.equal(pending.entries.size, 0, 'and once confirmed it is forgotten');
  });

  test('one pathologically paginating revision does not starve the next one', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + 2 * DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + 2 * DAY + HOUR), maxIterations: 4 });
    const obligations = [...seller.store.obligations.values()].sort((left, right) =>
      left.period.start.localeCompare(right.period.start)
    );
    assert.equal(obligations.length, 2, 'two elapsed periods');
    const revisions = await Promise.all(
      obligations.map(async value => (await seller.store.listRevisions(value.reporting_obligation_id))[0])
    );
    assert.ok(revisions[0] && revisions[1], 'both periods published');
    const at = seller.anchor + 2 * DAY + 3 * HOUR;
    seller.observeAt(at);
    const expected = [
      expectedPeriod(seller.request, seller.anchor),
      expectedPeriod(seller.request, seller.anchor + DAY),
    ];

    // Only the first revision pages forever. Its per-revision page limit is its
    // own problem: latching on it would suppress every revision ordered after
    // it, run after run, with no read attempted.
    const honest = seller.client.getMediaBuyDelivery;
    let page = 0;
    seller.client.getMediaBuyDelivery = async params => {
      if (params.reporting_revision_id !== revisions[0].reporting_revision_id) return honest(params);
      // Always the first page, always claiming another one follows.
      const { pagination: _cursor, ...firstPage } = params;
      const response = await honest(firstPage);
      page += 1;
      return { ...response, pagination: { has_more: true, cursor: `endless-${page}` } };
    };

    const result = await seller.reconcile(at, expected, { ledgerLimits: { maxPages: 2 } });
    const byPeriod = new Map(result.consumerStatuses.map(plan => [plan.period.start, plan]));
    const first = byPeriod.get(new Date(seller.anchor).toISOString());
    const second = byPeriod.get(new Date(seller.anchor + DAY).toISOString());

    assert.equal(first.suppressed, 'local_budget_exhausted');
    assert.equal(second.suppressed, undefined, 'the healthy revision was still read');
    assert.equal(second.consumerStatus, 'received');
    assert.equal(second.observedRevisionContentSha256, revisions[1].wireRevision.revision_content_sha256);
    assert.equal(result.postedConsumerStatuses.length, 1);
  });

  test('a batch that fails keeps the statuses earlier batches already posted', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // More owed statuses than fit in one request, so the posting loop runs
    // twice. Periods before the accepted generation opened, so every one is
    // obligation_missing and none collides with the seller's real obligation.
    const expected = Array.from({ length: 101 }, (_unused, index) =>
      expectedPeriod(seller.request, seller.anchor - (index + 1) * DAY)
    );

    // Stubbed: what is under test is the reconciler's accounting across
    // batches, not the seller's acceptance rules for each statement.
    const batches = [];
    seller.client.syncReportingStatus = async params => {
      batches.push(params);
      if (batches.length > 1) throw new Error('gateway timeout');
      return {
        status: 'completed',
        results: params.statuses.map(status => ({
          result: 'recorded',
          consumer_status: { ...status, recorded_at: new Date(at).toISOString() },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);

    assert.equal(batches.length, 2, 'the schema caps a batch at 100 statuses');
    assert.equal(batches[0].statuses.length, 100);
    assert.equal(batches[1].statuses.length, 1);
    // The first batch is durably the caller's leaves whether or not the second
    // one worked, so throwing it away would misreport what the buyer owes.
    assert.equal(result.postedConsumerStatuses.length, 100);
    assert.equal(result.failedConsumerStatuses.length, 1);
    assert.match(result.failedConsumerStatuses[0].errors[0].message, /gateway timeout/);
  });

  test('a buyer-set record limit suppresses instead of accusing the seller', async () => {
    const seller = await harness({
      rows: [
        { media_buy_id: 'fixture-media-buy', impressions: 3, spend: '1.2500' },
        { media_buy_id: 'fixture-media-buy', impressions: 4, spend: '1.5000' },
      ],
    });
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // maxRecords is the buyer's own knob. Exceeding it used to post
    // unreadable/transport_failed, pinning the buyer's view at action_required
    // against a seller whose revision was perfectly readable.
    const result = await seller.reconcile(at, expected, { ledgerLimits: { maxRevisionRows: 1 } });

    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.deepEqual(result.failedConsumerStatuses, []);
    assert.equal(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.notEqual(result.consumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(seller.store.consumerStatements.length, 0);
  });

  test('a revision that does not meet required_finality is revision_missing, not received', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // The generation requires an official revision; the seller has published
    // only a snapshot. Posting `received` would affirmatively clear the exact
    // condition this loop exists to surface.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return { ...page, periods: page.periods.map(period => ({ ...period, required_finality: 'official' })) };
    };
    const expected = [expectedPeriod(seller.request, seller.anchor, { requiredFinality: 'official' })];

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.consumerStatus, 'revision_missing');
    assert.match(plan.reason, /FINALITY_NOT_MET/);
    assert.equal(plan.reportingRevisionId, undefined, 'the schema forbids naming a revision here');
  });

  test('a leaf the seller dates in the future does not become the buyer floor', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    await seller.reconcile(at, expected);
    assert.equal(seller.store.consumerStatements.length, 1);

    // `time` floors a new statement at the leaf's status_as_of, and the leaf is
    // a record the seller hands back. Adopting it unchecked lets a seller date
    // the buyer's own durable statement arbitrarily far ahead — and the floor
    // then applies to every later statement on the chain, permanently.
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + 4 * HOUR), maxIterations: 2 });
    seller.observeAt(seller.anchor + DAY + 5 * HOUR);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        consumer_statuses: (page.consumer_statuses ?? []).map(statement => ({
          ...statement,
          status_as_of: '9999-01-01T00:00:00.000Z',
        })),
      };
    };

    const result = await seller.reconcile(seller.anchor + DAY + 5 * HOUR, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    const posted = result.postedConsumerStatuses[0];
    assert.equal(posted.consumerStatus, 'received');
    assert.ok(Date.parse(posted.statusAsOf) < Date.parse('9999-01-01T00:00:00.000Z'));
    // Accepted by the real seller, which rejects unreasonable future timestamps.
    assert.deepEqual(result.failedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 2);
  });

  test('two expected periods on one chain post once and report the collision', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // `batch_identity` makes the seller reject every duplicate-chain entry in a
    // batch without evaluating supersession, so posting both means neither
    // lands — on every run, forever.
    const expected = [
      expectedPeriod(seller.request, seller.anchor),
      expectedPeriod(seller.request, seller.anchor, { destinationRef: 'other-destination' }),
    ];

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.failedConsumerStatuses.length, 1);
    assert.equal(result.failedConsumerStatuses[0].errors[0].code, 'DUPLICATE_STATUS_CHAIN');
    assert.equal(seller.store.consumerStatements.length, 1);
  });

  test('the monotonicity floor lifts a later statement to the leaf it supersedes', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    seller.client.getMediaBuyDelivery = async () => {
      throw new Error('connection reset by peer');
    };
    const first = await seller.reconcile(at, expected);
    assert.equal(first.postedConsumerStatuses[0].consumerStatus, 'unreadable');
    const leafAt = seller.store.consumerStatements[0].status_as_of;

    // The revision vanishes, so the next claim is revision_missing — whose own
    // instant is expected_at, long before the unreadable leaf. `time` forbids
    // the chain from moving backwards, so the floor has to lift it.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        revisions: [],
        pagination: { ...page.pagination, total_count: page.pagination.total_count - page.revisions.length },
      };
    };

    const second = await seller.reconcile(at + HOUR, expected);
    const plan = second.consumerStatuses[0];
    assert.equal(plan.consumerStatus, 'revision_missing');
    assert.ok(
      Date.parse(plan.statusAsOf) > seller.anchor + DAY + SLA_SECONDS * 1_000,
      'expected_at alone would have dated this before the leaf'
    );
    assert.equal(plan.statusAsOf, leafAt, 'so it is floored at the leaf it supersedes');
    assert.deepEqual(second.failedConsumerStatuses, []);
  });

  test('an unreadable expected_at with no usable schedule suppresses and says whose field it is', async () => {
    const seller = await harness();
    // No buyer SLA pin either, so nothing can derive a deadline.
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `Date.parse` accepts this spelling; RFC 3339 does not. It used to flow
    // straight through to `status_as_of` on a statement the buyer signs.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: page.periods.map(({ schedule: _schedule, ...period }) => ({
          ...period,
          expected_at: 'Mon, 02 Sep 2026 01:00:00 GMT',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.suppressed, 'deadline_unknown');
    // The field belongs to the seller's obligation, and it *was* recorded —
    // the buyer just could not read it. The old wording said the opposite of
    // both, and pointed at a field that does not exist on ExpectedReportingPeriod.
    assert.match(plan.reason, /seller's obligation\.expected_at/);
    assert.match(plan.reason, /Mon, 02 Sep 2026/, 'the offending value is quoted so it can be grepped');
    assert.doesNotMatch(plan.reason, /was not recorded/);
    assert.equal(plan.deadline, undefined);
    assert.notEqual(plan.statusAsOf, 'Mon, 02 Sep 2026 01:00:00 GMT');
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 0);
  });

  /**
   * Drive the `schedule.delivery_sla` fallback with full control of the period
   * end. No revision is published, so the status is `revision_missing` and its
   * `status_as_of` is exactly the derived `expected_at`.
   */
  async function scheduledExpectedAt({ periodStart, periodEnd, deliverySla, periodTimezone = 'UTC' }) {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    // The seller's observation boundary stays where its own ledger is coherent;
    // only the buyer's reconcile clock moves, which is what `overdue` reads.
    seller.observeAt(seller.anchor + DAY + 3 * HOUR);
    const at = Date.parse(periodEnd) + 400 * DAY;
    // This case is about the instant the buyer derives, not about posting it.
    delete seller.client.syncReportingStatus;
    // No buyer pin: the obligation's own schedule must be the only path.
    const { deliverySlaSeconds: _pin, ...base } = expectedPeriod(seller.request, seller.anchor);
    const expected = [{ ...base, periodStart, periodEnd }];

    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      // The summary view carries no `periods`, and it shares this client.
      return {
        ...page,
        // `expected_at` is omitted, not malformed: an unreadable one derives
        // nothing on purpose, so the schedule is the path under test here.
        periods: (page.periods ?? []).map(({ expected_at: _absent, ...period }) => ({
          ...period,
          period: { ...period.period, start: periodStart, end: periodEnd },
          schedule: { ...period.schedule, delivery_sla: deliverySla, period_timezone: periodTimezone },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    return result.consumerStatuses[0];
  }

  test('a calendar delivery_sla resolves; the schema permits P1M and P1Y', async () => {
    // `reporting-schedule.json` allows Y and M on `delivery_sla`, and this
    // SDK's own validator accepts them — so a parser that understood only
    // D/H/M/S silenced a conformant seller, which is the failure this fallback
    // exists to prevent.
    const monthly = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P1M',
    });
    // The helper unwires the poster, so `posting_unavailable` is expected; what
    // matters is that the deadline resolved rather than falling to
    // `deadline_unknown`.
    assert.notEqual(monthly.suppressed, 'deadline_unknown', 'P1M is resolvable, not a reason to fall silent');
    assert.equal(monthly.statusAsOf, '2026-10-02T00:00:00.000Z');

    const yearly = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P1Y',
    });
    assert.equal(yearly.statusAsOf, '2027-09-02T00:00:00.000Z');
  });

  test('a calendar month clamps to month end rather than overflowing', async () => {
    // Jan 31 + P1M is the last day of February, not March 3. This is the one
    // place ISO duration implementations genuinely differ, so it is pinned.
    const nonLeap = await scheduledExpectedAt({
      periodStart: '2026-01-30T00:00:00.000Z',
      periodEnd: '2026-01-31T00:00:00.000Z',
      deliverySla: 'P1M',
    });
    assert.equal(nonLeap.statusAsOf, '2026-02-28T00:00:00.000Z');

    const leap = await scheduledExpectedAt({
      periodStart: '2028-01-30T00:00:00.000Z',
      periodEnd: '2028-01-31T00:00:00.000Z',
      deliverySla: 'P1M',
    });
    assert.equal(leap.statusAsOf, '2028-02-29T00:00:00.000Z', 'a leap year has the 29th to clamp to');

    const acrossLeapDay = await scheduledExpectedAt({
      periodStart: '2028-02-28T00:00:00.000Z',
      periodEnd: '2028-02-29T00:00:00.000Z',
      deliverySla: 'P1Y',
    });
    assert.equal(acrossLeapDay.statusAsOf, '2029-02-28T00:00:00.000Z', 'Feb 29 + P1Y has no Feb 29 to land on');
  });

  test('calendar arithmetic happens in the schedule period_timezone', async () => {
    // `period_timezone` is "Required IANA timezone for ... calendar
    // arithmetic", and the point of requiring it is that a fixed offset cannot
    // express a DST transition. Midnight in New York stays midnight across one.
    const acrossDst = await scheduledExpectedAt({
      periodStart: '2026-02-28T05:00:00.000Z',
      periodEnd: '2026-03-01T05:00:00.000Z',
      deliverySla: 'P1M',
      periodTimezone: 'America/New_York',
    });
    // 2026-03-01T05:00Z is midnight EST; 2026-04-01 midnight is EDT (-4).
    assert.equal(acrossDst.statusAsOf, '2026-04-01T04:00:00.000Z');

    const unknownZone = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P1M',
      periodTimezone: 'Mars/Olympus_Mons',
    });
    assert.equal(unknownZone.suppressed, 'deadline_unknown', 'an unresolvable zone derives nothing, not a guess');
  });

  test('a period ending before year 1 derives nothing rather than relocating it', async () => {
    // `zonedParts` refuses a BC era. Without that refusal a `P1M` from a
    // year-zero period end silently resolved a year later — a live, overdue
    // deadline for a period the buyer never agreed to.
    const plan = await scheduledExpectedAt({
      periodStart: '0000-05-01T00:00:00.000Z',
      periodEnd: '0000-06-01T00:00:00.000Z',
      deliverySla: 'P1M',
      periodTimezone: 'UTC',
    });
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.equal(plan.deadline, undefined);
  });

  test('utc alignment resolves the calendar in UTC, not in the seller echoed zone', async () => {
    // The schema forbids `period_timezone` for `utc` alignment, so the zone has
    // to come from the alignment itself. Falling through to the obligation's
    // `source_timezone` instead put the calendar an hour out across a DST
    // change — silently, and only for periods that straddle one.
    const seller = await harness();
    const { deliverySlaSeconds: _pin, ...base } = expectedPeriod(seller.request, seller.anchor);
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    seller.observeAt(seller.anchor + DAY + 3 * HOUR);
    delete seller.client.syncReportingStatus;
    const periodStart = '2026-10-14T00:00:00.000Z';
    const periodEnd = '2026-10-15T00:00:00.000Z';
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, ...period }) => ({
          ...period,
          period: { ...period.period, start: periodStart, end: periodEnd, source_timezone: 'America/New_York' },
          schedule: { ...period.schedule, delivery_sla: 'P1M', alignment: 'utc', period_timezone: undefined },
        })),
      };
    };

    const result = await seller.reconcile(Date.parse(periodEnd) + 400 * DAY, [{ ...base, periodStart, periodEnd }]);
    // 2026-11-15 in UTC plus the one-hour recovery window. Resolved in New York
    // the same calendar step lands an hour later, because November 15 is EST
    // while October 15 was EDT.
    assert.equal(result.consumerStatuses[0].deadline, '2026-11-15T01:00:00.000Z');
  });

  test('an out-of-range delivery_sla derives nothing instead of throwing', async () => {
    // The schema's `delivery_sla` pattern puts no bound on the digit count, so
    // `P999999999D` is a legal value a seller can send. It lands outside the
    // representable time range, where `toISOString` throws — and this call site
    // has nothing to catch it, so the whole reconcile would abort on one
    // seller-supplied string.
    const plan = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P999999999D',
    });
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.equal(plan.deadline, undefined);

    // Years and months take a different path to the same place.
    // P8000Y is the value the range guard actually exists for: it resolves
    // fine, but `toISOString` renders a year past 9999 in expanded form
    // (`+010026-…`), which is not a valid instant. `P999999999Y` overflows to
    // NaN inside `Date` and is caught regardless, so it proves nothing.
    const centuries = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P8000Y',
    });
    assert.equal(centuries.suppressed, 'deadline_unknown');
    assert.doesNotMatch(String(centuries.statusAsOf ?? ''), /^\+/);
  });

  test('an overflowing deadline names the field that overflowed, not an innocent one', async () => {
    // The diagnostic used to hardcode `automatedRecoveryWindowSeconds` for
    // every overflow, so an adopter with a conformant window was sent to lower
    // it while the seller's `P1DT99999999H` went unmentioned. Naming the wrong
    // field is worse than naming none.
    const fromSchedule = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P1DT99999999H',
    });
    assert.equal(fromSchedule.suppressed, 'deadline_unknown');
    assert.match(fromSchedule.reason, /schedule\.delivery_sla/);
    assert.doesNotMatch(fromSchedule.reason, /automatedRecoveryWindowSeconds/);

    // Calendar years take a different code path to the same answer. It used to
    // land on `missing_pin` — "record ExpectedReportingPeriod.deliverySlaSeconds
    // to derive one" — for a seller duration the adopter has no pin for and did
    // not send.
    const fromCalendar = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'P999999999Y',
    });
    assert.equal(fromCalendar.suppressed, 'deadline_unknown');
    assert.match(fromCalendar.reason, /schedule\.delivery_sla/);
    assert.doesNotMatch(fromCalendar.reason, /record ExpectedReportingPeriod/);
  });

  test('an overflowing buyer pin names the pin, not the seller schedule', async () => {
    const seller = await harness();
    // The buyer's own recorded offset overflows. Reporting that as a *missing*
    // pin tells the adopter to record a value they already recorded.
    const expected = [
      { ...expectedPeriod(seller.request, seller.anchor), deliverySlaSeconds: Number.MAX_SAFE_INTEGER },
    ];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // The seller's own `expected_at` takes precedence when present, so it is
    // dropped here to leave the buyer's pin as the path under test.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, schedule: _s, ...period }) => period),
      };
    };

    const plan = (await seller.reconcile(at, expected)).consumerStatuses[0];
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.match(plan.reason, /ExpectedReportingPeriod\.deliverySlaSeconds puts it outside/);
    assert.doesNotMatch(plan.reason, /record ExpectedReportingPeriod/);
    assert.doesNotMatch(plan.reason, /delivery_sla\b.*schedule|schedule\.delivery_sla/);
  });

  test('a seller cannot push the deadline out past the buyer own pin', async () => {
    const seller = await harness();
    // The buyer pinned its own clock, which is the whole point of the pin.
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A seller that has published nothing drops `expected_at` and advertises a
    // ten-year SLA. Consulting `schedule` ahead of the pin let it push its own
    // deadline a decade out, so the period never went overdue and the
    // `revision_missing` recording the non-delivery was never posted — with no
    // diagnostic, because nothing was suppressed. `schedule` is as
    // seller-controlled as `expected_at`; the pin is the buyer's independent
    // answer and has to outrank it.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _dropped, ...period }) => ({
          ...period,
          schedule: { ...period.schedule, delivery_sla: 'P10Y', period_timezone: 'UTC' },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.deadline, new Date(seller.anchor + DAY + (SLA_SECONDS + RECOVERY_SECONDS) * 1_000).toISOString());
    assert.equal(plan.overdue, true, 'the buyer pin decides, so the period is owed');
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.postedConsumerStatuses[0].consumerStatus, 'revision_missing');
  });

  test('a deadline past the representable range suppresses instead of throwing', async () => {
    const seller = await harness();
    // No pin, so the seller's schedule governs and can reach the range edge.
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `expected_at` is range-checked where it is derived, but the recovery
    // window is added afterwards — so a value just inside the range plus the
    // advertised window lands outside it, and `toISOString` threw from a call
    // site nothing wraps, aborting the entire reconcile.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _dropped, ...period }) => ({
          ...period,
          // Lands just inside 9999-12-31, so `expected_at` itself resolves and
          // only the added recovery window crosses the boundary.
          schedule: { ...period.schedule, delivery_sla: 'PT251613993599S', period_timezone: 'UTC' },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    assert.equal(result.consumerStatuses[0].deadline, undefined);
    // The overflow came from the window, not from a pin the adopter forgot.
    assert.match(result.consumerStatuses[0].reason, /automatedRecoveryWindowSeconds/);
    assert.doesNotMatch(result.consumerStatuses[0].reason, /record ExpectedReportingPeriod/);
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a seller source_timezone disagreeing with the buyer pin is reported, not silenced', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'UTC' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // Suppressing this was a net loss, measured: the buyer that recorded a pin
    // went permanently silent while the buyer that recorded none posted the
    // `content_mismatch`, so one seller config change silenced exactly the
    // careful adopters. `buyer_duty` wants a statement either way, and the
    // seller's own spelling is the only one its byte-wise ingest accepts.
    //
    // Set on the seller's own configuration too, so the echo is genuine and its
    // `validateStatus` compares against the same value the buyer posts.
    for (const obligation of seller.store.obligations.values()) obligation.period.sourceTimezone = 'America/New_York';
    for (const configuration of seller.store.configurations.values()) configuration.sourceTimezone = 'America/New_York';

    const first = await seller.reconcile(at, expected);
    assert.notEqual(
      first.consumerStatuses[0].suppressed,
      'period_identity_unknown',
      'suppressing silenced exactly the buyers careful enough to pin a zone'
    );
    assert.deepEqual(first.consumerStatuses[0].periodZoneBeyondPin, {
      declared: 'America/New_York',
      pinned: 'UTC',
    });
    assert.equal(first.postedConsumerStatuses.length, 1, 'the statement lands, under the seller value');
    assert.deepEqual(first.failedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements[0].period.source_timezone, 'America/New_York');
  });

  test('a seller re-spelling one zone does not fork the buyer own chain', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'UTC' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // The claim that once justified suppressing a zone disagreement — that
    // adopting the seller's echo forks the chain — is false, and this pins it.
    // `period.source_timezone` is in neither `currentConsumerLeaf`'s key nor
    // `sameConsumerStatement`'s comparison, so a seller cycling link spellings
    // of one zone leaves a single statement and reports `unchanged`.
    const spellings = ['UTC', 'Etc/UTC', 'Zulu'];
    for (const [index, zone] of spellings.entries()) {
      for (const obligation of seller.store.obligations.values()) obligation.period.sourceTimezone = zone;
      for (const configuration of seller.store.configurations.values()) configuration.sourceTimezone = zone;
      const result = await seller.reconcile(at + index * HOUR, expected);
      assert.equal(
        result.consumerStatuses[0].periodZoneBeyondPin,
        undefined,
        `${zone} is the same zone as the pin, so no alarm`
      );
    }
    assert.equal(seller.store.consumerStatements.length, 1, 'one statement across three spellings');
  });

  test('a buyer pin agreeing with the seller echo posts once and then says unchanged', async () => {
    const seller = await harness();
    // The producer's own zone, so pin and echo agree. This is the case the
    // rotation test used to cover: the statement lands once and every later
    // reconcile recognises its own leaf instead of appending a duplicate.
    const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'UTC' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    const first = await seller.reconcile(at, expected);
    const second = await seller.reconcile(at + HOUR, expected);
    assert.equal(first.postedConsumerStatuses.length, 1);
    assert.equal(second.consumerStatuses[0].suppressed, 'unchanged');
    assert.equal(seller.store.consumerStatements.length, 1, 'one statement, not one per reconcile');
    assert.equal(seller.store.consumerStatements[0].period.source_timezone, 'UTC');
  });

  test('an unreadable buyer pin is reported, not routed around', async () => {
    const seller = await harness();
    // The pin exists so the *adopter* decides the chain key. Falling through to
    // the seller's echo on a typo posted a durable statement under a key the
    // adopter never chose, and said nothing about it — the one outcome a pin is
    // supposed to make impossible.
    const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'Not/AZone' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'period_identity_unknown');
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 0);
    // And specifically not the seller's 'UTC', silently adopted.
    assert.notEqual(result.consumerStatuses[0].period.source_timezone, 'Not/AZone');
  });

  test('a slash-free IANA link is accepted, because the spec says name or link', async () => {
    const seller = await harness();
    // `iana_timezone`: "a recognized IANA Time Zone Database zone name **or
    // link**". Links have no slash — Japan, GB, EET, Zulu — and this repo's own
    // producer accepts them, so a buyer that required one would refuse a
    // configuration its own seller had already accepted, then be refused by
    // that seller for echoing a substituted zone on every statement forever.
    const { periodSourceTimezone: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // Set on the seller's own obligation, so the echo is genuine and the
    // seller's `validateStatus` compares against the same value.
    for (const obligation of seller.store.obligations.values()) obligation.period.sourceTimezone = 'Japan';
    for (const configuration of seller.store.configurations.values()) configuration.sourceTimezone = 'Japan';

    const result = await seller.reconcile(at, expected);
    assert.equal(
      result.consumerStatuses[0].period.source_timezone,
      'Japan',
      'adopted verbatim, not substituted with UTC'
    );
    // Adoption is only half of it: the seller compares this value strictly, so
    // a substituted zone is refused on every statement forever.
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.deepEqual(result.failedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements[0].period.source_timezone, 'Japan');
  });

  test('a numeric-offset source_timezone is refused rather than substituted', async () => {
    const seller = await harness();
    // No buyer pin, so the seller's echo is the only candidate.
    const { periodSourceTimezone: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `iana_timezone` is a MUST: "do not silently substitute the host timezone
    // or a numeric offset". Node's Intl *accepts* "+05:30" as a timeZone, so a
    // length check alone would adopt it into the durable statement and then
    // compute against a fixed offset with no DST transitions.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({
          ...period,
          period: { ...period.period, source_timezone: '+05:30' },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    // Refused *and* not substituted. Falling back to 'UTC' would put a value in
    // the chain's logical key that the seller never sent, and the seller
    // compares it strictly — so the statement is refused on every run forever,
    // with no diagnostic. Silence with a named cause is the honest outcome.
    assert.equal(result.consumerStatuses[0].suppressed, 'period_identity_unknown');
    assert.match(result.consumerStatuses[0].reason, /not a recognized IANA zone/);
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 0);
  });

  test('an unrecorded recovery window is reported, not mistaken for not-yet-due', async () => {
    const seller = await harness();
    // The commonest misconfiguration on this surface: the window is advertised
    // on the delivery capabilities, not the obligation, so the ledger cannot
    // supply it and an adopter who never recorded it posts nothing, forever.
    // Narrowing `deadline_unknown` to the two missing statuses made that render
    // exactly like a healthy period that is simply not due yet.
    const { automatedRecoveryWindowSeconds: _window, ...withoutWindow } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutWindow];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.consumerStatus, 'received', 'a healthy seller, so the status itself is fine');
    assert.equal(plan.suppressed, 'deadline_unknown', 'and the silence is explained');
    assert.match(plan.reason, /automatedRecoveryWindowSeconds/);
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('an official generation with no pin at all is told to record the spec-defined offset', async () => {
    const seller = await harness();
    // Reached only when *neither* offset is recorded, so there is no consumed
    // field to name. `reporting-schedule.json` defines `delivery_sla` and
    // nothing else — `official_after` appears nowhere in the 3.2.0-rc.3
    // schemas — so naming only the SDK-local extension sent adopters to a field
    // the spec does not have. The earlier premise here, that a `delivery_sla`
    // -derived official instant is refused by the seller, was measured false.
    const { deliverySlaSeconds: _pin, ...base } = expectedPeriod(seller.request, seller.anchor);
    const expected = [{ ...base, requiredFinality: 'official' }];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, schedule: _schedule, ...period }) => ({
          ...period,
          required_finality: 'official',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.match(plan.reason, /record ExpectedReportingPeriod\.deliverySlaSeconds/, 'the spec-defined field first');
    assert.match(plan.reason, /officialAfterSeconds/, 'and the extension offered second');
  });

  test('a forked revision chain suppresses rather than blaming the seller', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // Two unsuperseded heads: no single current revision exists.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [first] = page.revisions;
      if (!first) return page;
      const fork = { ...first, reporting_revision_id: `${first.reporting_revision_id}-fork` };
      return {
        ...page,
        revisions: [...page.revisions, fork],
        pagination: { ...page.pagination, total_count: page.pagination.total_count + 1 },
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.suppressed, 'chain_indeterminate');
    assert.match(plan.reason, /forks/);
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 0, 'silence, not a statement about the seller');
  });

  test('a head naming a predecessor the buyer never saw is not attested as received', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // Exactly one head — so the chain *does* resolve — but it supersedes a
    // revision the seller never disclosed. This is the case the earlier fork
    // test could not reach: `AMBIGUOUS_REVISION_CHAIN` always leaves zero
    // heads, so only `REVISION_PREDECESSOR_MISSING` exercises suppression on a
    // resolved head. Without it the buyer confidently attests `received` for a
    // revision it cannot prove is current.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [head] = page.revisions;
      if (!head) return page;
      return {
        ...page,
        revisions: [{ ...head, supersedes_reporting_revision_id: `${head.reporting_revision_id}-undisclosed` }],
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.suppressed, 'chain_indeterminate');
    assert.match(plan.reason, /predecessor/);
    // The head that could not be proven current is named. Collapsing this to a
    // bare "no head could not be proven current" is both untrue here and
    // useless: the adopter's next step is to ask the seller about *this*
    // revision, and there is no other way to learn which one it was.
    const [head] = [...seller.store.revisions.values()];
    assert.ok(head, 'the fixture published a revision');
    assert.match(plan.reason, new RegExp(`the head ${head.reportingRevisionId ?? head.reporting_revision_id} `));
    assert.doesNotMatch(plan.reason, /no head/);
    assert.deepEqual(result.postedConsumerStatuses, []);
    assert.equal(seller.store.consumerStatements.length, 0);
  });

  test('a single seller number that cannot be canonicalized does not abort the run', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `JSON.parse('1e999')` is `Infinity`, which RFC 8785 cannot represent. One
    // such number used to throw out of `reconcileReporting` entirely — after
    // receipts had already been synced — so the caller lost its record of
    // durable work. It is a read failure, not a reason to discard the run.
    const honest = seller.client.getMediaBuyDelivery;
    seller.client.getMediaBuyDelivery = async params => {
      const page = await honest(params);
      return { ...page, reporting_rows: page.reporting_rows.map(row => ({ ...row, impressions: Infinity })) };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1, 'the run completed and reported');
    assert.equal(result.postedConsumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(result.postedConsumerStatuses[0].failureCode, 'reader_incompatible');
  });

  /** Replace every row on every page with `shape`, over `pages` pages. */
  function servesRows(seller, shape, pages) {
    const honest = seller.client.getMediaBuyDelivery;
    let sent = 0;
    seller.client.getMediaBuyDelivery = async params => {
      const { pagination: _cursor, ...firstPage } = params;
      const page = await honest(firstPage);
      sent += 1;
      return {
        ...page,
        reporting_rows: page.reporting_rows.map(row => ({ ...row, ...shape() })),
        pagination: { has_more: sent < pages, cursor: `probe-${sent}` },
      };
    };
    return () => sent;
  }

  test('an ordinary wide row is consumed, not charged into silence', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // ~500 KB of perfectly ordinary row: one array of a hundred thousand
    // numbers. Charging a flat constant per unvisited leaf estimated this at
    // ~393 MB against a 256 MiB ceiling, so the buyer went silent on a seller
    // that had done nothing wrong — the same "buy silence with an alibi" hole
    // as the nesting bomb, just wide instead of deep.
    servesRows(seller, () => ({ samples: Array.from({ length: 100_000 }, (_unused, index) => index) }), 1);

    const result = await seller.reconcile(at, expected);
    assert.notEqual(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    // The rows were read and sized without tripping the ceiling, which is the
    // property under test. The digest then fails because this stub rewrote the
    // rows — reaching that comparison at all is the proof the read completed.
    assert.equal(result.consumerStatuses[0].failureCode, 'integrity_mismatch');
  });

  test('a shallow nesting bomb does not buy silence either', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const pagesSent = servesRows(seller, () => ({ nested: { a: { b: { c: { d: {} } } } } }), 256);

    const result = await seller.reconcile(at, expected, { ledgerLimits: { maxPages: 300 } });
    assert.notEqual(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.equal(pagesSent(), 256, 'the read ran to completion');
  });

  test('empty strings are charged, and maxRevisionBytes makes the ceiling reachable', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // A thousand empty strings. The estimator charges each one a 16-byte floor
    // plus its 8-byte slot, so ~24 KB; charging the string itself zero — the
    // shape this replaced — makes the same row ~8 KB. The ceiling sits between
    // the two, so this row trips it only if the floor is actually applied.
    // Hundreds of megabytes of empty strings slipping past the ceiling was the
    // real hole, and it was invisible at unit scale until this knob existed.
    servesRows(seller, () => ({ blanks: Array.from({ length: 1_000 }, () => '') }), 1);

    const tight = await seller.reconcile(at, expected, { ledgerLimits: { maxRevisionBytes: 16_000 } });
    assert.equal(tight.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.notEqual(tight.consumerStatuses[0].consumerStatus, 'unreadable');
    assert.deepEqual(tight.failedConsumerStatuses, []);

    // And not over-charged: the same row under a ceiling above the estimate is
    // read to completion. Reaching the digest comparison is the proof — the
    // stub rewrote the rows, so `integrity_mismatch` is the expected outcome.
    const roomy = await seller.reconcile(at, expected, { ledgerLimits: { maxRevisionBytes: 64_000 } });
    assert.equal(roomy.consumerStatuses[0].failureCode, 'integrity_mismatch');
  });

  test('primitives are charged too, not only strings', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // The string floor was pinned and the primitive floor was not, so charging
    // numbers zero reverted green. A thousand numbers is ~24 KB with the floor
    // and ~8 KB without it, and the ceiling sits between.
    servesRows(seller, () => ({ counts: Array.from({ length: 1_000 }, (_unused, index) => index) }), 1);

    const tight = await seller.reconcile(at, expected, { ledgerLimits: { maxRevisionBytes: 16_000 } });
    assert.equal(tight.consumerStatuses[0].suppressed, 'local_budget_exhausted');
  });

  test('local_budget_exhausted names the ceiling that tripped', async () => {
    // One sentence for five producers pointed every adopter at `ledgerLimits`,
    // including for ceilings no knob raises. Nothing asserted the string, so it
    // reverted green while two public docblocks promised the opposite.
    const exhaust = async (ledgerLimits, shape) => {
      const seller = await harness({
        rows: [
          { media_buy_id: 'fixture-media-buy', impressions: 3, spend: '1.2500' },
          { media_buy_id: 'fixture-media-buy', impressions: 4, spend: '1.5000' },
        ],
      });
      const expected = [expectedPeriod(seller.request, seller.anchor)];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      if (shape) servesRows(seller, shape, 1);
      return (await seller.reconcile(at, expected, { ledgerLimits })).consumerStatuses[0];
    };

    const rows = await exhaust({ maxRevisionRows: 1 });
    assert.equal(rows.suppressed, 'local_budget_exhausted');
    assert.match(rows.reason, /ledgerLimits\.maxRevisionRows was reached/);

    const bytes = await exhaust({ maxRevisionBytes: 16_000 }, () => ({
      blanks: Array.from({ length: 1_000 }, () => ''),
    }));
    assert.equal(bytes.suppressed, 'local_budget_exhausted');
    assert.match(bytes.reason, /ledgerLimits\.maxRevisionBytes was reached/);
    assert.doesNotMatch(bytes.reason, /maxRevisionRows/, 'the two causes must not read alike');
  });

  test('a row with more containers than the estimator walks is the seller shape', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // Breadth, unlike depth, is the buyer's own walk bound: a per-SKU
    // retail-media breakdown genuinely can be this wide, so it suppresses
    // On the silent side this was a measured ~786 KB purchase of permanent
    // immunity from `content_mismatch`: one row, nesting depth 3, so it never
    // met the depth guard. A quarter of a million containers in one row is no
    // conformant tabular shape — an array of a hundred thousand numbers is one
    // container — so it is accused, like depth, rather than charged to a buyer
    // budget that no knob can raise.
    servesRows(seller, () => ({ wide: Array.from({ length: 300_000 }, () => []) }), 1);

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].failureCode, 'reader_incompatible');
    assert.notEqual(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
  });

  test('the depth the reader walks is 64, not merely some large number', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const nest = depth => {
      let value = {};
      for (let level = 0; level < depth; level += 1) value = { level: value };
      return value;
    };
    // The only other depth test nests 8,000, so it passes at any cap below
    // that and the documented boundary went unpinned.
    servesRows(seller, () => ({ deep: nest(100) }), 1);
    const past = await seller.reconcile(at, expected);
    assert.equal(past.consumerStatuses[0].failureCode, 'reader_incompatible', '100 deep is past the bound');

    const shallow = await harness();
    const shallowExpected = [expectedPeriod(shallow.request, shallow.anchor)];
    await shallow.producer.planObligations(new Date(shallow.anchor + DAY).toISOString());
    await shallow.producer.runWorker({ now: () => new Date(shallow.anchor + DAY + HOUR), maxIterations: 2 });
    const shallowAt = shallow.anchor + DAY + 3 * HOUR;
    shallow.observeAt(shallowAt);
    servesRows(shallow, () => ({ deep: nest(50) }), 1);
    const within = await shallow.reconcile(shallowAt, shallowExpected);
    assert.notEqual(within.consumerStatuses[0].failureCode, 'reader_incompatible', '50 deep is within it');
  });

  test('a row nested deeper than the reader walks is the seller shape, and stays on the record', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // An 8,000-deep array overflowed the estimator's stack. The `RangeError`
    // was caught and posted as `unreadable` / `transport_failed` — the buyer
    // durably accusing the seller of publishing unreadable bytes because of its
    // own call stack.
    servesRows(
      seller,
      () => {
        const root = [];
        let tip = root;
        for (let level = 0; level < 8_000; level += 1) {
          const next = [];
          tip.push(next);
          tip = next;
        }
        return { deep: root };
      },
      1
    );

    const result = await seller.reconcile(at, expected);
    // Depth and breadth are different claims. A 147-byte row nested seventy
    // deep used to suppress the whole period, which let an under-delivering
    // seller escape a `content_mismatch` permanently for the price of one
    // strange row. No conformant tabular row nests this deep, so it stays on
    // the record; breadth remains the buyer's own limit.
    assert.notEqual(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.equal(result.consumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(result.consumerStatuses[0].failureCode, 'reader_incompatible');
    assert.equal(result.postedConsumerStatuses.length, 1);
  });

  test('large strings are charged for what they hold, so the ceiling still binds', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // Strings are sized in O(1) and never consume the container budget, so no
    // amount of padding can hide them from the ceiling.
    servesRows(seller, () => ({ blob: 'x'.repeat(1_000_000) }), 200);

    const result = await seller.reconcile(at, expected, { ledgerLimits: { maxPages: 400 } });
    assert.equal(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a seller-dated expected_at cannot precede the period it describes', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `expected_at` is "the resolved period end plus this duration", so it can
    // never precede the period end. Unclamped, a seller could date the buyer's
    // own durable statement in year 1.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({ ...period, expected_at: '0001-01-01T00:00:00.000Z' })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(
      result.consumerStatuses[0].statusAsOf,
      new Date(seller.anchor + DAY).toISOString(),
      'clamped up to the period end, not year 1'
    );
    // The harness seller's own store still holds the real expected_at, so it
    // refuses this statement — which is the honest outcome for a wire value
    // that contradicts the ledger behind it, and is visible rather than silent.
    assert.equal(result.failedConsumerStatuses.length, 1);
  });

  test('an unreadable expected_at is not rescued by a pin or a schedule', async () => {
    const seller = await harness();
    // Both fallbacks live and both able to produce an instant. The short-circuit
    // is the only thing stopping them, and every other test that touches an
    // unreadable `expected_at` strips them — so without this one, deleting the
    // short-circuit silently reverts documented behaviour: the buyer would post
    // against a deadline the seller does not hold and be refused every run.
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    let sawSchedule = false;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => {
          sawSchedule = typeof period.schedule?.delivery_sla === 'string';
          return { ...period, expected_at: 'not-a-date' };
        }),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(sawSchedule, true, 'the schedule fallback was available');
    assert.equal(expected[0].deliverySlaSeconds, SLA_SECONDS, 'and so was the buyer pin');
    assert.equal(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    assert.match(result.consumerStatuses[0].reason, /seller has to correct it/);
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a nonexistent local time advances by the gap and an ambiguous one takes the earlier offset', async () => {
    // The two halves of `period_generation`'s DST rule, at real transitions.
    // The existing timezone test sits four weeks from any transition, so it
    // proves a conversion happens and nothing about the edges.
    const gap = await scheduledExpectedAt({
      periodStart: '2026-02-07T07:30:00.000Z',
      periodEnd: '2026-02-08T07:30:00.000Z',
      deliverySla: 'P1M',
      periodTimezone: 'America/New_York',
    });
    // 02:30 on 2026-03-08 does not exist; advancing by the one-hour gap gives
    // 03:30 EDT.
    assert.equal(gap.statusAsOf, '2026-03-08T07:30:00.000Z');

    const ambiguous = await scheduledExpectedAt({
      periodStart: '2026-09-30T05:30:00.000Z',
      periodEnd: '2026-10-01T05:30:00.000Z',
      deliverySla: 'P1M',
      periodTimezone: 'America/New_York',
    });
    // 01:30 on 2026-11-01 happens twice; the earlier offset is EDT.
    assert.equal(ambiguous.statusAsOf, '2026-11-01T05:30:00.000Z');
  });

  test('a pure-time delivery_sla is exact, including across an ambiguous local hour', async () => {
    // `PT{n}S` is the only shape this SDK's own seller emits. Routing it
    // through wall-clock conversion shifted `PT0S` by an hour at a DST
    // boundary and dropped sub-second precision.
    // A pure-time SLA is elapsed time and needs no calendar at all, so it must
    // resolve even when the zone does not. Routing it through wall-clock
    // conversion made it depend on a timezone it has no business consulting:
    // an unrecognized `period_timezone` then silenced a seller whose deadline
    // was perfectly computable.
    const exact = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-02T00:00:00.000Z',
      deliverySla: 'PT3600S',
      periodTimezone: 'Mars/Olympus_Mons',
    });
    assert.notEqual(exact.suppressed, 'deadline_unknown');
    assert.equal(exact.statusAsOf, '2026-09-02T01:00:00.000Z');

    const subSecond = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.500Z',
      periodEnd: '2026-09-02T00:00:00.500Z',
      deliverySla: 'PT3600S',
      periodTimezone: 'UTC',
    });
    assert.equal(subSecond.statusAsOf, '2026-09-02T01:00:00.500Z', 'sub-second precision preserved');
  });

  test('a calendar delivery_sla carries the anchor sub-second remainder', async () => {
    const plan = await scheduledExpectedAt({
      periodStart: '2026-09-01T00:00:00.250Z',
      periodEnd: '2026-09-02T00:00:00.250Z',
      deliverySla: 'P1M',
      periodTimezone: 'UTC',
    });
    assert.equal(plan.statusAsOf, '2026-10-02T00:00:00.250Z');
  });

  test('a leaf status_as_of is normalized before it becomes the buyer floor', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    await seller.reconcile(at, expected);
    assert.equal(seller.store.consumerStatements.length, 1);

    // The leaf's spelling feeds the monotonicity floor, which feeds
    // `status_as_of`, which feeds `reporting_status_id`. An equivalent
    // spelling must not produce a different chain.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        consumer_statuses: (page.consumer_statuses ?? []).map(statement => ({
          ...statement,
          // Strictly later than expected_at, so the floor genuinely comes from
          // the leaf; at equal instants `latestInstant` keeps the first and the
          // leaf's spelling never surfaces.
          status_as_of: '2026-09-02T03:00:00+00:00',
        })),
      };
    };

    const result = await seller.reconcile(at + HOUR, expected);
    assert.equal(result.consumerStatuses[0].statusAsOfFloor, '2026-09-02T03:00:00.000Z', 'normalized, not echoed');
  });

  test('a calendar-invalid expected_at is unreadable whatever offset it carries', async () => {
    const seller = await harness();
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // February 30th. `Date.parse` rolls it forward, and checking the *parsed*
    // result cannot tell that roll apart from a legitimate offset moving the
    // UTC date — which is why an earlier version only caught the `Z` form and
    // relocated this one to March 1st.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ schedule: _schedule, ...period }) => ({
          ...period,
          expected_at: '2026-02-30T00:00:00+01:00',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    assert.doesNotMatch(String(result.consumerStatuses[0].statusAsOf ?? ''), /2026-03-0/);
  });

  test('a leap second is accepted as the instant it names', async () => {
    const seller = await harness();
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `ajv-formats` accepts 23:59:60, so refusing it would silence a seller the
    // SDK itself calls conformant. `Date.parse` returns NaN for it.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ schedule: _schedule, ...period }) => ({
          ...period,
          expected_at: '2026-09-01T23:59:60Z',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.notEqual(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    // The leap second is the instant immediately before the next one, then
    // clamped up to the period end.
    assert.equal(result.consumerStatuses[0].statusAsOf, new Date(seller.anchor + DAY).toISOString());
  });

  test('a non-string expected_at is the seller defect, not a missing buyer pin', async () => {
    const seller = await harness();
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ schedule: _schedule, ...period }) => ({ ...period, expected_at: null })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    assert.match(result.consumerStatuses[0].reason, /obligation\.expected_at/, "the seller's field, not a pin");
  });

  test('a chain with two unsuperseded leaves says so rather than naming an undisclosed one', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    await seller.reconcile(at, expected);
    assert.equal(seller.store.consumerStatements.length, 1);

    // Two leaves, neither superseding the other. The seller named nothing, so
    // "named a current leaf it did not disclose" would be the wrong story.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [leaf] = page.consumer_statuses ?? [];
      if (!leaf) return page;
      return {
        ...page,
        consumer_statuses: [leaf, { ...leaf, reporting_status_id: `${leaf.reporting_status_id}-fork` }],
        periods: (page.periods ?? []).map(({ current_consumer_status_id: _leaf, ...period }) => period),
      };
    };

    const result = await seller.reconcile(at + HOUR, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'leaf_undisclosed');
    assert.match(result.consumerStatuses[0].reason, /more than one unsuperseded leaf/);
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a plan with no poster wired says so rather than reading as live and due', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // A reader but no poster: the plan used to come back overdue and
    // unsuppressed while going nowhere, which is indistinguishable from one
    // that was posted.
    delete seller.client.syncReportingStatus;

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.overdue, true);
    assert.equal(plan.suppressed, 'posting_unavailable');
    assert.match(plan.reason, /client\.syncReportingStatus/);
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a leap second is judged in UTC, the way the SDK own validator judges it', async () => {
    // `ajv-formats` resolves the offset before checking for 23:59:60, so
    // `18:59:60-05:00` is a genuine leap second and `23:59:60+01:00` is not.
    // Checking the local fields was wrong in both directions at once.
    const genuine = await planWithWireExpectedAt('2026-06-30T18:59:60-05:00');
    assert.notEqual(genuine.suppressed, 'deadline_unknown', 'a real leap second must not silence a seller');

    const bogus = await planWithWireExpectedAt('2026-09-02T23:59:60+01:00');
    assert.equal(bogus.suppressed, 'deadline_unknown', 'and a time ajv rejects must not be accepted');
  });

  test('an hour past 23 is unreadable rather than rolled into the next day', async () => {
    const plan = await planWithWireExpectedAt('2026-09-02T24:00:00Z');
    assert.equal(plan.suppressed, 'deadline_unknown');
  });

  test('February is sized in the proleptic calendar, not the 1900s', async () => {
    // `Date.UTC(50, …)` means 1950, and year 0 is a leap year where 1900 is
    // not — so a two-digit year silently relocated by nineteen centuries and
    // year 0 lost a day.
    const leapYearZero = await planWithWireExpectedAt('0000-02-29T00:00:00Z');
    assert.notEqual(leapYearZero.suppressed, 'deadline_unknown', 'year 0 has a 29th');

    const notLeapYear50 = await planWithWireExpectedAt('0050-02-29T00:00:00Z');
    assert.equal(notLeapYear50.suppressed, 'deadline_unknown', 'year 50 does not, though 1950-02-29 would not either');
  });

  test('an official generation falls back to deliverySlaSeconds, the one offset the spec defines', async () => {
    const seller = await harness();
    // The pin for official finality is absent but the ordinary one is present.
    // Falling back to it produces a statement the seller refuses on every run,
    // which the code's own comment calls out as the expensive mistake.
    const expected = [expectedPeriod(seller.request, seller.anchor, { requiredFinality: 'official' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _a, schedule: _s, ...period }) => ({
          ...period,
          required_finality: 'official',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    // `official_after` appears nowhere in the 3.2.0-rc.3 schemas — it is an
    // extension this repo's producer and ingest carry — and the seller was
    // measured to *accept* the `delivery_sla`-derived instant when it is not
    // configured. Refusing the fallback silenced a conformant period.
    assert.equal(result.consumerStatuses[0].suppressed, undefined);
    assert.equal(
      result.consumerStatuses[0].deadline,
      new Date(seller.anchor + DAY + (SLA_SECONDS + RECOVERY_SECONDS) * 1_000).toISOString()
    );
    assert.equal(result.postedConsumerStatuses.length, 1);
  });

  test('a pin that overflows says so rather than telling you to record it', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor, { deliverySlaSeconds: 1e15 })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _a, schedule: _s, ...period }) => period),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses[0].suppressed, 'deadline_unknown');
    // The adopter did record it. Telling them to record it again is the dead
    // end `deadlineGapReason` exists to avoid.
    assert.doesNotMatch(result.consumerStatuses[0].reason, /record ExpectedReportingPeriod/);
    assert.match(result.consumerStatuses[0].reason, /representable range/);
  });

  test('a malformed issues array does not abort a run that already synced receipts', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        // A client that does not schema-validate its responses; the guide's own
        // examples do not.
        periods: (page.periods ?? []).map(period => ({ ...period, issues: [null, 'nope', {}] })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1, 'the run completed and reported');
    // The null and the string are skipped; the empty object is a shape the
    // escalation projection can read, so one entry survives. What matters is
    // that nothing threw out of a run that had already synced receipts.
    assert.equal(result.escalations.length, 1);
  });

  /**
   * Plan one period against a seller whose wire `expected_at` is the given
   * spelling, with no buyer pin and no schedule, so that value is the only
   * path to a deadline.
   */
  async function planWithWireExpectedAt(expectedAtValue) {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ schedule: _s, ...period }) => ({
          ...period,
          expected_at: expectedAtValue,
        })),
      };
    };
    const result = await seller.reconcile(at, [withoutPin]);
    return result.consumerStatuses[0];
  }

  test('an instant that parses past the RFC 3339 year range is not a deadline', async () => {
    // `RFC3339_INSTANT` allows offsets to ±23:59, so this is a string this
    // SDK's own validator calls conformant and which resolves to year 10000.
    // Without the range guard the buyer derives a live deadline from a value it
    // cannot re-emit — `toISOString` renders it `+010000-…`, which no validator
    // accepts — and the statement is refused forever.
    const plan = await planWithWireExpectedAt('9999-12-31T23:59:59-23:59');
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.equal(plan.deadline, undefined);
    assert.doesNotMatch(String(plan.statusAsOf ?? ''), /^\+/);
  });

  test('a tab-separated instant is read, because ajv-formats reads one', async () => {
    // `ajv-formats` splits `date-time` on `[t\s]`, which matches a tab. A
    // stricter reader here would fall silent on a seller the SDK had just
    // validated as conformant.
    const plan = await planWithWireExpectedAt('2026-09-02\t12:00:00Z');
    assert.notEqual(plan.suppressed, 'deadline_unknown');
    assert.equal(plan.deadline, '2026-09-02T13:00:00.000Z');
  });

  test('a far-future seller deadline is honoured but recorded, not silently accepted', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // One field, ~20 bytes: the period sits at `overdue: false` with
    // `suppressed` unset — indistinguishable from "not due yet" — and every
    // statement on the chain stops landing, permanently. The spec makes the
    // seller's instant authoritative, so it is still honoured; what was missing
    // was any trace an adopter could alert on.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({ ...period, expected_at: '2099-01-01T00:00:00.000Z' })),
      };
    };

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.overdue, false, 'the seller deadline is still honoured');
    assert.ok(plan.deadlineBeyondPin, 'but it is on the plan');
    assert.equal(plan.deadlineBeyondPin.declared, '2099-01-01T00:00:00.000Z');
    assert.equal(plan.deadlineBeyondPin.pinned, new Date(seller.anchor + DAY + SLA_SECONDS * 1_000).toISOString());
  });

  // One poison per case. A single statement with the id, the date *and* the
  // digest all rewritten is refused whichever guard fires first, so any one of
  // them could be deleted with the suite still green — which is what happened.
  async function replayPoison(poison) {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const pending = pendingConsumerStatusStore();

    const honest = seller.client.syncReportingStatus;
    seller.client.syncReportingStatus = async params => {
      await honest(params);
      throw new Error('socket hang up');
    };
    await seller.reconcile(at, expected, { pendingConsumerStatusStore: pending });
    assert.equal(pending.entries.size, 1);

    for (const [key, entry] of pending.entries) {
      pending.entries.set(key, { ...entry, statement: poison(entry.statement) });
    }

    // Hide the chain so the retry re-plans and actually consults the store,
    // rather than suppressing as `unchanged`.
    const honestRead = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honestRead(params);
      return {
        ...page,
        consumer_statuses: [],
        periods: (page.periods ?? []).map(({ current_consumer_status_id: _leaf, ...period }) => ({
          ...period,
          consumer_status_count: 0,
        })),
      };
    };
    let sent;
    seller.client.syncReportingStatus = async params => {
      sent = params;
      return honest(params);
    };
    const retry = await seller.reconcile(at + HOUR, expected, { pendingConsumerStatusStore: pending });
    assert.ok(sent, 'the retry posted something');
    // The poisoned entry is discarded and the statement rebuilt from what the
    // buyer actually established. The seller then rejects the rebuild, because
    // the original landed before the response was lost — a visible item-local
    // conflict, which is the honest outcome and not a fabricated attestation.
    assert.equal(retry.postedConsumerStatuses.length + retry.failedConsumerStatuses.length, 1);
    return sent.statuses[0];
  }

  /**
   * The `reporting_status_id` an honest replay would carry, recomputed the way
   * the reconciler does. It is an unkeyed digest over public fields, so a store
   * -poisoning attacker can forge one — which is the only way the non-future
   * `status_as_of` guard is reachable at all, the recomputed-id check having
   * caught every simpler tampering first.
   */
  function forgeStatusId(statement, statusAsOf) {
    const claim = [
      statement.delivery_config_id,
      statement.delivery_config_version,
      statement.report_definition_id,
      statement.period,
      statement.consumer_status,
      statement.mismatch_code ?? null,
      statement.failure_code ?? null,
      statement.reporting_revision_id ?? null,
      statement.observed_revision_content_sha256 ?? null,
      statement.supersedes_reporting_status_id ?? null,
    ];
    const hash = createHash('sha256')
      .update(canonicalJsonV1([...claim, statusAsOf ?? null]))
      .digest('hex');
    return `adcp-sdk.${hash.slice(0, 32)}`;
  }

  test('a replayed statement with a fabricated consumption digest is refused', async () => {
    // The digest is the one fact the buyer must establish for itself. Accepting
    // a stored one lets a compromised store make the buyer attest a
    // consumption it never performed.
    const sent = await replayPoison(statement => ({
      ...statement,
      observed_revision_content_sha256: 'de'.repeat(32),
    }));
    assert.notEqual(sent.observed_revision_content_sha256, 'de'.repeat(32));
  });

  test('a replayed statement with an attacker-chosen id is refused', async () => {
    const sent = await replayPoison(statement => ({
      ...statement,
      reporting_status_id: 'adcp-sdk.ATTACKER0000000000000000000',
    }));
    assert.notEqual(sent.reporting_status_id, 'adcp-sdk.ATTACKER0000000000000000000');
  });

  test('a replayed statement carrying an unexpected key is refused', async () => {
    const sent = await replayPoison(statement => ({ ...statement, attacker_note: 'x' }));
    assert.equal(sent.attacker_note, undefined);
  });

  test('a replayed statement dated in the future is refused even with a matching id', async () => {
    // Forged consistently, so the recomputed-id check passes and the non-future
    // check is the only thing left. A 2099 `status_as_of` would poison the
    // chain's monotonicity floor forever.
    const future = '2099-01-01T00:00:00.000Z';
    const sent = await replayPoison(statement => ({
      ...statement,
      status_as_of: future,
      reporting_status_id: forgeStatusId(statement, future),
    }));
    assert.notEqual(sent.status_as_of, future);
  });

  test('an obligation with no period does not abort a run that already synced receipts', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A client that does not schema-validate its responses. This threw
    // `Cannot read properties of undefined (reading 'start')` out of
    // `reconcileReporting` after receipts had gone to the seller.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ period: _dropped, ...rest }) => rest),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.missingExpectedPeriods.length, 1, 'a period-less obligation matches nothing');
    assert.ok(Array.isArray(result.consumerStatuses));
  });

  test('a non-string obligation health does not abort the run either', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return { ...page, periods: (page.periods ?? []).map(period => ({ ...period, health: 7 })) };
    };

    const result = await seller.reconcile(at, expected);
    assert.ok(Array.isArray(result.consumerStatuses), 'the run completed');
  });

  test('a lowercase RFC 3339 expected_at is read, not treated as unreadable', async () => {
    const seller = await harness();
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // RFC 3339 §5.6 permits a lowercase `t`/`z`, and this SDK's own
    // `format: date-time` validation accepts it — so refusing it here would
    // silence a seller the SDK just told was conformant.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        // `schedule` is stripped, and the buyer pin is stripped below, so the
        // lowercase `expected_at` is the *only* path to this instant — without
        // that, a rejected spelling silently re-derives the identical value
        // from a fallback and the assertion cannot discriminate.
        periods: (page.periods ?? []).map(({ schedule: _schedule, ...period }) => ({
          ...period,
          expected_at: '2026-09-02t01:00:00z',
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.postedConsumerStatuses[0].statusAsOf, '2026-09-02T01:00:00.000Z', 'normalized, not echoed');
    assert.deepEqual(result.failedConsumerStatuses, []);
  });

  test('an absent expected_at falls back to the obligation schedule the spec defines', async () => {
    const seller = await harness();
    // No buyer pin: the obligation's own `schedule.delivery_sla` has to be the
    // only path to a deadline, or this test passes through the pin instead and
    // says nothing about the fallback.
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    const expected = [withoutPin];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `reporting-schedule.json`: "expected_at equals the resolved period end
    // plus this duration", and `schedule` is required on every obligation. So
    // an unreadable `expected_at` is recoverable from the seller's own number
    // rather than silencing the period forever.
    const honest = seller.client.getReportingStatus;
    let scheduledSla;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        // Absent, not malformed: an unreadable `expected_at` deliberately
        // derives nothing, because the seller has a real deadline the buyer
        // cannot read and guessing one is refused on every run.
        periods: (page.periods ?? []).map(({ expected_at: _absent, ...period }) => {
          scheduledSla = period.schedule?.delivery_sla;
          return period;
        }),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(scheduledSla, `PT${SLA_SECONDS}S`, 'the obligation carries the duration being resolved');
    assert.equal(result.postedConsumerStatuses.length, 1, 'recovered rather than silenced');
    assert.equal(
      result.postedConsumerStatuses[0].statusAsOf,
      new Date(seller.anchor + DAY + SLA_SECONDS * 1_000).toISOString(),
      'period end + schedule.delivery_sla'
    );
    assert.deepEqual(result.failedConsumerStatuses, []);
  });

  test('an off-scope superseded predecessor does not make a valid current revision missing', async () => {
    const seller = await harness();
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `REVISION_CHAIN_SCOPE_MISMATCH` is evaluated over every candidate in the
    // chain, including superseded ones, which is why it is not a disqualifying
    // reason: a predecessor's slice violation must not turn a sound current
    // revision into `revision_missing`.
    //
    // Reaching it needs managed delivery. For a direct-Core obligation the
    // ledger graph assertion refuses an off-scope revision outright, but a
    // revision referenced by a materialization is joined through that
    // materialization instead — so an off-scope predecessor survives the load
    // and becomes a candidate, which is exactly the shape the exclusion exists
    // to protect against.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [obligation] = page.periods ?? [];
      const [head] = page.revisions ?? [];
      if (!obligation || !head) return page;
      const predecessor = {
        ...head,
        reporting_revision_id: `${head.reporting_revision_id}-stale`,
        // Off-scope: a period the obligation does not cover.
        period: { ...head.period, start: '2020-01-01T00:00:00.000Z', end: '2020-01-02T00:00:00.000Z' },
      };
      const materialization = (revisionId, index) => ({
        reporting_materialization_id: `rmat_${index}`,
        reporting_revision_id: revisionId,
        reporting_obligation_id: obligation.reporting_obligation_id,
        delivery_config_id: obligation.delivery_config_id,
        delivery_config_version: obligation.delivery_config_version,
        destination_ref: obligation.destination_ref,
        feed_purpose: obligation.feed_purpose,
        method: 'file_transfer',
        attempt: index + 1,
        status: 'pending',
        created_at: obligation.period.end,
      });
      return {
        ...page,
        revisions: [predecessor, { ...head, supersedes_reporting_revision_id: predecessor.reporting_revision_id }],
        materializations: [
          materialization(predecessor.reporting_revision_id, 0),
          materialization(head.reporting_revision_id, 1),
        ],
        // One extra revision plus two materializations.
        pagination: { ...page.pagination, total_count: page.pagination.total_count + 3 },
      };
    };
    const expected = [expectedPeriod(seller.request, seller.anchor, { deliveryMethod: 'file_transfer' })];

    const result = await seller.reconcile(at, expected);
    const plan = result.consumerStatuses[0];
    assert.equal(plan.consumerStatus, 'received', 'the head is sound, so the buyer consumed it');
    assert.equal(plan.suppressed, undefined);
  });

  test('each period_identity_unknown cause gets its own reason', async () => {
    // One shared sentence for three causes asserted the seller's zone was
    // unrecognized even when the seller was blameless, and sent the adopter to
    // record a pin that was either already recorded or was itself the defect.
    const sellerZoneUnreadable = async () => {
      const seller = await harness();
      const { periodSourceTimezone: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      const honest = seller.client.getReportingStatus;
      seller.client.getReportingStatus = async params => {
        const page = await honest(params);
        return {
          ...page,
          periods: (page.periods ?? []).map(period => ({
            ...period,
            period: { ...period.period, source_timezone: 'Not/AZone' },
          })),
        };
      };
      return (await seller.reconcile(at, [withoutPin])).consumerStatuses[0];
    };
    const withPin = async pin => {
      const seller = await harness();
      const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: pin })];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      return (await seller.reconcile(at, expected)).consumerStatuses[0];
    };

    const sellerFault = await sellerZoneUnreadable();
    assert.equal(sellerFault.suppressed, 'period_identity_unknown');
    assert.match(
      sellerFault.reason,
      /the seller's period\.source_timezone \(Not\/AZone\) is not a recognized IANA zone/
    );
    // No local remedy, because this gap is decided without consulting the pin:
    // "record periodSourceTimezone" is an instruction the adopter can follow,
    // re-run, and watch fail identically forever.
    assert.match(sellerFault.reason, /only the seller can correct the value/);
    assert.doesNotMatch(sellerFault.reason, /record ExpectedReportingPeriod\.periodSourceTimezone/);

    // The adopter's own typo. Blaming the seller here is a false statement of
    // fact, and "record periodSourceTimezone" is a no-op instruction.
    const pinFault = await withPin('Not/AZone');
    assert.equal(pinFault.suppressed, 'period_identity_unknown');
    assert.match(
      pinFault.reason,
      /ExpectedReportingPeriod\.periodSourceTimezone \(Not\/AZone\) is not a recognized IANA zone/
    );
    assert.doesNotMatch(pinFault.reason, /the seller's period\.source_timezone \(/);

    // Both unreadable: naming only one of them sends the adopter to fix it,
    // re-run, and meet the other.
    const bothBroken = await (async () => {
      const seller = await harness();
      const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'Bad/Pin' })];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      const honest = seller.client.getReportingStatus;
      seller.client.getReportingStatus = async params => {
        const page = await honest(params);
        return {
          ...page,
          periods: (page.periods ?? []).map(period => ({
            ...period,
            period: { ...period.period, source_timezone: 'Bad/Echo' },
          })),
        };
      };
      return (await seller.reconcile(at, expected)).consumerStatuses[0];
    })();
    assert.equal(bothBroken.suppressed, 'period_identity_unknown');
    assert.match(
      bothBroken.reason,
      /neither ExpectedReportingPeriod\.periodSourceTimezone \(Bad\/Pin\) nor the seller's period\.source_timezone \(Bad\/Echo\)/
    );
    assert.match(bothBroken.reason, /fixing either one alone/);
  });

  test('an IANA link and its canonical name are the same zone, not a disagreement', async () => {
    // `iana_timezone` accepts "a recognized IANA Time Zone Database zone name
    // **or link**", so these are one zone spelled two ways. Comparing the
    // strings made a *correct* pin break a configuration that worked with no
    // pin at all, and silenced the period permanently.
    const aliasPair = async (pin, sellerZone) => {
      const seller = await harness();
      const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: pin })];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      // Set on the seller's own obligation so its `validateStatus` compares
      // against the same value the buyer will post.
      for (const obligation of seller.store.obligations.values()) obligation.period.sourceTimezone = sellerZone;
      for (const configuration of seller.store.configurations.values()) configuration.sourceTimezone = sellerZone;
      const result = await seller.reconcile(at, expected);
      return { result, seller };
    };

    for (const [pin, sellerZone] of [
      ['Asia/Tokyo', 'Japan'],
      ['Japan', 'Asia/Tokyo'],
      ['America/New_York', 'US/Eastern'],
      ['US/Eastern', 'America/New_York'],
    ]) {
      const { result, seller } = await aliasPair(pin, sellerZone);
      const plan = result.consumerStatuses[0];
      assert.notEqual(plan.suppressed, 'period_identity_unknown', `${pin} vs ${sellerZone} is one zone`);
      assert.equal(result.postedConsumerStatuses.length, 1, `${pin} vs ${sellerZone} must post`);
      assert.deepEqual(result.failedConsumerStatuses, []);
      // The seller's spelling goes on the wire: it compares this field by
      // string identity, and the canonical name is not necessarily either of
      // the two spellings in play.
      assert.equal(seller.store.consumerStatements[0].period.source_timezone, sellerZone);
    }

    // Two genuinely different zones post under the seller's value and raise the
    // non-suppressing alarm. Silence here removed the accountability statement
    // for precisely the adopters who had pinned a zone.
    const { result: real } = await aliasPair('Asia/Tokyo', 'Europe/Berlin');
    assert.notEqual(real.consumerStatuses[0].suppressed, 'period_identity_unknown');
    assert.deepEqual(real.consumerStatuses[0].periodZoneBeyondPin, {
      declared: 'Europe/Berlin',
      pinned: 'Asia/Tokyo',
    });
    assert.equal(real.postedConsumerStatuses.length, 1);
  });

  test('an offset hour past 23 is not an instant, because ajv rejects it too', async () => {
    // RFC 3339 bounds `time-hour` at 23 and `ajv-formats` enforces it. An
    // unbounded two digits let `+30:00` through — V8's ISO parser refuses it,
    // but the legacy parser reached via the space separator does not, so
    // widening the separator quietly opened it.
    const plan = await planWithWireExpectedAt('2026-09-02 12:34:56+30:00');
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.equal(plan.deadline, undefined);

    // The boundary itself stays open.
    const boundary = await planWithWireExpectedAt('2026-09-02 12:34:56+23:00');
    assert.notEqual(boundary.suppressed, 'deadline_unknown');
  });

  test('an overflow names the offset the buyer actually recorded', async () => {
    const seller = await harness();
    // Official finality with only `deliverySlaSeconds` set. Dispatching on
    // finality alone named `officialAfterSeconds` — a field left empty — so the
    // adopter was sent to fix the wrong one.
    const expected = [
      {
        ...expectedPeriod(seller.request, seller.anchor),
        requiredFinality: 'official',
        deliverySlaSeconds: Number.MAX_SAFE_INTEGER,
      },
    ];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, schedule: _s, ...period }) => ({
          ...period,
          required_finality: 'official',
        })),
      };
    };

    const plan = (await seller.reconcile(at, expected)).consumerStatuses[0];
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.match(plan.reason, /ExpectedReportingPeriod\.deliverySlaSeconds puts it outside/);
    assert.doesNotMatch(plan.reason, /officialAfterSeconds/);
  });

  test('a seller-set deadline is flagged even when the buyer pinned nothing', async () => {
    const seller = await harness();
    // The pin-first ordering defeats a `delivery_sla: P10Y` override only for a
    // buyer that recorded a pin. Without one the period came back with a live
    // ten-year deadline, `suppressed` unset and no marker at all — a silent,
    // permanent opt-out, and worse than the loud `deadline_unknown` that
    // preceded the schedule fallback.
    const { deliverySlaSeconds: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, ...period }) => ({
          ...period,
          schedule: { ...period.schedule, delivery_sla: 'P10Y' },
        })),
      };
    };

    const plan = (await seller.reconcile(at, [withoutPin])).consumerStatuses[0];
    assert.equal(plan.overdue, false, 'the seller instant is still honoured');
    assert.equal(plan.deadlineSource, 'seller_schedule');
    assert.ok(plan.deadlineBeyondPin, 'and it is never invisible');
    assert.match(plan.deadlineBeyondPin.declared, /^2036-/, 'the seller pushed it a decade out');
    assert.equal(plan.deadlineBeyondPin.pinned, undefined, 'there was no pin to compare against');

    // A buyer that did pin gets the pin, and no alarm.
    const pinned = (await seller.reconcile(at, [expectedPeriod(seller.request, seller.anchor)])).consumerStatuses[0];
    assert.equal(pinned.deadlineSource, 'buyer_pin');
    assert.equal(pinned.deadlineBeyondPin, undefined);
  });

  test('the seller own expected_at is recorded as the deadline source', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    const plan = (await seller.reconcile(at, expected)).consumerStatuses[0];
    assert.equal(plan.deadlineSource, 'seller_expected_at', "the seller's own value outranks the pin");
  });

  test('a nonsense revision limit is refused, not silently applied', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `maxPages: -5` throws; these two used to mute every period in scope
    // (`-5`) or silently disable the bound (`NaN`) instead.
    // Zero is refused rather than honoured literally: honouring it would mute
    // every period the caller has, which is the failure direction that matters.
    for (const ledgerLimits of [
      { maxRevisionRows: -5 },
      { maxRevisionRows: Number.NaN },
      { maxRevisionBytes: -1 },
      { maxRevisionBytes: 0 },
      { maxRevisionBytes: 512 * 1024 * 1024 },
    ]) {
      await assert.rejects(
        () => seller.reconcile(at, expected, { ledgerLimits }),
        error => error.code === 'INVALID_LEDGER_LIMITS',
        `${JSON.stringify(ledgerLimits)} must be refused`
      );
    }
  });

  test('a null ledger record is a typed failure, not a TypeError', async () => {
    // A `null` inside any of the five collections dereferenced straight to
    // `TypeError`, which escaped `reconcileReporting`. Classified instead, and
    // deliberately as a local error rather than a durable `unreadable`
    // statement, which would put an accusation against the seller on the
    // buyer's own permanent record.
    for (const collection of ['periods', 'revisions', 'materializations', 'receipts', 'consumer_statuses']) {
      const seller = await harness();
      const expected = [expectedPeriod(seller.request, seller.anchor)];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      const honest = seller.client.getReportingStatus;
      seller.client.getReportingStatus = async params => {
        const page = await honest(params);
        return { ...page, [collection]: [...(page[collection] ?? []), null] };
      };

      await assert.rejects(
        () => seller.reconcile(at, expected),
        error => {
          assert.ok(!(error instanceof TypeError), `${collection}: TypeError escaped`);
          assert.equal(error.code, 'LEDGER_RECORD_MALFORMED', `${collection}: wrong code`);
          return true;
        }
      );
    }
  });

  /**
   * Re-serve the ledger with the revision joined through a materialization.
   *
   * For a direct-Core obligation the graph's scope key already incorporates
   * `revision.period`, so a malformed one fails closed there and the guards
   * below are unreachable. A revision referenced by a materialization is joined
   * through that materialization instead — the shape a managed-delivery seller
   * produces, and the only one where these fields reach `selectCurrent`.
   */
  function servesManagedLedger(seller, mutate) {
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [obligation] = page.periods ?? [];
      const [head] = page.revisions ?? [];
      if (!obligation || !head) return page;
      const materialized = {
        ...page,
        materializations: [
          {
            reporting_materialization_id: 'rmat_managed',
            reporting_revision_id: head.reporting_revision_id,
            reporting_obligation_id: obligation.reporting_obligation_id,
            delivery_config_id: obligation.delivery_config_id,
            delivery_config_version: obligation.delivery_config_version,
            destination_ref: obligation.destination_ref,
            feed_purpose: obligation.feed_purpose,
            method: 'file_transfer',
            attempt: 1,
            status: 'pending',
            created_at: obligation.period.end,
          },
        ],
        pagination: { ...page.pagination, total_count: page.pagination.total_count + 1 },
      };
      return mutate(materialized);
    };
    return { deliveryMethod: 'file_transfer' };
  }

  /**
   * Drive the consumer-receipt path, then poison only the reload.
   *
   * `reconcileReporting` re-reads the ledger *after* `sync_reporting_receipts`
   * has durably written, so this is the one place a malformed record can cost
   * the caller its record of real work. `mutateReload` is applied from the
   * given read onward.
   */
  async function receiptThenReload(seller, mutateReload, poisonFromRead) {
    const honest = seller.client.getReportingStatus;
    let reads = 0;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const [obligation] = page.periods ?? [];
      const [head] = page.revisions ?? [];
      if (!obligation || !head) return page;
      const receiptLedger = {
        ...page,
        periods: [
          {
            ...obligation,
            reconciliation_mode: 'consumer_receipt',
            receipt_count: 0,
            accepted_receipt_count: 0,
          },
        ],
        materializations: [
          {
            reporting_materialization_id: 'rmat_receipt',
            reporting_revision_id: head.reporting_revision_id,
            reporting_obligation_id: obligation.reporting_obligation_id,
            delivery_config_id: obligation.delivery_config_id,
            delivery_config_version: obligation.delivery_config_version,
            destination_ref: obligation.destination_ref,
            feed_purpose: obligation.feed_purpose,
            method: 'file_transfer',
            transport: 'https',
            attempt: 1,
            status: 'available',
            ready_at: obligation.period.end,
            resource: {
              resource_ref: 'fixture-resource',
              kind: 'manifest',
              location: 'https://bucket.fixture.example.net/reporting/manifest.json',
              manifest_version: '1.0',
              manifest_sha256: 'cd'.repeat(32),
              immutability: 'immutable_location',
              expires_at: '2099-12-01T00:00:00Z',
            },
            verification: {
              verified_at: obligation.period.end,
              verification_path: 'representative_consumer',
              verification_profile: 'manifest_checksums',
              row_count: head.row_count,
              control_totals: head.control_totals ?? [],
              // `manifest_checksums` verification is only evidence if it
              // carries the checksums.
              physical_checksums: [{ object_ref: 'manifest.json', algorithm: 'sha256', value: 'ab'.repeat(32) }],
            },
            created_at: obligation.period.end,
          },
        ],
        pagination: { ...page.pagination, total_count: page.pagination.total_count + 1 },
      };
      reads += 1;
      return reads >= poisonFromRead ? mutateReload(receiptLedger) : receiptLedger;
    };
    // A conformant acknowledgement, which the honest harness stub does not give.
    const synced = [];
    seller.client.syncReportingReceipts = async params => {
      synced.push(...params.receipts);
      return {
        status: 'completed',
        results: params.receipts.map(receipt => ({ result: 'recorded', receipt })),
      };
    };
    return { synced, reads: () => reads };
  }

  test('a malformed record on the post-receipt reload still hands back the synced receipts', async () => {
    const seller = await harness();
    const expected = [
      expectedPeriod(seller.request, seller.anchor, {
        reconciliationMode: 'consumer_receipt',
        deliveryMethod: 'file_transfer',
      }),
    ];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // Poison only the reload. The receipt is already at the seller by then, so
    // a bare throw left the caller unable to tell "nothing was written" from
    // "written, and the re-read failed" — the difference between starting over
    // and retrying.
    const { synced } = await receiptThenReload(seller, page => ({ ...page, revisions: [...page.revisions, null] }), 2);

    await assert.rejects(
      () => seller.reconcile(at, expected),
      error => {
        assert.ok(!(error instanceof TypeError), 'TypeError escaped');
        assert.equal(error.code, 'LEDGER_RECORD_MALFORMED');
        assert.equal(synced.length, 1, 'the receipt really was written before the failure');
        assert.equal(error.submittedReceipts?.length, 1, 'and the caller gets it back');
        assert.equal(error.submittedReceipts[0].reporting_receipt_id, synced[0].reporting_receipt_id);
        return true;
      }
    );
  });

  test('a ledger collection that is not an array is refused, not iterated', async () => {
    // `?? []` guarded against null and undefined and nothing else, so `0` —
    // or `true`, or an object — reached `for…of` on a non-iterable and threw a
    // raw TypeError out of the reconcile. The same `?? []` defect this file
    // fixes for `media_buy_ids`, left at the lines that gained the per-record
    // guard.
    for (const collection of ['periods', 'revisions', 'materializations', 'receipts', 'consumer_statuses']) {
      for (const bad of [0, true, {}, -1]) {
        const seller = await harness();
        const expected = [expectedPeriod(seller.request, seller.anchor)];
        await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
        await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
        const at = seller.anchor + DAY + 3 * HOUR;
        seller.observeAt(at);
        const honest = seller.client.getReportingStatus;
        seller.client.getReportingStatus = async params => ({ ...(await honest(params)), [collection]: bad });

        await assert.rejects(
          () => seller.reconcile(at, expected),
          error => {
            assert.ok(!(error instanceof TypeError), `${collection}/${String(bad)}: TypeError escaped`);
            assert.equal(error.code, 'LEDGER_RECORD_MALFORMED', `${collection}/${String(bad)}`);
            return true;
          }
        );
      }
    }
  });

  test('alias comparison cost does not grow with the number of revisions', async () => {
    // `canonicalZone` constructed a formatter on every call, measured ~62 us,
    // on a path walked once per revision per obligation. A seller spelling its
    // revision's zone differently from its own obligation — both conformant
    // under `iana_timezone` — took a 150x150 ledger from 84 ms to 6,068 ms of
    // synchronous work, starving the event loop and every AbortSignal deadline
    // in the SDK. The fix is a memo plus a length bound, so construction count
    // must be flat in the number of revisions rather than linear.
    const construct = Intl.DateTimeFormat;
    const builtFor = async revisionCount => {
      const seller = await harness();
      const expected = [expectedPeriod(seller.request, seller.anchor)];
      await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
      await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
      const at = seller.anchor + DAY + 3 * HOUR;
      seller.observeAt(at);
      const honest = seller.client.getReportingStatus;
      seller.client.getReportingStatus = async params => {
        const page = await honest(params);
        const [head] = page.revisions ?? [];
        if (!head) return page;
        // Every revision spells the zone as a link of the obligation's `UTC`,
        // so each one is an alias comparison rather than a byte match.
        const revisions = Array.from({ length: revisionCount }, (_unused, index) => ({
          ...head,
          reporting_revision_id: index === 0 ? head.reporting_revision_id : `${head.reporting_revision_id}-${index}`,
          period: { ...head.period, source_timezone: 'Zulu' },
        }));
        return {
          ...page,
          revisions,
          pagination: { ...page.pagination, total_count: page.pagination.total_count + revisionCount - 1 },
        };
      };
      let built = 0;
      Intl.DateTimeFormat = function countingDateTimeFormat(...args) {
        built += 1;
        return new construct(...args);
      };
      try {
        await seller.reconcile(at, expected);
      } finally {
        Intl.DateTimeFormat = construct;
      }
      return built;
    };

    const few = await builtFor(1);
    const many = await builtFor(24);
    // Uncached, 24 revisions against one obligation build a formatter per
    // comparison; cached, the two spellings are resolved once for the process.
    assert.ok(
      many - few < 8,
      `formatter construction must not scale with revisions: ${few} for 1 revision, ${many} for 24`
    );
  });

  test('a zone name too long for any zone never reaches Intl', async () => {
    // Formatter construction costs time proportional to the input: a 1 MB zone
    // name measured 8.2 ms against 32 us for a real one, and the string is
    // seller-supplied. The outcome is `period_identity_unknown` either way —
    // `Intl` would reject it too — so what has to be pinned is that the work is
    // never done.
    const construct = Intl.DateTimeFormat;
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // On the seller's own period, which reaches `canonicalZone` through the
    // revision scope key with no `ianaTimeZone` bound in front of it.
    const honest = seller.client.getReportingStatus;
    const overLong = 'A/'.repeat(600);
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        // Both sides, so the revision still joins its obligation and the run
        // completes; the scope key hashes the raw string either way.
        periods: (page.periods ?? []).map(period => ({
          ...period,
          period: { ...period.period, source_timezone: overLong },
        })),
        revisions: (page.revisions ?? []).map(revision => ({
          ...revision,
          period: { ...revision.period, source_timezone: overLong },
        })),
      };
    };

    let longNames = 0;
    Intl.DateTimeFormat = function countingDateTimeFormat(...args) {
      if (typeof args[1]?.timeZone === 'string' && args[1].timeZone.length > 255) longNames += 1;
      return new construct(...args);
    };
    let plan;
    try {
      plan = (await seller.reconcile(at, expected)).consumerStatuses[0];
    } finally {
      Intl.DateTimeFormat = construct;
    }
    assert.equal(longNames, 0, 'an over-long zone must be refused before Intl is asked');
    assert.ok(plan, 'and the run still completes');
  });

  test('a replayed statement carrying an explicit null is refused', async () => {
    // `?? undefined` treated a stored `null` as absent, so it matched a plan
    // that had nothing there and reached the wire verbatim — where the seller's
    // schema refuses it, on every run, because a failed post deliberately keeps
    // the pending entry. An older SDK that emitted explicit nulls produces the
    // same blob with no attacker at all.
    const sent = await replayPoison(statement => ({ ...statement, mismatch_code: null }));
    assert.notEqual(sent.mismatch_code, null, 'an explicit null must not reach the wire');
    const withObligation = await replayPoison(statement => ({ ...statement, reporting_obligation_id: null }));
    assert.equal(typeof withObligation.reporting_obligation_id, 'string');
  });

  test('a lost receipt acknowledgement is refused, and a non-typed failure is still recoverable', async () => {
    const seller = await harness();
    const expected = [
      expectedPeriod(seller.request, seller.anchor, {
        reconciliationMode: 'consumer_receipt',
        deliveryMethod: 'file_transfer',
      }),
    ];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A reload that throws something that is not a `ReportingReconciliationError`
    // still has to hand back the receipts, under a code the caller can dispatch
    // on, with the original preserved as `cause`.
    const { synced } = await receiptThenReload(
      seller,
      () => {
        throw new TypeError('malformed page from a client that does not validate');
      },
      2
    );

    await assert.rejects(
      () => seller.reconcile(at, expected),
      error => {
        assert.equal(error.code, 'RECONCILE_FAILED_AFTER_RECEIPTS');
        assert.equal(synced.length, 1);
        assert.equal(error.submittedReceipts?.length, 1);
        assert.ok(error.cause instanceof TypeError, 'the original failure is preserved as cause');
        return true;
      }
    );
  });

  test('a ledger record with no usable id is refused, not silently identified', async () => {
    // Deleting the id guard left the suite green while the buyer durably posted
    // a `received` derived from a record it could not identify. The object-shape
    // half of the guard was covered; this half was not.
    for (const [collection, idKey] of [
      ['periods', 'reporting_obligation_id'],
      ['revisions', 'reporting_revision_id'],
      ['materializations', 'reporting_materialization_id'],
    ]) {
      for (const badId of [null, 0, '']) {
        const seller = await harness();
        const expected = [expectedPeriod(seller.request, seller.anchor)];
        await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
        await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
        const at = seller.anchor + DAY + 3 * HOUR;
        seller.observeAt(at);
        const honest = seller.client.getReportingStatus;
        seller.client.getReportingStatus = async params => {
          const page = await honest(params);
          const template = (page[collection] ?? [])[0] ?? {};
          return { ...page, [collection]: [...(page[collection] ?? []), { ...template, [idKey]: badId }] };
        };

        await assert.rejects(
          () => seller.reconcile(at, expected),
          error => {
            assert.ok(!(error instanceof TypeError), `${collection}/${String(badId)}: TypeError escaped`);
            assert.equal(error.code, 'LEDGER_RECORD_MALFORMED', `${collection}/${String(badId)}`);
            return true;
          }
        );
      }
    }
  });

  test('an overflowing officialAfterSeconds names itself, not the spec-defined offset', async () => {
    const seller = await harness();
    // The fallback direction was covered and this one was not, so the two-field
    // split was only half pinned: labelling every official-finality overflow
    // `deliverySlaSeconds` survived green.
    const expected = [
      {
        ...expectedPeriod(seller.request, seller.anchor),
        requiredFinality: 'official',
        officialAfterSeconds: Number.MAX_SAFE_INTEGER,
      },
    ];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(({ expected_at: _absent, schedule: _s, ...period }) => ({
          ...period,
          required_finality: 'official',
        })),
      };
    };

    const plan = (await seller.reconcile(at, expected)).consumerStatuses[0];
    assert.equal(plan.suppressed, 'deadline_unknown');
    assert.match(plan.reason, /ExpectedReportingPeriod\.officialAfterSeconds puts it outside/);
    assert.doesNotMatch(plan.reason, /deliverySlaSeconds/);
  });

  test('an alias spelling between obligation and revision does not abort the ledger', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // The revision scope key hashed the zone byte-wise, so an obligation saying
    // `UTC` and a revision saying `Zulu` — one zone, two legal spellings —
    // landed in different scopes and threw `LEDGER_GRAPH_INTEGRITY_FAILED` out
    // of the whole reconcile. One seller-controlled string, every period in
    // scope lost: a cheaper and more complete silencing than any suppression.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        revisions: (page.revisions ?? []).map(revision => ({
          ...revision,
          period: { ...revision.period, source_timezone: 'Zulu' },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.consumerStatuses.length, 1, 'the period survives');
    assert.equal(result.consumerStatuses[0].consumerStatus, 'received');
  });

  test('a replayed statement naming a different obligation is refused', async () => {
    // Replayable, and previously compared to nothing — so it was in neither the
    // claim fingerprint nor the recomputed id, and a forged value reached the
    // wire verbatim.
    const sent = await replayPoison(statement => ({
      ...statement,
      reporting_obligation_id: 'obligation-ATTACKER',
    }));
    assert.notEqual(sent.reporting_obligation_id, 'obligation-ATTACKER');
  });

  test('a replayed statement backdated before its own period is refused', async () => {
    // The non-future check was a ceiling with no floor, so a consistently
    // forged id let a poisoned store date a statement before the period it
    // describes — which `expected_period` makes invalid.
    const past = '2020-01-01T00:00:00.000Z';
    const sent = await replayPoison(statement => ({
      ...statement,
      status_as_of: past,
      reporting_status_id: forgeStatusId(statement, past),
    }));
    assert.notEqual(sent.status_as_of, past);
  });

  test('a non-string seller zone is named by type, not rendered as nothing', async () => {
    const seller = await harness();
    const { periodSourceTimezone: _pin, ...withoutPin } = expectedPeriod(seller.request, seller.anchor);
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);
    // Rendered as "period.source_timezone () is not a recognized IANA zone",
    // which names neither the value nor the fault.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({
          ...period,
          period: { ...period.period, source_timezone: 42 },
        })),
      };
    };

    const plan = (await seller.reconcile(at, [withoutPin])).consumerStatuses[0];
    assert.equal(plan.suppressed, 'period_identity_unknown');
    assert.match(plan.reason, /period\.source_timezone \(<number>\)/);
  });

  test('a non-array media_buy_ids fails closed instead of spreading a scalar', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `media_buy_ids ?? []` caught absent and null and nothing else, so a
    // scalar reached `[...0]` and threw `TypeError` from a call site that runs
    // after receipts are synced.
    const managed = servesManagedLedger(seller, page => ({
      ...page,
      periods: (page.periods ?? []).map(period => ({ ...period, media_buy_ids: 0 })),
    }));
    expected[0] = { ...expected[0], ...managed };

    await assert.rejects(
      () => seller.reconcile(at, expected),
      error => {
        assert.ok(!(error instanceof TypeError), 'TypeError escaped the reconcile');
        assert.equal(error.code, 'LEDGER_GRAPH_INTEGRITY_FAILED');
        return true;
      }
    );
  });

  test('a revision whose own period is unreadable does not throw out of the reconcile', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `selectCurrent` read `revision.period.end` unguarded, and it runs for
    // every obligation *after* receipts have been synced — so one missing
    // object destroyed the caller's record of durable work.
    const managed = servesManagedLedger(seller, page => ({
      ...page,
      revisions: (page.revisions ?? []).map(({ period: _dropped, ...revision }) => revision),
    }));
    expected[0] = { ...expected[0], ...managed };

    await assert.rejects(
      () => seller.reconcile(at, expected),
      error => {
        assert.ok(!(error instanceof TypeError), 'TypeError escaped the reconcile');
        assert.equal(error.code, 'LEDGER_GRAPH_INTEGRITY_FAILED', 'fails closed before any durable write');
        return true;
      }
    );
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
