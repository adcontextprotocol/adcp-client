/**
 * Buyer reconcile and explain (experimental `media_buy.reporting_subscriptions`, AdCP 3.3) against an
 * in-process managed seller: the owed set from wire reads, each period's status against the seller's
 * ledger, not-owed lines with their reasons, and the fleet fan-out.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { ReportingClient, ADCPMultiAgentClient } = require('../../dist/lib/index.js');
const { coverageTraceForBuyer, diffCoverageTraces } = require('../../dist/lib/reporting/advanced/index.js');
const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
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
      primary_keys: ['account_id', 'media_buy_id'],
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: [],
  };
}

/** A managed seller and a buyer client that calls it through dispatchTestRequest. */
function world() {
  const origin = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
  const day = n => new Date(origin + n * DAY).toISOString();
  const clock = { now: new Date(day(0.5)) };
  const scopeOf = ctx =>
    ctx.callerMutationScope?.principal_id
      ? ctx.callerMutationScope
      : { tenant_id: TENANT, principal_id: 'principal-a', principal_kind: 'buyer_agent' };
  const { lifecycle } = createTestPrincipalLifecycle({
    clock,
    resolvePrincipal: scopeOf,
    includeCompatibilityNotificationTask: true,
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
  const buys = [
    {
      media_buy_id: 'mb-1',
      status: 'completed',
      currency: 'USD',
      total_budget: 1000,
      revision: 1,
      confirmed_at: day(1.5),
      start_time: day(3),
      end_time: day(5),
      packages: [{ package_id: 'pkg' }],
    },
  ];
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
    resolveCoverage: () => ({ constituents: buys.map(buy => constituent(buy.media_buy_id)) }),
    resolveConsumerId: context => context.authInfo.clientId,
    subscriptions: { principals: lifecycle },
  });
  const account = { id: ACCOUNT, name: 'Account A', status: 'active', ctx_metadata: {}, timezone: 'UTC' };
  const platform = service.install({
    capabilities: {
      specialisms: [],
      config: {},
      capability_changes: {
        capabilities_version: 'reconcile-1',
        cache_ttl_seconds: 3600,
        notifications: { supported: true, registration_task: 'sync_principal', event_types: ['capabilities.changed'] },
      },
    },
    accounts: {
      resolution: 'explicit',
      resolve: async ref => (ref?.account_id === ACCOUNT ? account : null),
      upsert: async () => [],
      list: async () => ({
        items: [
          {
            ...account,
            authorization: { allowed_tasks: ['get_reporting_status', 'get_media_buys'], authorized_at: day(-30) },
          },
        ],
      }),
    },
    sales: { getMediaBuys: async () => ({ media_buys: structuredClone(buys) }) },
  });
  const server = createAdcpServerFromPlatform(platform, {
    name: 'reporting-subscription-reconcile',
    version: '1.0.0',
    protocol: lifecycle.protocol,
    validation: { requests: 'strict', responses: 'strict' },
  });
  const call = async (name, args = {}) => {
    const response = await server.dispatchTestRequest(
      { method: 'tools/call', params: { name, arguments: args } },
      { authInfo: { clientId: 'buyer-a' } }
    );
    if (response.isError) return { success: false, error: JSON.stringify(response.structuredContent), data: undefined };
    return { success: true, status: 'completed', data: response.structuredContent };
  };
  const buyer = {
    getPrincipal: params => call('get_principal', params ?? {}),
    syncPrincipal: params => call('sync_principal', params),
    listAccounts: params => call('list_accounts', params ?? {}),
    getAdcpCapabilities: params => call('get_adcp_capabilities', params ?? {}),
    getMediaBuys: params => call('get_media_buys', params),
    getReportingStatus: params => call('get_reporting_status', params),
    getAgentId: () => 'seller-a',
  };
  const reporting = new ReportingClient(buyer, {
    createIdempotencyKey: () => `reconcile-${String(++worlds).padStart(8, '0')}`,
  });
  return { clock, service, buys, buyer, reporting, day, store };
}

const subscription = {
  subscription_id: 'analytics-daily',
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
  reconciliation_mode: 'delivery_only',
};

describe('client.reporting.reconcile', () => {
  test('owed periods start missing, then read delivered once the seller plans and produces them', async () => {
    const w = world();
    const created = await w.reporting.subscribe(subscription);
    assert.equal(created.action, 'created');
    const now = new Date();
    const before = await w.reporting.reconcile({ now });
    assert.equal(before.definitive, true, JSON.stringify(before.accounts));
    assert.equal(before.agent_id, 'seller-a');
    assert.deepEqual(
      before.periods.map(line => [line.period.start, line.status, line.responsible_party]),
      [
        [w.day(3), 'missing_obligation', 'seller'],
        [w.day(4), 'missing_obligation', 'seller'],
      ]
    );
    assert.equal(before.summary.owed, 2);
    assert.equal(before.periods[0].reason, 'owed');
    assert.deepEqual(before.periods[0].media_buy_ids, ['mb-1']);
    assert.equal(before.periods[0].period.timezone, 'UTC');
    w.clock.now = now;
    const cycle = await w.service.runCycle({ accountId: ACCOUNT });
    assert.ok(cycle.revisionsCommitted >= 2, JSON.stringify(cycle));
    const after = await w.reporting.reconcile({ now });
    assert.deepEqual(
      after.periods.map(line => line.status),
      ['delivered', 'delivered']
    );
    assert.ok(after.periods.every(line => line.reporting_revision_id && line.reporting_obligation_id));
    assert.equal(after.summary.delivered, 2);
    assert.match(after.periods[0].message, /Delivered\.$/);
  });

  test('a period inside the grace after its end is pending, not missing', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const justAfter = new Date(Date.parse(w.day(4)) + 10 * 60_000);
    const report = await w.reporting.reconcile({ now: justAfter });
    assert.deepEqual(
      report.periods.map(line => [line.period.start, line.status]),
      [[w.day(3), 'pending']]
    );
    const strict = await w.reporting.reconcile({ now: justAfter, grace: 'PT5M' });
    assert.equal(strict.periods[0].status, 'missing_obligation');
  });

  test('includeNotOwed adds the periods that are not owed, each with its reason', async () => {
    const w = world();
    w.buys[0].confirmed_at = w.day(4.5); // the first flight day ends before confirmation
    await w.reporting.subscribe(subscription);
    const report = await w.reporting.reconcile({ now: new Date(), since: w.day(-1), includeNotOwed: true });
    assert.deepEqual(
      report.periods.map(line => [line.period.start, line.status, line.reason]),
      [
        [w.day(3), 'not_owed', 'before_confirmation'],
        [w.day(4), 'missing_obligation', 'owed'],
      ]
    );
    assert.equal(report.periods[0].responsible_party, 'none');
    assert.match(report.periods[0].message, /before mb-1 was confirmed at 20/);
    assert.equal(report.summary.not_owed, 1);
    assert.equal(report.summary.owed, 1);
  });

  test('a since window leaves out periods that ended before it', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const report = await w.reporting.reconcile({ now: new Date(), since: w.day(4.5) });
    assert.deepEqual(
      report.periods.map(line => line.period.start),
      [w.day(4)]
    );
  });

  test('a failing account read makes the report non-definitive instead of smaller', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const failing = new ReportingClient({ ...w.buyer, getMediaBuys: async () => ({ success: false, error: 'boom' }) });
    const report = await failing.reconcile({ now: new Date() });
    assert.equal(report.definitive, false);
    assert.equal(report.accounts[0].status, 'failed');
    assert.equal(report.accounts[0].error.task, 'get_media_buys');
    // The Python SDK's ReconcileIssue shape and code.
    assert.deepEqual(
      report.issues.map(issue => [issue.code, issue.account_id]),
      [['SUBSCRIPTION_ACCOUNT_UNREADABLE', report.accounts[0].account_id]]
    );
    assert.match(report.issues[0].message, /Retry once get_media_buys answers/);
    const roster = await new ReportingClient({
      ...w.buyer,
      listAccounts: async () => ({ success: false, error: 'down' }),
    }).reconcile({ now: new Date() });
    assert.deepEqual(
      roster.issues.map(issue => [issue.code, issue.account_id]),
      [['SUBSCRIPTION_ROSTER_UNAVAILABLE', undefined]]
    );
    const named = await w.reporting.reconcile({ now: new Date(), accounts: ['acc_unknown'] });
    assert.deepEqual(
      named.issues.map(issue => issue.code),
      ['SUBSCRIPTION_ACCOUNT_NOT_COVERED']
    );
    assert.equal(named.definitive, false);
  });

  test('a read that never answers fails its account after the read timeout', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const hung = new ReportingClient({ ...w.buyer, getMediaBuys: () => new Promise(() => {}) });
    const report = await hung.reconcile({ now: new Date(), readTimeoutMilliseconds: 50 });
    assert.equal(report.definitive, false);
    assert.deepEqual(
      { task: report.accounts[0].error.task, code: report.accounts[0].error.code },
      { task: 'get_media_buys', code: 'TIMEOUT' }
    );
  });

  test('grace must be a fixed-length duration', async () => {
    const w = world();
    await assert.rejects(w.reporting.reconcile({ grace: 'P1M' }), error => error.code === 'INVALID_REQUEST');
  });
});

describe('client.reporting.explain', () => {
  test('explains a period from wire reads with the shared trace format', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const [owed] = await w.reporting.explain({ accountId: ACCOUNT, period: w.day(3).slice(0, 10), now: new Date() });
    assert.equal(owed.side, 'buyer');
    assert.equal(owed.verdict, 'owed');
    assert.equal(owed.subject.media_buy_id, 'mb-1');
    assert.equal(owed.subject.subscription_id, 'analytics-daily');
    assert.match(owed.inputs_digest, /^sha256:/);
    const [early] = await w.reporting.explain({ accountId: ACCOUNT, period: w.day(1).slice(0, 10), now: new Date() });
    assert.equal(early.verdict, 'not_owed');
    assert.equal(early.reason, 'outside_flight');
    assert.match(early.explanation, /^Not owed: the period ends /);
  });

  test('an unknown account is refused with a fix', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    await assert.rejects(
      w.reporting.explain({ accountId: 'nope', period: '2026-11-03' }),
      error => error.name === 'ReportingSubscriptionError' && /list_accounts/.test(error.message)
    );
  });
});

describe('multiClient.reporting.reconcile', () => {
  test('fans out per seller and sums the summary', async () => {
    const a = world();
    const b = world();
    await a.reporting.subscribe(subscription);
    await b.reporting.subscribe(subscription);
    const multi = new ADCPMultiAgentClient([]);
    // Stand the two in-process sellers in for configured agents.
    multi.agentClients.set('seller-a', a.buyer);
    multi.agentClients.set('seller-b', { ...b.buyer, getPrincipal: async () => ({ success: false, error: 'down' }) });
    const fleet = await multi.reporting.reconcile({ now: new Date() });
    assert.equal(fleet.bySeller['seller-a'].summary.owed, 2);
    assert.ok(
      fleet.issues.some(issue => issue.agent_id === 'seller-b' && issue.code === 'SUBSCRIPTION_PRINCIPAL_UNAVAILABLE')
    );
    assert.equal(fleet.definitive, false);
    assert.equal(fleet.summary.owed, 2);
  });
});

describe('reporting.explainCoverage (seller)', () => {
  test('the seller trace and the buyer trace of one period agree, digests included', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    const now = new Date();
    w.clock.now = now;
    await w.service.runCycle({ accountId: ACCOUNT });
    const principal = { tenantId: TENANT, principalId: 'principal-a' };
    const period = w.day(3).slice(0, 10);
    const [seller] = await w.service.explainCoverage({ principal, accountId: ACCOUNT, period, now });
    const [buyer] = await w.reporting.explain({ accountId: ACCOUNT, period, now });
    assert.equal(seller.side, 'seller');
    assert.equal(seller.subject.principal_id, 'principal-a');
    assert.equal(seller.verdict, 'owed');
    assert.equal(seller.seller_only.buy_visible, true);
    assert.ok(seller.seller_only.reporting_obligation_id, 'an owed, planned period names its obligation');
    assert.equal(diffCoverageTraces(buyer, seller), null, JSON.stringify(diffCoverageTraces(buyer, seller)));
    assert.equal(coverageTraceForBuyer(seller).seller_only, undefined);
  });

  test('an unknown subscription is refused with a fix', async () => {
    const w = world();
    await w.reporting.subscribe(subscription);
    await assert.rejects(
      w.service.explainCoverage({
        principal: { tenantId: TENANT, principalId: 'principal-a' },
        accountId: ACCOUNT,
        subscriptionId: 'nope',
        period: '2026-11-03',
      }),
      error => error.name === 'PlatformConfigError' && /no subscription/.test(error.message)
    );
  });
});

describe('adcp reporting diff', () => {
  test('names the first differing rule and exits 1, or agrees and exits 0', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const path = require('node:path');
    const { handleReportingCommand } = require('../../bin/adcp-reporting.js');
    const w = world();
    await w.reporting.subscribe(subscription);
    const traces = await w.reporting.explain({ accountId: ACCOUNT, period: w.day(3).slice(0, 10), now: new Date() });
    const dir = mkdtempSync(path.join(tmpdir(), 'adcp-reporting-diff-'));
    const left = path.join(dir, 'buyer.json');
    const right = path.join(dir, 'seller.json');
    writeFileSync(left, JSON.stringify(traces));
    const changed = structuredClone(traces);
    changed[0].steps[5].facts.stop_time = '2099-01-01T00:00:00Z';
    writeFileSync(right, JSON.stringify(changed));
    const output = [];
    const write = process.stdout.write;
    process.stdout.write = chunk => output.push(String(chunk));
    try {
      assert.equal(await handleReportingCommand(['diff', left, left], {}), 0);
      assert.equal(await handleReportingCommand(['diff', left, right], {}), 1);
    } finally {
      process.stdout.write = write;
    }
    assert.match(output.join(''), /The traces agree/);
    assert.match(output.join(''), /rule "flight"/);
  });
});
