const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { InMemoryStateStore } = require('../../dist/lib/server/index.js');
const {
  createReportingSubscriptionEngineStateStoreV1,
  createReportingSubscriptionEngineV1,
} = require('../../dist/lib/reporting/advanced/index.js');
const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/consumer/index.js');
const {
  owedSubscriptionPeriodsV1,
  groupOwedSubscriptionPeriodsV1,
  reportingSubscriptionVersionRecordsV1,
  toExpectedReportingPeriodsV1,
} = require('../../dist/lib/reporting/advanced/index.js');
const { syncReportingSubscriptionsV1 } = require('../../dist/lib/index.js');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const SCOPE = { tenantId: 't', principalId: 'p' };
const CTX = { callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' } };
const ACCOUNT_ID = 'acct_1';

const OFFERING = {
  offering_id: 'off_a_pkg',
  feed_purpose: 'analytics',
  report_definition_id: 'rd_off_a_pkg',
  report_definition_uri: 'https://seller.example/report-definitions/off_a_pkg.json',
  report_definition_sha256: 'b'.repeat(64),
  reporting_profile: {
    id: 'adcp.delivery.v1',
    version: '1.0.0',
    schema_uri: 'https://seller.example/schemas/delivery.json',
    schema_sha256: 'a'.repeat(64),
    schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    schema_ref_policy: 'local_fragment_only',
    grain: 'daily',
    primary_keys: ['account_id', 'package_id'],
  },
  schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT6H' },
  supported_finality: ['official'],
  reconciliation_mode: 'delivery_only',
  standard_dimensions: ['package'],
};

function subscription(extra = {}) {
  return {
    subscription_id: 'analytics-daily',
    subscription_version: 1,
    active: true,
    scope: { all_authorized_accounts: true },
    selector: {
      feed_purpose: 'analytics',
      period_duration: 'P1D',
      required_finality: 'official',
      dimensions: ['package'],
    },
    reconciliation_mode: 'delivery_only',
    ...extra,
  };
}

const BUY = {
  media_buy_id: 'mb_1',
  confirmed_at: '2026-11-02T15:00:00Z',
  start_time: '2026-11-03T00:00:00Z',
  end_time: '2026-11-06T00:00:00Z',
  packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: ['off_a_pkg'] }],
};

/** A PrincipalLifecycleClient over the in-process principal runtime. */
function principalClient(lifecycle) {
  const wrap = data => ({
    success: true,
    status: 'completed',
    data,
    metadata: { status: 'completed', taskName: 'principal' },
    conversation: [],
    debug_logs: [],
  });
  return {
    getPrincipal: async params => wrap(await lifecycle.protocol.getPrincipal(params ?? {}, CTX)),
    syncPrincipal: async params => wrap(await lifecycle.protocol.syncPrincipal(params, CTX)),
  };
}

function engineFor(lifecycle, clock, store) {
  return createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: [OFFERING],
    statusRetentionDays: 30,
    now: () => clock.now,
    ...(store ? { store } : {}),
    hooks: {
      listAuthorizedAccounts: () => ({
        accounts: [{ account_id: ACCOUNT_ID, authorized_at: '2026-10-01T00:00:00.000Z' }],
      }),
      listAccountBuys: () => [structuredClone(BUY)],
      resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
      isPeriodDelivered: () => false,
    },
  });
}

describe('reporting subscription engine state store', () => {
  test('persists one CAS document per key, listed per principal and per tenant', async () => {
    const backing = new InMemoryStateStore();
    const store = createReportingSubscriptionEngineStateStoreV1({ store: backing });
    assert.equal(store.durability, 'process-local');
    assert.equal(await store.get(SCOPE, 'principal'), null);
    const value = { account: { grants: [{ authorized_at: '2026-10-01T00:00:00.000Z' }] }, subscriptions: {} };
    const first = await store.put(SCOPE, 'account:a', value, null);
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(await store.put(SCOPE, 'account:a', value, null), { outcome: 'conflict' });
    const read = await store.get(SCOPE, 'account:a');
    assert.deepEqual(read.value, value);
    assert.equal((await store.put(SCOPE, 'account:a', value, read.revision)).outcome, 'applied');
    // Each account is its own document, so accounts never contend on one CAS row.
    assert.equal((await store.put(SCOPE, 'account:b', value, null)).outcome, 'applied');
    assert.equal((await store.put(SCOPE, 'principal', { served: {} }, null)).outcome, 'applied');
    assert.deepEqual((await store.listKeys(SCOPE)).sort(), ['account:a', 'account:b', 'principal']);
    await store.put({ tenantId: 't', principalId: 'q' }, 'principal', { served: {} }, null);
    await store.put({ tenantId: 'other', principalId: 'p' }, 'principal', { served: {} }, null);
    assert.deepEqual((await store.listPrincipals('t')).map(scope => scope.principalId).sort(), ['p', 'q']);
    assert.deepEqual(await store.listPrincipals('other'), [{ tenantId: 'other', principalId: 'p' }]);
    assert.deepEqual(await store.listKeys({ tenantId: 'other', principalId: 'p' }), ['principal']);
    assert.throws(
      () => createReportingSubscriptionEngineStateStoreV1({ store: backing, durability: 'durable' }),
      /cannot be declared durable/
    );
  });

  test('an incomplete principal walk fails closed', async () => {
    const backing = new InMemoryStateStore();
    let page = 0;
    const endless = Object.assign(Object.create(backing), {
      list: async () => ({ items: [], nextCursor: `page-${++page}` }),
      getWithVersion: backing.getWithVersion.bind(backing),
      putIfMatch: backing.putIfMatch.bind(backing),
    });
    await assert.rejects(
      createReportingSubscriptionEngineStateStoreV1({ store: endless }).listPrincipals('t'),
      /refusing a partial list/
    );
    const repeating = Object.assign(Object.create(backing), {
      list: async () => ({ items: [], nextCursor: 'same' }),
      getWithVersion: backing.getWithVersion.bind(backing),
      putIfMatch: backing.putIfMatch.bind(backing),
    });
    await assert.rejects(
      createReportingSubscriptionEngineStateStoreV1({ store: repeating }).listPrincipals('t'),
      /repeating cursor/
    );
  });

  test('a fresh engine over the same store reads the same coverage', async () => {
    const clock = { now: new Date('2026-11-01T12:00:00.000Z') };
    const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
    const store = createReportingSubscriptionEngineStateStoreV1({ store: new InMemoryStateStore() });
    await syncReportingSubscriptionsV1(principalClient(lifecycle), [subscription()], {
      createIdempotencyKey: () => 'idempotency-key-0001',
    });
    clock.now = new Date('2026-11-02T00:00:00.000Z');
    await engineFor(lifecycle, clock, store).reconcile(SCOPE);
    const restarted = engineFor(lifecycle, clock, store);
    const owed = await restarted.owedPeriods(SCOPE, ACCOUNT_ID, { now: '2026-11-10T00:00:00.000Z' });
    assert.deepEqual(
      owed.map(row => row.period_start),
      ['2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-05T00:00:00.000Z']
    );
  });
});

describe('buyer helpers', () => {
  test('syncReportingSubscriptionsV1 writes and reads back subscriptions, and its records rebuild coverage', async () => {
    const clock = { now: new Date('2026-11-01T12:00:00.000Z') };
    const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    let key = 0;
    const keys = { createIdempotencyKey: () => `idempotency-key-${String(++key).padStart(4, '0')}` };
    const sent = { 1: subscription() };
    const first = await syncReportingSubscriptionsV1(client, [sent[1]], keys);
    assert.equal(first.subscriptions[0].state, 'active');
    assert.equal(first.subscriptions[0].accepted_at, '2026-11-01T12:00:00.000Z');
    clock.now = new Date('2026-11-04T12:00:00.000Z');
    sent[2] = subscription({ subscription_version: 2, exclude_account_ids: ['acct_other'] });
    const second = await syncReportingSubscriptionsV1(client, [sent[2]], keys);
    const versions = reportingSubscriptionVersionRecordsV1({ state: second.subscriptions[0], configurations: sent });
    assert.deepEqual(
      versions.map(version => [version.subscription_version, version.accepted_at, version.superseded_at]),
      [
        [1, '2026-11-01T12:00:00.000Z', '2026-11-04T12:00:00.000Z'],
        [2, '2026-11-04T12:00:00.000Z', undefined],
      ]
    );
    assert.throws(
      () => reportingSubscriptionVersionRecordsV1({ state: second.subscriptions[0], configurations: { 2: sent[2] } }),
      /keep every version/
    );

    // The buyer's rebuilt input yields the seller's owed set.
    const engine = engineFor(lifecycle, clock);
    await engine.reconcile(SCOPE);
    const buyer = owedSubscriptionPeriodsV1({
      subscription_id: 'analytics-daily',
      versions,
      account: { account_id: ACCOUNT_ID, grants: [{ authorized_at: '2026-10-01T00:00:00.000Z' }] },
      buys: [BUY],
      offerings: [OFFERING],
      now: '2026-11-10T00:00:00.000Z',
    });
    assert.deepEqual(buyer, await engine.owedPeriods(SCOPE, ACCOUNT_ID, { now: '2026-11-10T00:00:00.000Z' }));
    assert.deepEqual(
      buyer.map(row => [row.subscription_version, row.period_start.slice(0, 10)]),
      [
        [1, '2026-11-03'],
        [1, '2026-11-04'],
        [2, '2026-11-05'],
      ]
    );

    // A readback that drops a submitted subscription is refused.
    const lying = {
      getPrincipal: client.getPrincipal,
      syncPrincipal: async params => {
        const response = await client.syncPrincipal(params);
        response.data.result.configuration.reporting_subscriptions = [];
        return response;
      },
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(lying, [subscription({ subscription_version: 3 })], keys),
      /does not carry subscription/
    );
  });

  test('reportingSubscriptionVersionRecordsV1 orders newest-first prior_versions oldest first', () => {
    const configurations = {
      1: subscription(),
      2: subscription({ subscription_version: 2, exclude_account_ids: ['x'] }),
      3: subscription({ subscription_version: 3, exclude_account_ids: ['y'] }),
    };
    const state = {
      subscription_id: 'analytics-daily',
      subscription_version: 3,
      state: 'active',
      accepted_at: '2026-11-06T00:00:00.000Z',
      prior_versions: [
        { subscription_version: 2, accepted_at: '2026-11-04T00:00:00.000Z', superseded_at: '2026-11-06T00:00:00.000Z' },
        { subscription_version: 1, accepted_at: '2026-11-01T00:00:00.000Z', superseded_at: '2026-11-04T00:00:00.000Z' },
      ],
      configuration: configurations[3],
    };
    const versions = reportingSubscriptionVersionRecordsV1({ state, configurations });
    assert.deepEqual(
      versions.map(version => [version.subscription_version, version.accepted_at, version.superseded_at]),
      [
        [1, '2026-11-01T00:00:00.000Z', '2026-11-04T00:00:00.000Z'],
        [2, '2026-11-04T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
        [3, '2026-11-06T00:00:00.000Z', undefined],
      ]
    );
    assert.deepEqual(versions[1].configuration.exclude_account_ids, ['x']);
    // The records drive cutovers: each period belongs to the version in force when it started.
    const owed = owedSubscriptionPeriodsV1({
      subscription_id: 'analytics-daily',
      versions,
      account: { account_id: ACCOUNT_ID, grants: [{ authorized_at: '2026-10-01T00:00:00Z' }] },
      buys: [{ ...BUY, end_time: '2026-11-08T00:00:00Z' }],
      offerings: [OFFERING],
      now: '2026-11-10T00:00:00Z',
    });
    assert.deepEqual(
      owed.map(row => [row.subscription_version, row.period_start.slice(0, 10)]),
      [
        [1, '2026-11-03'],
        [2, '2026-11-04'],
        [2, '2026-11-05'],
        [3, '2026-11-06'],
        [3, '2026-11-07'],
      ]
    );
  });

  test('toExpectedReportingPeriodsV1 maps owed obligations onto expected periods', () => {
    const obligations = groupOwedSubscriptionPeriodsV1(
      owedSubscriptionPeriodsV1({
        subscription_id: 'analytics-daily',
        versions: [{ subscription_version: 1, accepted_at: '2026-11-01T12:00:00Z', configuration: subscription() }],
        account: { account_id: ACCOUNT_ID, grants: [{ authorized_at: '2026-10-01T00:00:00Z' }] },
        buys: [BUY],
        offerings: [OFFERING],
        now: '2026-11-10T00:00:00Z',
      })
    );
    const expected = toExpectedReportingPeriodsV1(obligations, template);
    assert.equal(expected.length, 3);
    assert.deepEqual(
      {
        deliveryConfigId: expected[0].deliveryConfigId,
        deliveryConfigVersion: expected[0].deliveryConfigVersion,
        reportDefinitionId: expected[0].reportDefinitionId,
        mediaBuyIds: expected[0].mediaBuyIds,
        periodStart: expected[0].periodStart,
        periodEnd: expected[0].periodEnd,
        status: expected[0].coverage.status,
        covered: expected[0].coverage.fully_covered_media_buy_ids,
      },
      {
        deliveryConfigId: 'analytics-daily',
        deliveryConfigVersion: 1,
        reportDefinitionId: 'rd_off_a_pkg',
        mediaBuyIds: ['mb_1'],
        periodStart: '2026-11-03T00:00:00.000Z',
        periodEnd: '2026-11-04T00:00:00.000Z',
        status: 'full',
        covered: ['mb_1'],
      }
    );
    assert.deepEqual(expected[0].coverage.package_ids, ['pkg_1']);
    // No default coverage: one could never match an obligation reporting packages or partial coverage.
    assert.throws(() => {
      const { coverage: _coverage, ...noCoverage } = template(obligations[0]);
      toExpectedReportingPeriodsV1(obligations, () => noCoverage);
    }, /must supply coverage/);
  });

  test('reportingSubscriptionVersionRecordsV1 falls back to configurations the readback carries', () => {
    const configurations = {
      1: subscription(),
      2: subscription({ subscription_version: 2, exclude_account_ids: ['x'] }),
    };
    const state = {
      subscription_id: 'analytics-daily',
      subscription_version: 2,
      state: 'active',
      accepted_at: '2026-11-04T00:00:00.000Z',
      // adcp#8588: sellers on 3.3.0-beta.2 return each prior version's configuration.
      prior_versions: [
        {
          subscription_version: 1,
          accepted_at: '2026-11-01T00:00:00.000Z',
          superseded_at: '2026-11-04T00:00:00.000Z',
          configuration: configurations[1],
        },
      ],
      configuration: configurations[2],
    };
    const versions = reportingSubscriptionVersionRecordsV1({ state });
    assert.deepEqual(
      versions.map(version => [version.subscription_version, version.configuration.exclude_account_ids]),
      [
        [1, undefined],
        [2, ['x']],
      ]
    );
    const { configuration: _dropped, ...bare } = state.prior_versions[0];
    assert.throws(
      () => reportingSubscriptionVersionRecordsV1({ state: { ...state, prior_versions: [bare] } }),
      /keep every version/
    );
  });

  test('syncReportingSubscriptionsV1 refuses an unintended deactivation and a changed stored configuration', async () => {
    const clock = { now: new Date('2026-11-01T12:00:00.000Z') };
    const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    let key = 0;
    const keys = { createIdempotencyKey: () => `idempotency-key-${String(++key).padStart(4, '0')}` };
    const other = subscription({ subscription_id: 'analytics-other', scope: { account_ids: ['acct_2'] } });
    await syncReportingSubscriptionsV1(client, [subscription(), other], keys);
    let writes = 0;
    const counting = {
      getPrincipal: client.getPrincipal,
      syncPrincipal: async params => {
        writes += 1;
        return client.syncPrincipal(params);
      },
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(counting, [subscription()], keys),
      /would deactivate active subscriptions it omits \("analytics-other"\)/
    );
    assert.equal(writes, 0, 'nothing is written');
    const explicit = await syncReportingSubscriptionsV1(
      counting,
      [subscription(), { ...other, subscription_version: 2, active: false }],
      keys
    );
    assert.equal(explicit.subscriptions.find(item => item.subscription_id === 'analytics-other').state, 'inactive');
    await syncReportingSubscriptionsV1(
      counting,
      [subscription({ subscription_version: 2, exclude_account_ids: ['z'] })],
      {
        ...keys,
        allowDeactivation: true,
      }
    );

    const rewriting = {
      getPrincipal: client.getPrincipal,
      syncPrincipal: async params => {
        const response = await client.syncPrincipal(params);
        for (const state of response.data.result.configuration.reporting_subscriptions ?? []) {
          state.configuration = { ...state.configuration, exclude_account_ids: ['seller-chosen'] };
        }
        return response;
      },
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(
        rewriting,
        [subscription({ subscription_version: 3, exclude_account_ids: ['z'] })],
        keys
      ),
      /stores a different configuration at \/exclude_account_ids\/0/
    );
  });
});

function fullCoverage(obligation) {
  return {
    status: 'full',
    media_buy_ids: [...obligation.media_buy_ids],
    fully_covered_media_buy_ids: [...obligation.media_buy_ids],
    partially_covered_media_buy_ids: [],
    unsupported_media_buy_ids: [],
    unknown_media_buy_ids: [],
    package_ids: ['pkg_1'],
    covered_package_ids: ['pkg_1'],
    unsupported_package_ids: [],
    unknown_package_ids: [],
  };
}

function template(obligation) {
  return {
    coverage: fullCoverage(obligation),
    feedPurpose: 'analytics',
    reportingProfile: 'adcp.delivery.v1',
    destinationRef: 'api',
    deliveryMethod: 'api',
    requiredFinality: 'official',
    reconciliationMode: 'delivery_only',
    coverageRequirement: 'full',
    reportDefinitionUri: OFFERING.report_definition_uri,
    reportDefinitionSha256: OFFERING.report_definition_sha256,
    schemaVersion: '1.0.0',
    schemaUri: OFFERING.reporting_profile.schema_uri,
    schemaSha256: OFFERING.reporting_profile.schema_sha256,
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    schemaRefPolicy: 'local_fragment_only',
    verificationProfile: 'native_commit',
  };
}

function emptyPeriodsPage(view = 'periods') {
  return {
    status: 'completed',
    view,
    ledger_snapshot_id: 'snapshot-1',
    ledger_as_of: '2026-11-10T00:00:00.000Z',
    changes_checkpoint: 'checkpoint-1',
    account_id: ACCOUNT_ID,
    scope: {
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2027-01-01T00:00:00.000Z',
      all_accessible_media_buys: true,
      media_buy_ids: [],
      delivery_config_generations: [],
      feed_purposes: [],
      finality: [],
      scope_closed: true,
      coverage_complete: true,
    },
    periods: [],
    revisions: [],
    materializations: [],
    receipts: [],
    consumer_statuses: [],
    pagination: { total_count: 0, has_more: false },
  };
}

function memoryPersistence() {
  const cursors = new Map();
  const leases = new Map();
  const id = key => `${key.consumerScope}|${key.accountId}`;
  return {
    checkpointStore: { async get() {}, async put() {} },
    pendingConsumerStatusStore: { async get() {}, async put() {}, async clear() {} },
    changesCheckpointStore: {
      async get(key) {
        return cursors.get(id(key));
      },
      async compareAndSet(key, expected, checkpoint) {
        const existing = cursors.get(id(key));
        if ((existing?.checkpoint ?? null) !== expected) return 'conflict';
        if (expected === checkpoint) return 'unchanged';
        cursors.set(id(key), { checkpoint, generation: (existing?.generation ?? 0) + 1 });
        return 'applied';
      },
    },
    workLeases: {
      async claim({ key, ownerToken }) {
        const keyId = id(key);
        if (leases.has(keyId)) return null;
        const lease = { scopeKey: keyId, ownerToken, generation: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
        leases.set(keyId, lease);
        return lease;
      },
      async renew(lease) {
        return leases.get(lease.scopeKey) === lease ? lease : null;
      },
      async release(lease) {
        if (leases.get(lease.scopeKey) !== lease) return false;
        leases.delete(lease.scopeKey);
        return true;
      },
    },
  };
}

describe('consumer runtime with subscription expectations', () => {
  test('reconciles subscription-derived expectations read from subscription_coverage', async () => {
    const coverage = [{ subscription_id: 'analytics-daily', subscription_version: 1, status: 'active', excluded: [] }];
    const calls = [];
    const client = {
      async getReportingStatus(params) {
        calls.push(params.view);
        return params.view === 'summary'
          ? { ...emptyPeriodsPage('summary'), subscription_coverage: coverage }
          : emptyPeriodsPage();
      },
      async syncReportingReceipts() {
        return { status: 'completed', results: [] };
      },
    };
    const seen = [];
    const nows = [];
    const consumer = createReliableReportingConsumerV1({
      persistence: memoryPersistence(),
      ownerToken: 'buyer-worker-1',
      runOnStart: false,
      accounts: [
        {
          consumerScope: 'seller.example|buyer',
          accountId: ACCOUNT_ID,
          reconciliation: {
            client,
            request: { account: { account_id: ACCOUNT_ID } },
            expectedPeriods: [],
            inspect: async () => ({ rowCount: 0, controlTotals: [] }),
          },
          subscriptionExpectationGraceMs: 3_600_000,
          subscriptionExpectations: ({ subscriptionCoverage, now, ledgerAsOf }) => {
            seen.push(subscriptionCoverage);
            nows.push([now.toISOString(), ledgerAsOf]);
            const obligations = groupOwedSubscriptionPeriodsV1(
              owedSubscriptionPeriodsV1({
                subscription_id: 'analytics-daily',
                versions: [
                  { subscription_version: 1, accepted_at: '2026-11-01T12:00:00Z', configuration: subscription() },
                ],
                account: { account_id: ACCOUNT_ID, grants: [{ authorized_at: '2026-10-01T00:00:00Z' }] },
                buys: [BUY],
                offerings: [OFFERING],
                coverage: subscriptionCoverage[0],
                now: now.toISOString(),
              })
            );
            return toExpectedReportingPeriodsV1(obligations, template);
          },
        },
      ],
    });
    const result = await consumer.runAccount(ACCOUNT_ID);
    assert.equal(result.state, 'reconciled');
    assert.equal(calls[0], 'summary', 'coverage is read before reconciling');
    assert.deepEqual(seen, [coverage]);
    assert.deepEqual(
      nows,
      [['2026-11-09T23:00:00.000Z', '2026-11-10T00:00:00.000Z']],
      'expectations use the snapshot ledger_as_of minus the grace, not the wall clock'
    );
    assert.equal(
      result.reconciliation.missingExpectedPeriods.length,
      3,
      'owed periods without obligations are missing'
    );
    assert.equal(result.reconciliation.definitive, false);

    // principal.changed refreshes through the hook and re-reconciles the scope's accounts.
    const refreshed = [];
    const scoped = createReliableReportingConsumerV1({
      persistence: memoryPersistence(),
      ownerToken: 'buyer-worker-2',
      runOnStart: false,
      onPrincipalChanged: input => refreshed.push(input.notification.reason),
      accounts: [
        {
          consumerScope: 'seller.example|buyer',
          accountId: ACCOUNT_ID,
          reconciliation: {
            client,
            request: { account: { account_id: ACCOUNT_ID } },
            expectedPeriods: [],
            inspect: async () => ({ rowCount: 0, controlTotals: [] }),
          },
        },
      ],
    });
    const results = await scoped.handleAuthenticatedPrincipalChanged(
      {
        notification_type: 'principal.changed',
        idempotency_key: 'principal-change-0001',
        reason: 'reporting_subscription_changed',
        agent_url: 'https://seller.example/mcp',
        fired_at: '2026-11-05T00:00:00Z',
        changed_at: '2026-11-05T00:00:00Z',
      },
      { consumerScope: 'seller.example|buyer' }
    );
    assert.deepEqual(refreshed, ['reporting_subscription_changed']);
    assert.deepEqual(
      results.map(item => [item.accountId, item.reason, item.state]),
      [[ACCOUNT_ID, 'principal.changed', 'reconciled']]
    );
    const change = n => ({
      notification_type: 'principal.changed',
      idempotency_key: `principal-change-${String(n).padStart(4, '0')}`,
      reason: 'reporting_subscription_changed',
      agent_url: 'https://seller.example/mcp',
      fired_at: '2026-11-05T00:00:00Z',
      changed_at: '2026-11-05T00:00:00Z',
    });
    const authentication = { consumerScope: 'seller.example|buyer' };
    // A redelivery with the same idempotency_key is dropped.
    assert.deepEqual(await scoped.handleAuthenticatedPrincipalChanged(change(1), authentication), []);
    assert.equal(refreshed.length, 1);
    // A burst arriving while the scope is reconciled shares one trailing run.
    const burst = await Promise.all(
      [2, 3, 4, 5].map(n => scoped.handleAuthenticatedPrincipalChanged(change(n), authentication))
    );
    assert.equal(refreshed.length, 3, 'one run for the first notification and one trailing run for the rest');
    assert.equal(burst[1], burst[2]);
    assert.equal(burst[2], burst[3]);
    assert.equal(
      await scoped.handleAuthenticatedPrincipalChanged(
        { notification_type: 'reporting.ledger_changed' },
        {
          consumerScope: 'seller.example|buyer',
        }
      ),
      null
    );
    await assert.rejects(
      scoped.handleAuthenticatedPrincipalChanged(
        { notification_type: 'principal.changed' },
        {
          consumerScope: 'seller.example|buyer',
        }
      ),
      /invalid identity fields/
    );
    await consumer.stop();
    await scoped.stop();
  });
});
