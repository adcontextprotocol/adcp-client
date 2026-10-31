/**
 * Managed delivery of subscription obligations in the Core service (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3): a managed generation is bound before its first
 * obligation, every delivered row carries account_id, and status subscribers hear only their own
 * principal's subscription transitions. The PostgreSQL end-to-end delivery lives in
 * packages/reporting-storage/test/reporting-subscription-delivery-pg.test.js.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  REPORTING_MANAGED_DELIVERY_COMPOSITION_V1,
  createReliableReportingService,
} = require('../../dist/lib/reporting/service/index.js');
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

const ACCOUNT = 'account-a';
const TENANT = 'tenant-1';
const A = { tenantId: TENANT, principalId: 'principal-a' };
const B = { tenantId: TENANT, principalId: 'principal-b' };
const day = n => new Date(Date.parse('2026-09-01T00:00:00.000Z') + n * 86_400_000).toISOString();
const offeringId = redactedReportingSourceOfferingV1.offeringId;

function deliveryOffering(primaryKeys = ['account_id', 'media_buy_id']) {
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
      primary_keys: primaryKeys,
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    method: {
      pattern: 'file_transfer',
      transport: 's3',
      orchestration: 'producer_managed',
      destination_modes: ['existing'],
      provider: { domain: 'storage.example' },
      format: 'jsonl',
    },
    standard_dimensions: [],
  };
}

function destination(id) {
  return {
    pattern: 'file_transfer',
    destination_id: id,
    active: true,
    provider: { domain: 'storage.example' },
    transport: 's3',
    location: `s3://bucket/${id}`,
    accepted_formats: ['jsonl'],
    accepted_verification_profiles: ['manifest_checksums'],
  };
}

function subscription(destinationId) {
  return {
    subscription_id: 'analytics-daily',
    subscription_version: 1,
    active: true,
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
    reconciliation_mode: 'delivery_only',
    destination: { destination_id: destinationId, path_template: '{account_id}/{offering_id}/{period_start}' },
  };
}

function buy(mediaBuyId, start, end) {
  return {
    media_buy_id: mediaBuyId,
    confirmed_at: day(1.5),
    start_time: day(start),
    end_time: day(end),
    packages: [{ package_id: `${mediaBuyId}-pkg`, reporting_delivery_offering_ids: [offeringId] }],
  };
}
const BUYS = { 'principal-a': [buy('mb-a', 3, 5)], 'principal-b': [buy('mb-b', 4, 5)] };

async function world({ bind, subscribers = [], primaryKeys, overrideA = false } = {}) {
  const clock = { now: new Date(day(0.5)) };
  const { lifecycle } = createTestPrincipalLifecycle({
    clock,
    reportingSubscriptions: {},
    prepareReportingDestination: ({ destination: value }) => ({
      state: 'validating',
      configuration: structuredClone(value),
    }),
  });
  let key = 0;
  for (const [principal, destinationId] of [
    [A, 'dest-a'],
    [B, 'dest-b'],
  ]) {
    const response = await lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `subscription-delivery-${String(++key).padStart(4, '0')}`,
        configuration:
          overrideA && principal === A
            ? {
                // adcp#8619: route this account to a second destination inside the one subscription.
                reporting_destinations: [destination(destinationId), destination('dest-a2')],
                reporting_subscriptions: [
                  {
                    ...subscription(destinationId),
                    destination_overrides: [
                      { account_ids: [ACCOUNT], destination_id: 'dest-a2', path_template: 'routed/{account_id}' },
                    ],
                  },
                ],
              }
            : {
                reporting_destinations: [destination(destinationId)],
                reporting_subscriptions: [subscription(destinationId)],
              },
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
  const store = new MemoryLedgerStore();
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  const service = createReliableReportingService({
    store,
    // The composition token a managed-delivery composition passes; the memory store stands in.
    [REPORTING_MANAGED_DELIVERY_COMPOSITION_V1]: store,
    subscribers,
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: deliveryOffering(primaryKeys),
        fetchSlice: slice => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: 'USD',
          reporting_rows: slice.media_buy_ids.map(mediaBuyId => ({
            media_buy_id: mediaBuyId,
            impressions: 1,
            spend: '1.00',
          })),
        }),
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
    resolveCoverage: () => ({ constituents: ['mb-a', 'mb-b'].map(constituent) }),
    subscriptions: {
      engine,
      resolvePrincipal: context => context.principalScope,
      listSubscriptionPrincipals: () => engine.listSubscriptionPrincipals(TENANT),
      resolveSubscriptionConfiguration: () => ({
        requestedMetrics: request.requestedMetrics,
        requestedDimensions: request.requestedDimensions,
        sourceSettings,
      }),
      ...(bind ? { bindManagedGeneration: input => bind(input, store) } : {}),
    },
  });
  clock.now = new Date(day(6));
  await engine.reconcile(A);
  await engine.reconcile(B);
  return { clock, engine, service, store };
}

describe('managed subscription delivery in the Core service', () => {
  test('binds each managed generation before its first obligation, with its destination and template', async () => {
    const binds = [];
    const { service, store } = await world({
      bind: async (input, ledger) => {
        // No obligation of the generation exists yet: a managed binding must come first.
        const written = [...ledger.obligations.values()].filter(
          value => value.configurationId === input.configuration.configurationId
        );
        assert.equal(written.length, 0);
        binds.push(input);
      },
    });
    const cycle = await service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) });
    assert.equal(cycle.planned, 3, JSON.stringify(cycle));
    assert.deepEqual(binds.map(value => value.principal.principalId).sort(), ['principal-a', 'principal-b']);
    for (const input of binds) {
      const owner = input.principal.principalId === 'principal-a' ? 'dest-a' : 'dest-b';
      assert.equal(input.subscription.destination.destination_id, owner);
      assert.equal(input.subscription.destination.path_template, '{account_id}/{offering_id}/{period_start}');
      assert.deepEqual(input.destinationMethod, { pattern: 'file_transfer', transport: 's3' });
      assert.equal(input.offering.method.pattern, 'file_transfer');
      assert.equal(input.configuration.subscription.principalId, input.principal.principalId);
    }
    // Binding happens once: a later cycle writes no new obligation and binds nothing again.
    await service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) });
    assert.equal(binds.length, 2);
    // Every delivered row carries account_id, inside the committed digest.
    assert.equal(store.revisions.size, 3);
    for (const revision of store.revisions.values()) {
      assert.ok(revision.rows.length > 0);
      for (const row of revision.rows) assert.equal(row.account_id, ACCOUNT);
    }
  });

  test('destination_overrides route an account to its own destination and template (adcp#8619)', async () => {
    const binds = [];
    const { service } = await world({ overrideA: true, bind: async input => binds.push(input) });
    await service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) });
    const routed = binds.find(value => value.principal.principalId === 'principal-a');
    assert.deepEqual(routed.destination, { destination_id: 'dest-a2', path_template: 'routed/{account_id}' });
    const other = binds.find(value => value.principal.principalId === 'principal-b');
    assert.deepEqual(other.destination, {
      destination_id: 'dest-b',
      path_template: '{account_id}/{offering_id}/{period_start}',
    });
  });

  test('a managed offering whose primary keys omit account_id is refused at creation (adcp#8619)', async () => {
    await assert.rejects(world({ primaryKeys: ['media_buy_id'] }), error =>
      /primary_keys omit account_id/.test(error.message)
    );
  });

  test('a failing bind writes nothing for that generation and retries next cycle', async () => {
    let fail = true;
    const { service, store } = await world({
      bind: async input => {
        if (fail && input.principal.principalId === 'principal-a') throw new Error('destination is not ready');
      },
    });
    await assert.rejects(service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) }), AggregateError);
    const owners = () => [...store.obligations.values()].map(value => value.subscription.principalId).sort();
    assert.deepEqual(owners(), ['principal-b'], 'A wrote no obligation it could not deliver');
    fail = false;
    await service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) });
    assert.deepEqual(owners(), ['principal-a', 'principal-a', 'principal-b']);
  });

  test('a managed offering without a binding composition fails to plan, not silently', async () => {
    const { service, store } = await world();
    await assert.rejects(service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) }), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /binds managed delivery/);
      return true;
    });
    assert.equal(store.obligations.size, 0);
  });

  test('status subscribers hear only their own principal’s subscription transitions', async () => {
    const heard = { a: [], b: [], account: [] };
    const subscriber = (id, principal) => ({
      subscriberId: id,
      account_id: ACCOUNT,
      ...(principal ? { principal } : {}),
      notify: transition => heard[id].push(transition.reporting_obligation_id),
    });
    const { service, store } = await world({
      bind: async () => {},
      subscribers: [subscriber('a', A), subscriber('b', B), subscriber('account')],
    });
    await service.runCycle({ accountId: ACCOUNT, now: new Date(day(6)) });
    const ownerOf = id => store.obligations.get(id).subscription.principalId;
    assert.ok(heard.a.length > 0 && heard.b.length > 0);
    assert.ok(heard.a.every(id => ownerOf(id) === 'principal-a'));
    assert.ok(heard.b.every(id => ownerOf(id) === 'principal-b'));
    assert.deepEqual(heard.account, [], 'an account subscriber learns of no principal’s subscription obligation');
  });
});
