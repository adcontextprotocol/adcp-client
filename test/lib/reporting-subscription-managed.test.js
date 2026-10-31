/**
 * The managed reporting-subscription path (experimental `media_buy.reporting_subscriptions`, AdCP
 * 3.3): a `subscriptions` block on createReliableReportingService builds the engine, installs the
 * principal section and capability, derives the roster and buys from the installed platform,
 * reconciles on writes and sweeps boundaries in runCycle, and records failures instead of throwing.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const { createInMemoryReportingSubscriptionEngineStoreV1 } = require('../../dist/lib/reporting/advanced/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const DAY = 86_400_000;
const ACCOUNT = 'account-a';
const TENANT = 'tenant-1';
const CLIENTS = { 'buyer-a': 'principal-a' };
const offeringId = redactedReportingSourceOfferingV1.offeringId;
let worlds = 0;

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
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: [],
  };
}

function world({ list = true, managed = {} } = {}) {
  const origin = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
  const day = n => new Date(origin + n * DAY).toISOString();
  const clock = { now: new Date(day(0.5)) };
  const scopeOf = ctx =>
    ctx.callerMutationScope?.principal_id
      ? ctx.callerMutationScope
      : CLIENTS[ctx.authInfo?.clientId]
        ? { tenant_id: TENANT, principal_id: CLIENTS[ctx.authInfo.clientId], principal_kind: 'buyer_agent' }
        : undefined;
  // Created without reportingSubscriptions: the service installs that section.
  const { lifecycle } = createTestPrincipalLifecycle({ clock, resolvePrincipal: scopeOf });
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
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  const store = new MemoryLedgerStore();
  const reads = { list: 0, buys: 0 };
  // The host's grant as list_accounts shows it; authorizedAt undefined omits authorized_at.
  const host = { authorizedAt: day(-30), allowedTasks: ['get_reporting_status', 'get_media_buys'] };
  const service = createReliableReportingService({
    store,
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: deliveryOffering(),
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
    resolveCoverage: () => ({ constituents: [constituent('mb-1')] }),
    resolveConsumerId: context => context.authInfo.clientId,
    subscriptions: {
      principals: lifecycle,
      configure: () => ({
        requestedMetrics: request.requestedMetrics,
        requestedDimensions: request.requestedDimensions,
        sourceSettings,
      }),
      ...managed,
    },
  });
  const account = { id: ACCOUNT, name: 'Account A', status: 'active', ctx_metadata: {} };
  const platform = service.install({
    capabilities: { specialisms: [], config: {} },
    accounts: {
      resolution: 'explicit',
      resolve: async ref => (ref?.account_id === ACCOUNT ? account : null),
      upsert: async () => [],
      ...(list
        ? {
            list: async () => {
              reads.list += 1;
              return {
                items: [
                  {
                    ...account,
                    timezone: 'UTC',
                    authorization: {
                      allowed_tasks: host.allowedTasks,
                      ...(host.authorizedAt !== undefined ? { authorized_at: host.authorizedAt } : {}),
                    },
                  },
                ],
              };
            },
          }
        : {}),
    },
    sales: {
      getMediaBuys: async () => {
        reads.buys += 1;
        return {
          media_buys: [
            {
              media_buy_id: 'mb-1',
              status: 'completed',
              confirmed_at: day(1.5),
              start_time: day(3),
              end_time: day(4),
              packages: [{ package_id: 'pkg' }],
            },
          ],
        };
      },
    },
  });
  const server = createAdcpServerFromPlatform(platform, {
    name: 'reporting-subscription-managed',
    version: '1.0.0',
    protocol: lifecycle.protocol,
    validation: { requests: 'strict', responses: 'strict' },
  });
  const call = (clientId, name, args) =>
    server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } }, { authInfo: { clientId } });
  const subscribe = () =>
    call('buyer-a', 'sync_principal', {
      // A fresh key per world: the framework's idempotency cache outlives one server.
      idempotency_key: `managed-subscription-${String(++worlds).padStart(4, '0')}`,
      configuration: {
        reporting_subscriptions: [
          {
            subscription_id: 'analytics-daily',
            subscription_version: 1,
            active: true,
            scope: { all_authorized_accounts: true },
            selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
            reconciliation_mode: 'delivery_only',
          },
        ],
      },
    });
  return { clock, lifecycle, service, platform, server, store, reads, host, call, subscribe, day };
}

describe('managed reporting subscriptions', () => {
  test('the service installs the principal section and advertises both capabilities', () => {
    const { lifecycle, platform, service } = world();
    assert.ok(lifecycle.capabilities.supported_sections.includes('reporting_subscriptions'));
    assert.equal(platform.capabilities.principal, lifecycle.capabilities);
    assert.deepEqual(service.capabilities.configuration_tasks, ['sync_principal', 'sync_accounts']);
    assert.deepEqual(service.capabilities.subscriptions, { supported: true, backfill_on_regrant: false });
  });

  test('a write reconciles from the derived roster and buys, and runCycle plans and delivers', async () => {
    const w = world();
    const applied = await w.subscribe();
    assert.notEqual(applied.isError, true, JSON.stringify(applied.structuredContent));
    assert.equal(applied.structuredContent.result.kind, 'applied');
    assert.ok(w.reads.list > 0 && w.reads.buys > 0, 'the write reconciled from accounts.list and getMediaBuys');
    w.clock.now = new Date();
    const cycle = await w.service.runCycle({ accountId: ACCOUNT });
    assert.deepEqual(cycle.subscriptionPlanningFailures, []);
    assert.ok(cycle.revisionsCommitted >= 1, JSON.stringify(cycle));
    const status = await w.call('buyer-a', 'get_reporting_status', {
      account: { account_id: ACCOUNT },
      view: 'summary',
    });
    assert.notEqual(status.isError, true, JSON.stringify(status.structuredContent));
    assert.equal(status.structuredContent.subscription_coverage[0].subscription_id, 'analytics-daily');
  });

  test('without a readable roster the failure is recorded with its code, never thrown', async () => {
    const failures = [];
    const w = world({ list: false, managed: { planningErrorHandler: failure => failures.push(failure) } });
    const applied = await w.subscribe();
    assert.equal(applied.structuredContent.result.kind, 'applied', 'a failed trigger never fails the write');
    assert.equal(failures[0].error.code, 'SUBSCRIPTION_ROSTER_UNAVAILABLE');
    const cycle = await w.service.runCycle({ accountId: ACCOUNT });
    assert.equal(cycle.subscriptionPlanningFailures[0].error.code, 'SUBSCRIPTION_ROSTER_UNAVAILABLE');
    assert.equal(cycle.subscriptionPlanningFailures[0].principal.principalId, 'principal-a');
  });

  test('configuration mistakes are refused when the service is created', () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const base = {
      store: new MemoryLedgerStore(),
      adapters: {},
      statusRetentionDays: 400,
      automatedRecoveryWindowSeconds: 86_400,
      contact: { name: 'Ops', email: 'ops@example.com' },
      resolveSource: () => ({}),
      resolveCurrency: () => 'USD',
      resolveCoverage: () => ({ constituents: [] }),
    };
    assert.throws(
      () => createReliableReportingService({ ...base, subscriptions: { principals: lifecycle } }),
      error => error.name === 'PlatformConfigError' || error instanceof TypeError
    );
  });

  test('list_accounts serves the grant journal authorized_at, stamped once and never regressed', async () => {
    const w = world();
    w.host.authorizedAt = undefined;
    await w.subscribe();
    const authorizedAt = async () =>
      (await w.call('buyer-a', 'list_accounts', {})).structuredContent.accounts.find(
        item => item.account_id === ACCOUNT
      ).authorization.authorized_at;
    const first = await authorizedAt();
    assert.ok(first, 'an omitted authorized_at is stamped by the journal');
    assert.equal(await authorizedAt(), first, 'and served unchanged afterwards');
    // A host value that moves the open chain earlier is refused and logged.
    const warnings = [];
    const warn = console.warn;
    console.warn = message => warnings.push(String(message));
    try {
      w.host.authorizedAt = w.day(-90);
      assert.equal(await authorizedAt(), first);
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some(message => message.includes('authorized_at_regressed')));
  });

  test('grants.changed revokes at the pushed instant and a re-grant inside retention keeps the chain', async () => {
    const w = world();
    await w.subscribe();
    const authorizedAt = async () =>
      (await w.call('buyer-a', 'list_accounts', {})).structuredContent.accounts[0].authorization.authorized_at;
    const chain = await authorizedAt();
    const principal = { tenantId: TENANT, principalId: 'principal-a' };
    w.host.allowedTasks = ['get_media_buys']; // the listing agrees with the push: no reporting access
    await w.service.grants.changed({ principal, accountId: ACCOUNT, at: w.day(5), authorized: false });
    const engine = w.service.subscriptionWiring.engine;
    assert.equal(await engine.isAuthorized(principal, ACCOUNT), false);
    w.host.allowedTasks = ['get_reporting_status', 'get_media_buys'];
    await w.service.grants.changed({
      principal,
      accountId: ACCOUNT,
      at: new Date().toISOString(),
      authorized: true,
      allowedTasks: w.host.allowedTasks,
    });
    assert.equal(await engine.isAuthorized(principal, ACCOUNT), true);
    assert.equal(await authorizedAt(), chain, 'a re-grant inside status_retention_days continues the chain');
  });

  test('a cancelled reconcile stops before the derived reads', async () => {
    const w = world();
    await w.subscribe();
    const reads = { ...w.reads };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      w.service.subscriptionWiring.engine.reconcile(
        { tenantId: TENANT, principalId: 'principal-a' },
        { signal: controller.signal }
      ),
      error => error.name === 'AbortError'
    );
    assert.deepEqual(w.reads, reads, 'no accounts.list or getMediaBuys read after cancellation');
  });

  test('the identity snapshot kept for service-context reads holds no secrets', async () => {
    const stateStore = createInMemoryReportingSubscriptionEngineStoreV1();
    const w = world({ managed: { stateStore } });
    await w.subscribe();
    await w.server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: { name: 'get_reporting_status', arguments: { account: { account_id: ACCOUNT }, view: 'summary' } },
      },
      { authInfo: { clientId: 'buyer-a', token: 'bearer-secret', apiKey: 'key-secret', scopes: ['reporting'] } }
    );
    const binding = await stateStore.get({ tenantId: TENANT, principalId: 'principal-a' }, 'binding');
    assert.deepEqual(binding.value.authInfo, { clientId: 'buyer-a', scopes: ['reporting'] });
    assert.ok(!JSON.stringify(binding.value).includes('secret'));
  });
});
