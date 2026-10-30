/**
 * The Reliable Reporting service writes the subscription engine's frozen owed sets into the ledger
 * and executes them (experimental `media_buy.reporting_subscriptions`, AdCP 3.3), and a principal
 * sees only its own subscription generations. Without subscriptions the service is byte-for-byte
 * what it was before.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
} = require('../../dist/lib/reporting/advanced/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');
const { reportingLedgerOptionOffTranscript } = require('../helpers/reporting-ledger-option-off-transcript.js');

const ACCOUNT = 'account-a';
const TENANT = 'tenant-1';
const A = { tenantId: TENANT, principalId: 'principal-a' };
const B = { tenantId: TENANT, principalId: 'principal-b' };
const C = { tenantId: TENANT, principalId: 'principal-c' };
const day = n => new Date(Date.parse('2026-09-01T00:00:00.000Z') + n * 86_400_000).toISOString();

function deliveryOffering() {
  const source = redactedReportingSourceOfferingV1;
  return {
    offering_id: source.offeringId,
    feed_purpose: 'analytics',
    report_definition_id: source.contract.report_definition_id,
    report_definition_uri: source.contract.reportDefinitionUri,
    report_definition_sha256: source.contract.reportDefinitionSha256,
    reporting_profile: {
      id: source.contract.reportingProfile,
      version: source.contract.schemaVersion,
      schema_uri: source.contract.schemaUri,
      schema_sha256: source.contract.schemaSha256,
      schema_dialect: source.contract.schemaDialect,
      schema_ref_policy: source.contract.schemaRefPolicy,
      grain: source.grain,
      primary_keys: ['media_buy_id'],
    },
    schedule: {
      period_duration: 'P1D',
      alignment: 'source_timezone',
      period_timezone_policy: 'fixed',
      period_timezone: 'UTC',
      delivery_sla: 'PT0S',
    },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: [],
  };
}

function subscription() {
  return {
    subscription_id: 'analytics-daily',
    subscription_version: 1,
    active: true,
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
    reconciliation_mode: 'delivery_only',
  };
}

const offeringId = redactedReportingSourceOfferingV1.offeringId;
function buy(mediaBuyId, start, end) {
  return {
    media_buy_id: mediaBuyId,
    confirmed_at: day(1.5),
    start_time: day(start),
    end_time: day(end),
    packages: [{ package_id: `${mediaBuyId}-pkg`, reporting_delivery_offering_ids: [offeringId] }],
  };
}

/** Each principal sees its own buys; both subscribe with the same subscription_id. */
const BUYS = {
  'principal-a': [buy('mb-a', 3, 6), buy('mb-a2', 5, 7)],
  'principal-b': [buy('mb-b', 4, 5)],
};

async function world({ failPolicyFor } = {}) {
  const clock = { now: new Date(day(0.5)) };
  const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
  let key = 0;
  for (const principal of [A, B]) {
    const response = await lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `subscription-service-${String(++key).padStart(4, '0')}`,
        configuration: { reporting_subscriptions: [subscription()] },
      },
      {
        callerMutationScope: {
          tenant_id: principal.tenantId,
          principal_id: principal.principalId,
          principal_kind: 'buyer_agent',
        },
      }
    );
    assert.equal(response.result.kind, 'applied', JSON.stringify(response));
  }
  const engine = createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: [deliveryOffering()],
    store: createInMemoryReportingSubscriptionEngineStoreV1(),
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    now: () => clock.now,
    hooks: {
      listAuthorizedAccounts: () => ({
        accounts: [{ account_id: ACCOUNT, authorized_at: '2026-08-01T00:00:00.000Z' }],
      }),
      listAccountBuys: principal => structuredClone(BUYS[principal.principalId] ?? []),
      resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
      isPeriodDelivered: () => false,
    },
  });
  const request = redactedReportingSourceRequestV1();
  const [template] = request.coverage.constituents;
  const constituent = mediaBuyId => ({
    ...structuredClone(template),
    constituentId: `constituent-${mediaBuyId}`,
    mediaBuyId,
    productBinding: { ...structuredClone(template.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
  });
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  const fetched = [];
  const store = new MemoryLedgerStore();
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  const service = createReliableReportingService({
    store,
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: deliveryOffering(),
        fetchSlice: slice => {
          fetched.push({ start: slice.start_date, media_buy_ids: [...slice.media_buy_ids] });
          return {
            reporting_period: { start: slice.start_date, end: slice.end_date },
            currency: 'USD',
            reporting_rows: slice.media_buy_ids.map(mediaBuyId => ({
              media_buy_id: mediaBuyId,
              impressions: 1,
              spend: '1.00',
            })),
          };
        },
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    // The host authorizes the account's buys; each obligation freezes the subset it owes.
    resolveCoverage: () => ({ constituents: ['mb-a', 'mb-a2', 'mb-b'].map(constituent) }),
    subscriptions: {
      engine,
      resolvePrincipal: context => context.principalScope,
      listSubscriptionPrincipals: () => engine.listSubscriptionPrincipals(TENANT),
      resolveSubscriptionConfiguration: ({ principal }) => {
        if (failPolicyFor === principal.principalId) throw new Error(`no policy for ${principal.principalId}`);
        return {
          requestedMetrics: request.requestedMetrics,
          requestedDimensions: request.requestedDimensions,
          sourceSettings,
        };
      },
    },
  });
  return { clock, engine, service, store, fetched };
}

const read = (service, principal, body) =>
  service.platform.getReportingStatus(
    { account: { account_id: ACCOUNT }, pagination: { max_results: 100 }, ...body },
    { account: { id: ACCOUNT, ctx_metadata: {} }, principalScope: principal }
  );

describe('reliable reporting service with subscription obligations', () => {
  test('without subscriptions is byte-for-byte unchanged', async () => {
    const golden = require(
      path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'ledger-option-off-golden.json')
    );
    assert.deepEqual(JSON.parse(JSON.stringify(await reportingLedgerOptionOffTranscript())), golden);
  });

  test('a cycle plans and executes the frozen owed sets, and each principal sees only its own', async () => {
    const { clock, engine, service, store, fetched } = await world();
    clock.now = new Date(day(8));
    await engine.reconcile(A);
    await engine.reconcile(B);
    assert.deepEqual((await engine.listSubscriptionPrincipals(TENANT)).map(value => value.principalId).sort(), [
      'principal-a',
      'principal-b',
    ]);
    // listPrincipals is the deprecated name of listSubscriptionPrincipals.
    assert.deepEqual(await engine.listPrincipals(TENANT), await engine.listSubscriptionPrincipals(TENANT));

    const cycle = await service.runCycle({ accountId: ACCOUNT, now: new Date(day(8)) });
    assert.equal(cycle.planned, 5, JSON.stringify(cycle));
    assert.equal(cycle.revisionsCommitted, 5, JSON.stringify(cycle));
    // The source receives each obligation's own frozen media buys, for its source-local date.
    assert.deepEqual(fetched.map(value => [value.start, value.media_buy_ids]).sort(), [
      [day(3).slice(0, 10), ['mb-a']],
      [day(4).slice(0, 10), ['mb-a']],
      [day(4).slice(0, 10), ['mb-b']],
      [day(5).slice(0, 10), ['mb-a', 'mb-a2']],
      [day(6).slice(0, 10), ['mb-a2']],
    ]);
    const configurations = await store.listConfigurations(ACCOUNT);
    assert.equal(configurations.length, 2, 'one generation per owning principal');
    for (const configuration of configurations) {
      assert.equal(configuration.delivery_config_id, 'analytics-daily');
      assert.equal(configuration.delivery_config_version, 1);
      assert.equal(configuration.owedSet.through, day(8));
      assert.equal(configuration.subscription.ownership, 'owed_set');
    }
    // A second cycle is idempotent.
    const again = await service.runCycle({ accountId: ACCOUNT, now: new Date(day(8)) });
    assert.equal(again.planned, 0);

    store.ledgerAsOf = day(8);
    const forA = await read(service, A, { view: 'periods', period: { start: day(0), end: day(8) } });
    assert.equal(forA.status, 'completed', JSON.stringify(forA));
    assert.deepEqual(
      forA.periods.map(value => [value.period.start, value.media_buy_ids, value.offering_id]),
      [
        [day(3), ['mb-a'], offeringId],
        [day(4), ['mb-a'], offeringId],
        [day(5), ['mb-a', 'mb-a2'], offeringId],
        [day(6), ['mb-a2'], offeringId],
      ]
    );
    assert.deepEqual(forA.scope.delivery_config_generations, [
      { delivery_config_id: 'analytics-daily', delivery_config_version: 1, feed_purpose: 'analytics' },
    ]);
    assert.equal(forA.revisions.length, 4);
    const summaryA = await read(service, A, { view: 'summary', period: { start: day(0), end: day(8) } });
    assert.equal(summaryA.health, 'complete', JSON.stringify(summaryA));
    assert.equal(summaryA.scope.scope_closed, true);
    assert.equal(summaryA.subscription_coverage[0].subscription_id, 'analytics-daily');

    const forB = await read(service, B, { view: 'periods', period: { start: day(0), end: day(8) } });
    assert.deepEqual(
      forB.periods.map(value => [value.period.start, value.media_buy_ids]),
      [[day(4), ['mb-b']]]
    );
    // A principal on the same account without a subscription sees neither.
    const forC = await read(service, C, { view: 'periods', period: { start: day(0), end: day(8) } });
    assert.deepEqual(forC.periods, []);
    assert.deepEqual(forC.scope.delivery_config_generations, []);
    // Nor can B read A's revision by id.
    await assert.rejects(
      service.platform.getMediaBuyDelivery(
        { account: { account_id: ACCOUNT }, reporting_revision_id: forA.revisions[0].reporting_revision_id },
        { account: { id: ACCOUNT, ctx_metadata: {} }, principalScope: B }
      ),
      error => error.code === 'REFERENCE_NOT_FOUND'
    );
    const own = await service.platform.getMediaBuyDelivery(
      { account: { account_id: ACCOUNT }, reporting_revision_id: forA.revisions[0].reporting_revision_id },
      { account: { id: ACCOUNT, ctx_metadata: {} }, principalScope: A }
    );
    assert.deepEqual(own.reporting_rows, [
      { account_id: ACCOUNT, media_buy_id: 'mb-a', impressions: 1, spend: '1.00' },
    ]);
  });

  test('one subscription that cannot be planned does not stop the others', async () => {
    const { clock, engine, service, store } = await world({ failPolicyFor: 'principal-a' });
    clock.now = new Date(day(8));
    await engine.reconcile(A);
    await engine.reconcile(B);
    await assert.rejects(service.runCycle({ accountId: ACCOUNT, now: new Date(day(8)) }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, /no policy for principal-a/);
      return true;
    });
    const configurations = await store.listConfigurations(ACCOUNT);
    assert.deepEqual(
      configurations.map(value => value.subscription.principalId),
      ['principal-b']
    );
    assert.equal(store.revisions.size, 1, 'the account still executed what it could plan');
  });

  test('requires the planning hooks when subscriptions are advertised', () => {
    const base = {
      store: new MemoryLedgerStore(),
      adapters: {
        fixture: {
          sourceOffering: {
            ...redactedReportingSourceOfferingV1,
            cadence: {
              ...redactedReportingSourceOfferingV1.cadence,
              expectedAvailabilityLag: 'PT0S',
              worstCaseAvailabilityLag: 'PT0S',
            },
          },
          deliveryOffering: deliveryOffering(),
          fetchSlice: () => ({ reporting_rows: [] }),
        },
      },
      contact: { name: 'Reporting operations' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
      resolveSource: () => ({ adapterId: 'fixture', sourceScope: {}, sourceTimezone: 'UTC' }),
      resolveCurrency: () => 'USD',
      resolveCoverage: () => ({ constituents: [] }),
    };
    const engine = {
      settings: { backfillOnRegrant: false, statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays },
      subscriptionCoverage: async () => [],
      frozenOwedSets: async () => [],
    };
    assert.throws(
      () => createReliableReportingService({ ...base, reportingSubscriptions: { engine, resolvePrincipal: () => A } }),
      /listSubscriptionPrincipals/
    );
    assert.throws(
      () =>
        createReliableReportingService({
          ...base,
          subscriptions: { engine, resolvePrincipal: () => A, listSubscriptionPrincipals: () => [] },
        }),
      /resolveSubscriptionConfiguration/
    );
    // The deprecated reportingSubscriptions key still works (above); passing both is refused.
    assert.throws(
      () =>
        createReliableReportingService({
          ...base,
          subscriptions: { engine, resolvePrincipal: () => A },
          reportingSubscriptions: { engine, resolvePrincipal: () => A },
        }),
      { name: 'PlatformConfigError', configField: 'subscriptions' }
    );
  });
});
