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

  test('deeply nested rows are charged against the byte ceiling, not waved through', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    await seller.producer.runWorker({ now: () => new Date(seller.anchor + DAY + HOUR), maxIterations: 2 });
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // A flat scan charged an unexamined subtree a flat 64 bytes however large
    // it was, so nesting the payload walked straight past the ceiling.
    const honest = seller.client.getMediaBuyDelivery;
    let pages = 0;
    seller.client.getMediaBuyDelivery = async params => {
      const { pagination: _cursor, ...firstPage } = params;
      const page = await honest(firstPage);
      pages += 1;
      return {
        ...page,
        reporting_rows: page.reporting_rows.map(row => ({
          ...row,
          nested: { a: { b: { c: { d: { blob: 'x' } } } } },
        })),
        pagination: { has_more: pages < 600, cursor: `deep-${pages}` },
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.deepEqual(result.postedConsumerStatuses, [], 'nothing posted');
    assert.equal(result.consumerStatuses[0].suppressed, 'local_budget_exhausted');
    assert.ok(pages < 600, 'the ceiling stopped the read before the seller did');
  });

  test('a lowercase RFC 3339 expected_at is read, not treated as unreadable', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
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
        periods: page.periods.map(period => ({ ...period, expected_at: '2026-09-02t01:00:00z' })),
      };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1);
    assert.equal(result.postedConsumerStatuses[0].statusAsOf, '2026-09-02T01:00:00.000Z', 'normalized, not echoed');
    assert.deepEqual(result.failedConsumerStatuses, []);
  });

  test('an unreadable expected_at falls back to the obligation schedule the spec defines', async () => {
    const seller = await harness();
    const expected = [expectedPeriod(seller.request, seller.anchor)];
    await seller.producer.planObligations(new Date(seller.anchor + DAY).toISOString());
    const at = seller.anchor + DAY + 3 * HOUR;
    seller.observeAt(at);

    // `reporting-schedule.json`: "expected_at equals the resolved period end
    // plus this duration", and `schedule` is required on every obligation. So
    // an unreadable `expected_at` is recoverable from the seller's own number
    // rather than silencing the period forever.
    const honest = seller.client.getReportingStatus;
    seller.client.getReportingStatus = async params => {
      const page = await honest(params);
      return { ...page, periods: page.periods.map(period => ({ ...period, expected_at: 'soon' })) };
    };

    const result = await seller.reconcile(at, expected);
    assert.equal(result.postedConsumerStatuses.length, 1, 'recovered rather than silenced');
    assert.equal(
      result.postedConsumerStatuses[0].statusAsOf,
      new Date(seller.anchor + DAY + SLA_SECONDS * 1_000).toISOString(),
      'period end + schedule.delivery_sla'
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
