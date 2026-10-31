/**
 * Subscription obligations in the reporting ledger (experimental `media_buy.reporting_subscriptions`,
 * AdCP 3.3): owed-set generations keyed by owner and offering, sparse periods, the owedThrough
 * horizon, per-period frozen media buys, status ingest against owed periods only, and caller
 * isolation between principals that share a subscription_id on one account.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, test } = require('node:test');

const {
  ReportingConfigurationImmutableError,
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  reportingLedgerSubscriptionKeyV1,
} = require('../../dist/lib/reporting/ledger/index.js');
const {
  canonicalJsonV1,
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { GetReportingStatusResponseSchema } = require('../../dist/lib/schemas/index.js');

const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

const DAY = 86_400_000;
const ACCOUNT = 'subscription-ledger-account';
const ORIGIN = Date.parse('2026-09-01T00:00:00Z');
const day = n => new Date(ORIGIN + n * DAY).toISOString();
const request = redactedReportingSourceRequestV1();
const offering = redactedReportingSourceOfferingV1;
const secondOffering = {
  ...structuredClone(offering),
  offeringId: 'fixture-second-offering',
  publicationNamespace: 'reporting-source:fixture-second',
};
const PRINCIPAL_A = { tenantId: 'tenant-1', principalId: 'principal-a' };
const PRINCIPAL_B = { tenantId: 'tenant-1', principalId: 'principal-b' };

function sha(value) {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function constituent(mediaBuyId) {
  const base = request.coverage.constituents[0];
  return {
    ...structuredClone(base),
    constituentId: `constituent-${mediaBuyId}`,
    mediaBuyId,
    productBinding: { ...structuredClone(base.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
  };
}

function generation(
  principal,
  { version = 1, offeringId = offering.offeringId, subscriptionId = 'analytics-daily' } = {}
) {
  return {
    account: { account_id: ACCOUNT },
    sourceScope: request.sourceScope,
    delivery_config_id: subscriptionId,
    delivery_config_version: version,
    offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    sourceTimezone: 'UTC',
    schedule: {
      anchor: '1970-01-01T00:00:00.000Z',
      periodMilliseconds: DAY,
      deliverySlaMilliseconds: 3_600_000,
      recoveryWindowMilliseconds: DAY,
      periodDuration: 'P1D',
      alignment: 'utc',
      deliverySlaDuration: 'PT1H',
    },
    sourceSettings: request.sourceSettings,
    contract: request.contract,
    subscription: { ...principal, subscriptionId, offeringId, ownership: 'owed_set' },
  };
}

function owed(start, mediaBuyIds, { version = 1, offeringId = offering.offeringId } = {}) {
  return {
    delivery_config_version: version,
    offeringId,
    period: { start: day(start), end: day(start + 1) },
    mediaBuyIds,
    constituents: mediaBuyIds.map(constituent),
  };
}

function plan(principal, obligations, owedThrough, configurations = [generation(principal)]) {
  return {
    account_id: ACCOUNT,
    principal,
    subscriptionId: configurations[0]?.delivery_config_id ?? 'analytics-daily',
    configurations,
    obligations,
    owedThrough: day(owedThrough),
    now: day(owedThrough),
  };
}

function setup({ rows = mediaBuyId => [{ media_buy_id: mediaBuyId, impressions: 1, spend: '1.00' }] } = {}) {
  const store = new MemoryLedgerStore();
  const source = createInlineReportingSourceExecutor(
    slice => slice.media_buy_ids.flatMap(mediaBuyId => rows(mediaBuyId)),
    offering
  );
  const producer = createReportingProducer({
    store,
    source,
    offerings: [offering, secondOffering],
    contact: { name: 'Reporting operations' },
  });
  return { store, producer };
}

const statusHandler = store =>
  createReportingStatusHandler(store, { resolveSubscriptionPrincipal: context => context.principal });
const read = (store, principal, body) =>
  statusHandler(store)(
    { account: { account_id: ACCOUNT }, pagination: { max_results: 100 }, ...body },
    { account: { account_id: ACCOUNT }, ...(principal ? { principal } : {}) }
  );

describe('subscription obligations in the reporting ledger', () => {
  test('plans a sparse owed set without grid fill or a continuity error', async () => {
    const { store, producer } = setup();
    const result = await producer.planSubscriptionObligations(
      plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(3, ['mb-a']), owed(7, ['mb-a'])], 8)
    );
    assert.equal(result.created.length, 3);
    assert.deepEqual(
      result.created.map(value => value.periodOrdinal),
      [1, 3, 7].map(n => Math.floor(Date.parse(day(n)) / 1_000))
    );
    const [configuration] = result.configurations;
    assert.equal(configuration.delivery_config_id, 'analytics-daily');
    assert.equal(configuration.delivery_config_version, 1);
    assert.deepEqual(configuration.mediaBuyIds, []);
    assert.deepEqual(configuration.constituents, []);
    assert.deepEqual(configuration.owedSet, {
      through: day(8),
      from: day(1),
      until: day(8),
      mediaBuyIds: ['mb-a'],
    });

    // The grid planner never fills the gaps of an owed set.
    assert.deepEqual(await producer.planObligations(day(9)), []);
    // Replanning is idempotent.
    const replay = await producer.planSubscriptionObligations(
      plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(3, ['mb-a']), owed(7, ['mb-a'])], 8)
    );
    assert.deepEqual(replay.created, []);
    assert.equal(store.obligations.size, 3);

    store.ledgerAsOf = day(9);
    const summary = await read(store, PRINCIPAL_A, { view: 'summary', period: { start: day(0), end: day(8) } });
    assert.equal(summary.status, 'completed', JSON.stringify(summary));
    assert.equal(summary.scope.coverage_complete, true);
    assert.equal(summary.scope.scope_closed, true);
    assert.equal(summary.obligation_counts.total, 3);
    assert.deepEqual(summary.scope.delivery_config_generations, [
      { delivery_config_id: 'analytics-daily', delivery_config_version: 1, feed_purpose: 'analytics' },
    ]);
    assert.equal(summary.issues.filter(issue => issue.code === 'HISTORY_UNAVAILABLE').length, 0);
    const parsed = GetReportingStatusResponseSchema.safeParse(summary);
    assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));

    const periods = await read(store, PRINCIPAL_A, { view: 'periods', period: { start: day(0), end: day(8) } });
    assert.equal(periods.periods.length, 3);
    for (const period of periods.periods) {
      assert.equal(period.delivery_config_id, 'analytics-daily');
      assert.equal(period.delivery_config_version, 1);
      assert.equal(period.offering_id, offering.offeringId);
      assert.equal(period.report_definition_id, request.report_definition_id);
      assert.equal(period.scope_resolved_at, period.period.end);
      assert.equal(period.expected_at, new Date(Date.parse(period.period.end) + 3_600_000).toISOString());
      assert.deepEqual(period.schedule, { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT1H' });
    }
  });

  test('completeness follows owedThrough rather than ordinal counting', async () => {
    const { store, producer } = setup();
    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 4));
    store.ledgerAsOf = day(9);
    const open = await read(store, PRINCIPAL_A, { view: 'summary', period: { start: day(0), end: day(8) } });
    assert.equal(open.status, 'completed', JSON.stringify(open));
    // Owed periods ending after day 4 may still be frozen into this scope: it is open, not
    // missing history, so coverage stays complete and no HISTORY_UNAVAILABLE is raised.
    assert.equal(open.scope.scope_closed, false);
    assert.equal(open.scope.coverage_complete, true);
    assert.notEqual(open.health, 'complete');
    assert.equal(open.issues.filter(issue => issue.code === 'HISTORY_UNAVAILABLE').length, 0);

    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(6, ['mb-a'])], 8));
    const closed = await read(store, PRINCIPAL_A, { view: 'summary', period: { start: day(0), end: day(8) } });
    assert.equal(closed.scope.scope_closed, true);
    assert.equal(closed.obligation_counts.total, 2);
    // owedThrough never moves backwards.
    const [configuration] = await store.listConfigurations(ACCOUNT);
    await store.recordOwedSetProgress({
      configurationId: configuration.configurationId,
      account_id: ACCOUNT,
      through: day(2),
    });
    assert.equal((await store.listConfigurations(ACCOUNT))[0].owedSet.through, day(8));
  });

  test('installs one generation per resolved offering of a version', async () => {
    const { store, producer } = setup();
    const result = await producer.planSubscriptionObligations(
      plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(1, ['mb-b'], { offeringId: secondOffering.offeringId })], 3, [
        generation(PRINCIPAL_A),
        generation(PRINCIPAL_A, { offeringId: secondOffering.offeringId }),
      ])
    );
    assert.equal(result.configurations.length, 2);
    const ids = new Set(result.configurations.map(value => value.configurationId));
    assert.equal(ids.size, 2);
    for (const configuration of result.configurations) {
      assert.equal(configuration.delivery_config_id, 'analytics-daily');
      assert.equal(configuration.delivery_config_version, 1);
      assert.equal(configuration.subscription.offeringId, configuration.offeringId);
    }
    store.ledgerAsOf = day(4);
    const periods = await read(store, PRINCIPAL_A, { view: 'periods', period: { start: day(0), end: day(3) } });
    assert.deepEqual(periods.periods.map(value => value.offering_id).sort(), [
      offering.offeringId,
      secondOffering.offeringId,
    ]);
    // The wire generation is (delivery_config_id, delivery_config_version, feed_purpose) with
    // uniqueItems, so both offerings of one version appear as that one generation.
    assert.deepEqual(periods.scope.delivery_config_generations, [
      { delivery_config_id: 'analytics-daily', delivery_config_version: 1, feed_purpose: 'analytics' },
    ]);
    // A new version installs its own generation beside the old one.
    const next = await producer.planSubscriptionObligations(
      plan(PRINCIPAL_A, [owed(3, ['mb-a'], { version: 2 })], 4, [generation(PRINCIPAL_A, { version: 2 })])
    );
    assert.equal(next.configurations.length, 3, 'owedThrough advances on every generation the subscription owns');
    assert.ok(next.configurations.every(value => value.owedSet.through === day(4)));
    const summary = await read(store, PRINCIPAL_A, { view: 'summary', period: { start: day(0), end: day(4) } });
    assert.deepEqual(
      summary.scope.delivery_config_generations.map(value => value.delivery_config_version).sort(),
      [1, 2]
    );
  });

  test('keeps two principals with the same subscription_id apart', async () => {
    const { store, producer } = setup();
    const a = await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 3));
    const b = await producer.planSubscriptionObligations(plan(PRINCIPAL_B, [owed(2, ['mb-b'])], 3));
    assert.notEqual(a.configurations[0].configurationId, b.configurations[0].configurationId);
    assert.notEqual(
      reportingLedgerSubscriptionKeyV1(a.configurations[0]),
      reportingLedgerSubscriptionKeyV1(b.configurations[0])
    );
    assert.equal((await store.listConfigurations(ACCOUNT)).length, 2);

    const worked = await producer.runWorker({ now: () => new Date(Date.parse(day(4))), maxIterations: 10 });
    assert.equal(worked.revisionsCommitted, 2, JSON.stringify(worked));
    store.ledgerAsOf = day(5);
    const forA = await read(store, PRINCIPAL_A, { view: 'periods', period: { start: day(0), end: day(3) } });
    const forB = await read(store, PRINCIPAL_B, { view: 'periods', period: { start: day(0), end: day(3) } });
    assert.deepEqual(
      forA.periods.map(value => value.media_buy_ids),
      [['mb-a']]
    );
    assert.deepEqual(
      forB.periods.map(value => value.media_buy_ids),
      [['mb-b']]
    );
    // A caller with no principal sees no subscription generation at all.
    const anonymous = await createReportingStatusHandler(store)(
      { account: { account_id: ACCOUNT }, view: 'periods', period: { start: day(0), end: day(3) } },
      { account: { account_id: ACCOUNT } }
    );
    assert.deepEqual(anonymous.periods, []);
    assert.deepEqual(anonymous.scope.delivery_config_generations, []);

    // B cannot read A's revision by id.
    const revisionOfA = forA.revisions[0].reporting_revision_id;
    const delivery = createReportingDeliveryHandler(store, {
      resolveSubscriptionPrincipal: context => context.principal,
    });
    const own = await delivery(
      { reporting_revision_id: revisionOfA },
      { account: { account_id: ACCOUNT }, principal: PRINCIPAL_A }
    );
    assert.equal(own.reporting_revision_binding?.reporting_revision_id ?? revisionOfA, revisionOfA);
    await assert.rejects(
      delivery({ reporting_revision_id: revisionOfA }, { account: { account_id: ACCOUNT }, principal: PRINCIPAL_B }),
      error => error.code === 'REFERENCE_NOT_FOUND'
    );

    // A store that leaks another principal's generation is refused, not served.
    const leaky = Object.create(store);
    leaky.createSnapshot = async query => ({
      ...(await store.createSnapshot({ ...query, subscription_principal: PRINCIPAL_B })),
      query,
    });
    await assert.rejects(
      statusHandler(leaky)(
        { account: { account_id: ACCOUNT }, view: 'summary', period: { start: day(0), end: day(3) } },
        { account: { account_id: ACCOUNT }, principal: PRINCIPAL_A }
      ),
      /subscription generation the caller does not own/
    );
  });

  test('freezes media_buy_ids per period and matches scope on the written owed set', async () => {
    const { store, producer } = setup();
    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(2, ['mb-b', 'mb-a'])], 3));
    const [first, second] = [...store.obligations.values()].sort((l, r) => l.periodOrdinal - r.periodOrdinal);
    assert.deepEqual(first.mediaBuyIds, ['mb-a']);
    assert.deepEqual(first.coverage.mediaBuyIds, ['mb-a']);
    assert.equal(first.scopeResolvedAt, day(2));
    assert.deepEqual(second.mediaBuyIds, ['mb-a', 'mb-b']);
    assert.deepEqual(
      second.constituents.map(value => value.mediaBuyId),
      ['mb-b', 'mb-a']
    );
    store.ledgerAsOf = day(4);
    const filtered = await read(store, PRINCIPAL_A, {
      view: 'summary',
      media_buy_ids: ['mb-b'],
      period: { start: day(0), end: day(3) },
    });
    assert.equal(filtered.status, 'completed', JSON.stringify(filtered));
    assert.deepEqual(filtered.scope.delivery_config_generations, [
      { delivery_config_id: 'analytics-daily', delivery_config_version: 1, feed_purpose: 'analytics' },
    ]);
    const unknown = await read(store, PRINCIPAL_A, {
      view: 'summary',
      media_buy_ids: ['mb-unknown'],
      period: { start: day(0), end: day(3) },
    });
    assert.equal(unknown.failure_kind, 'lookup_unavailable');
    // Another principal does not learn that mb-b exists on this subscription.
    const other = await read(store, PRINCIPAL_B, {
      view: 'summary',
      media_buy_ids: ['mb-b'],
      period: { start: day(0), end: day(3) },
    });
    assert.equal(other.failure_kind, 'lookup_unavailable');
  });

  test('a billing cutover stub obligation keeps stub: true through to the wire (adcp#8617)', async () => {
    const { store, producer } = setup();
    // The stub covers [E, first incoming boundary): here the first five hours of a day.
    const stub = {
      ...owed(1, ['mb-a']),
      period: { start: day(1), end: new Date(Date.parse(day(1)) + 5 * 3_600_000).toISOString() },
      stub: true,
    };
    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [stub, owed(2, ['mb-a'])], 3));
    const stored = [...store.obligations.values()].sort(
      (l, r) => Date.parse(l.period.start) - Date.parse(r.period.start)
    );
    assert.equal(stored[0].stub, true);
    assert.equal(stored[1].stub, undefined);
    store.ledgerAsOf = day(4);
    const periods = await read(store, PRINCIPAL_A, { view: 'periods', period: { start: day(0), end: day(3) } });
    assert.equal(periods.status, 'completed', JSON.stringify(periods));
    const wire = periods.periods.map(item => [item.period.start, item.stub]);
    assert.deepEqual(wire, [
      [day(1), true],
      [day(2), undefined],
    ]);
  });

  test('status ingest accepts only owed periods of the caller', async () => {
    const { store, producer } = setup();
    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a']), owed(3, ['mb-a'])], 4));
    store.ledgerAsOf = day(5);
    const ingest = createSyncReportingStatusHandler(store, {
      resolveConsumerId: context => `consumer-${context.principal.principalId}`,
      resolveSubscriptionPrincipal: context => context.principal,
      now: () => new Date(Date.parse(day(5))),
    });
    const status = (n, id) => ({
      reporting_status_id: `subscription-status-${id}`,
      delivery_config_id: 'analytics-daily',
      delivery_config_version: 1,
      report_definition_id: request.report_definition_id,
      period: { start: day(n), end: day(n + 1), source_timezone: 'UTC' },
      consumer_status: 'obligation_missing',
      status_as_of: day(n + 1.5),
    });
    const submit = (principal, statuses, key) =>
      ingest(
        { account: { account_id: ACCOUNT }, idempotency_key: `subscription-batch-${key}`, statuses },
        { account: { id: ACCOUNT }, principal }
      );
    const owedResult = await submit(PRINCIPAL_A, [status(1, 'owed-0001')], 'owed-0001');
    assert.equal(owedResult.results[0].result, 'recorded', JSON.stringify(owedResult));
    // Day 2 is a gap in the owed set: not a bare grid slot the caller may report on.
    const gap = await submit(PRINCIPAL_A, [status(2, 'gap-00001')], 'gap-00001');
    assert.equal(gap.results[0].result, 'failed', JSON.stringify(gap));
    assert.equal(gap.results[0].errors[0].code, 'VALIDATION_ERROR');
    // Another principal cannot report on A's owed period.
    const foreign = await submit(PRINCIPAL_B, [status(3, 'foreign-01')], 'foreign-01');
    assert.equal(foreign.results[0].result, 'failed', JSON.stringify(foreign));
    // Naming A's obligation id does not help either.
    const [obligation] = [...store.obligations.values()].filter(value => value.period.start === day(3));
    const named = await submit(
      PRINCIPAL_B,
      [{ ...status(3, 'foreign-02'), reporting_obligation_id: obligation.reporting_obligation_id }],
      'foreign-02'
    );
    assert.equal(named.results[0].result, 'failed', JSON.stringify(named));
  });

  test('refuses unsafe plans', async () => {
    const { producer } = setup();
    await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 3));
    // A generation is immutable.
    const changed = generation(PRINCIPAL_A);
    changed.requestedMetrics = ['impressions'];
    await assert.rejects(
      producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 3, [changed])),
      error => error instanceof ReportingConfigurationImmutableError
    );
    // Only frozen periods are written.
    await assert.rejects(
      producer.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(5, ['mb-a'])], 3)),
      /owedThrough/
    );
    // A denominator that disagrees with the frozen media buys is refused.
    const mismatched = owed(2, ['mb-a', 'mb-b']);
    mismatched.constituents = [constituent('mb-a')];
    await assert.rejects(producer.planSubscriptionObligations(plan(PRINCIPAL_A, [mismatched], 3)), /denominator/);
    // Subscription generations never go through installConfiguration.
    await assert.rejects(
      producer.installConfiguration({ ...generation(PRINCIPAL_A), constituents: [], mediaBuyIds: [] }),
      /planSubscriptionObligations/
    );
    // A store without owed-set support cannot hold subscription generations.
    const legacyStore = new MemoryLedgerStore();
    legacyStore.recordOwedSetProgress = undefined;
    const legacy = createReportingProducer({
      store: legacyStore,
      source: createInlineReportingSourceExecutor(() => [], offering),
      offerings: [offering],
      contact: { name: 'Reporting operations' },
    });
    await assert.rejects(
      legacy.planSubscriptionObligations(plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 3)),
      /subscription generations/
    );
  });

  test('keeps account generation ids and fingerprints unchanged', async () => {
    const { store, producer } = setup();
    const input = {
      account: { account_id: ACCOUNT },
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: 1,
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
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: DAY,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    };
    const installed = await producer.installConfiguration(input);
    assert.equal(installed.configurationId, `rcfg_${sha([ACCOUNT, request.delivery_config_id, 1]).slice(0, 32)}`);
    assert.equal(
      installed.semanticFingerprint,
      `sha256:${sha({ ...input, schedule: { ...input.schedule, anchor: new Date(input.schedule.anchor).toISOString() } })}`
    );
    assert.equal(installed.subscription, undefined);
    assert.equal(installed.owedSet, undefined);
    assert.equal(reportingLedgerSubscriptionKeyV1(installed), '');
    // An account generation and a subscription generation with the same id coexist.
    await producer.planSubscriptionObligations(
      plan(PRINCIPAL_A, [owed(1, ['mb-a'])], 3, [
        generation(PRINCIPAL_A, { subscriptionId: request.delivery_config_id }),
      ])
    );
    assert.equal((await store.listConfigurations(ACCOUNT)).length, 2);
    // A principal without subscriptions sees the account generation exactly as before.
    store.ledgerAsOf = day(4);
    const plain = await createReportingStatusHandler(store)(
      { account: { account_id: ACCOUNT }, view: 'periods', period: { start: day(0), end: day(3) } },
      { account: { account_id: ACCOUNT } }
    );
    assert.equal(plain.status, 'completed', JSON.stringify(plain));
    assert.deepEqual(plain.periods, []);
    const owner = await read(store, PRINCIPAL_A, { view: 'periods', period: { start: day(0), end: day(3) } });
    assert.equal(owner.periods.length, 1);
  });
});
