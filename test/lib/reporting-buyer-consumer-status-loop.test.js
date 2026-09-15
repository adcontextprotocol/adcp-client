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
    assert.deepEqual(result.postedConsumerStatuses, []);
  });

  test('a seller rotating source_timezone does not fork the buyer own chain', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor, { periodSourceTimezone: 'UTC' })];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `source_timezone` sits in the durable statement, the status-id hash and
    // the unchanged-comparison, so a seller varying its echo made the buyer
    // append a fresh statement on every single reconcile. The buyer pinned the
    // value when it accepted the generation; the seller's copy is an echo.
    const honest = seller.client.getReportingStatus;
    // Real IANA zones, so this tests precedence rather than validity.
    const zones = ['America/New_York', 'Europe/Berlin', 'Asia/Tokyo'];
    let reads = 0;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      const zone = zones[reads % zones.length];
      reads += 1;
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({
          ...period,
          period: { ...period.period, source_timezone: zone },
        })),
      };
    };

    await seller.reconcile(at, expected);
    const second = await seller.reconcile(at + HOUR, expected);
    assert.equal(seller.store.consumerStatements.length, 1, 'one statement, not one per reconcile');
    assert.equal(second.consumerStatuses[0].suppressed, 'unchanged');
    assert.equal(seller.store.consumerStatements[0].period.source_timezone, 'UTC', 'the buyer pin, not the echo');
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
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return {
        ...page,
        periods: (page.periods ?? []).map(period => ({
          ...period,
          period: { ...period.period, source_timezone: 'Japan' },
        })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(
      result.consumerStatuses[0].period.source_timezone,
      'Japan',
      'adopted verbatim, not substituted with UTC'
    );
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
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(seller.store.consumerStatements[0].period.source_timezone, 'UTC', 'refused, not adopted');
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

  test('an official generation is told to record officialAfterSeconds, not deliverySlaSeconds', async () => {
    const seller = await harness();
    // Naming the wrong pin is expensive: an official generation dated from
    // delivery_sla is refused by the seller, and because the statement takes no
    // clock input it is rebuilt identically and refused on every run.
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
    assert.match(plan.reason, /officialAfterSeconds/);
    assert.doesNotMatch(plan.reason, /deliverySlaSeconds/);
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

  test('a row too deep to size is reported, not used to buy silence', async () => {
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
    // Not silence. Silence is reserved for limits the adopter configured; a
    // shape the reader cannot size is the seller's choice, and letting it
    // suppress the statement would hand a seller permanent immunity from
    // `revision_missing` for the price of one strange row.
    assert.notEqual(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.equal(result.consumerStatuses[0].consumerStatus, 'unreadable');
    assert.equal(result.consumerStatuses[0].failureCode, 'reader_incompatible');
    assert.equal(result.postedConsumerStatuses.length, 1, 'and it is on the record');
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
