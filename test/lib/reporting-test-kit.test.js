/**
 * The reporting-subscription test kit (experimental `media_buy.reporting_subscriptions`, AdCP 3.3):
 * a managed reference seller on a virtual clock, buyers bound to it, grant, timezone and buy levers,
 * and assertAgreement between the seller's frozen owed set and the buyer's reconcile.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  createReportingTestKit,
  offerings,
  reportingTestStart,
  withReportingTestKit,
} = require('../../dist/lib/testing/reporting/index.js');

const START = reportingTestStart(30);
const day = n => new Date(Date.parse(START) + n * 86_400_000).toISOString();
const analyticsDaily = {
  subscription_id: 'analytics-daily',
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
  reconciliation_mode: 'delivery_only',
};

function kit(extra = {}) {
  return createReportingTestKit({
    start: START,
    offerings: [offerings.dailyAnalytics()],
    accounts: [{ account_id: 'acc_a', timezone: 'America/New_York', grants: ['agency-x'] }],
    buys: [
      {
        media_buy_id: 'mb_1',
        account_id: 'acc_a',
        confirmed_at: day(0.6),
        start_time: day(1),
        end_time: day(25),
      },
    ],
    ...extra,
  });
}

describe('createReportingTestKit', () => {
  test('owed periods are produced as the clock advances, and the two sides agree', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    const created = await buyer.reporting.subscribe(analyticsDaily);
    assert.equal(created.action, 'created');
    await k.clock.advance('P3D');
    assert.equal(k.clock.now().toISOString(), day(3));
    await k.assertAgreement('agency-x');
    const report = await buyer.reporting.reconcile({ now: k.clock.now() });
    assert.deepEqual(
      report.periods.map(line => [line.period.start, line.status]),
      [
        [day(1), 'delivered'],
        [day(2), 'delivered'],
      ]
    );
  });

  test('a revocation and a re-grant inside retention keep both sides in agreement', async () => {
    const k = kit();
    await k.buyer('agency-x').reporting.subscribe(analyticsDaily);
    await k.clock.advance('P2D');
    await k.grants.revoke('agency-x', 'acc_a');
    await k.clock.advance('P2D');
    const lost = await k.buyer('agency-x').reporting.reconcile({ now: k.clock.now() });
    assert.equal(lost.accounts.find(item => item.account_id === 'acc_a')?.status, 'unauthorized');
    await k.grants.regrant('agency-x', 'acc_a');
    await k.clock.advance('P2D');
    await k.assertAgreement('agency-x');
  });

  test('a wind-down grant keeps coverage; a cancellation stops it after the stop period', async () => {
    const k = kit();
    await k.buyer('agency-x').reporting.subscribe(analyticsDaily);
    await k.clock.advance('P2D');
    await k.grants.windDown('agency-x', 'acc_a');
    await k.clock.advanceTo(day(4.5));
    k.buys.cancel('mb_1');
    await k.clock.advance('P3D');
    await k.assertAgreement('agency-x');
    const report = await k.buyer('agency-x').reporting.reconcile({ now: k.clock.now() });
    const starts = report.periods.map(line => line.period.start);
    assert.equal(starts.at(-1), day(4), 'the period containing the stop is the last one owed');
    assert.ok(
      report.periods.every(line => line.status === 'delivered'),
      JSON.stringify(report.periods)
    );
  });

  test('withReportingTestKit runs a test body against a fresh kit', async () => {
    const owed = await withReportingTestKit({ start: START, accounts: [], buys: [] }, async k => {
      await k.buyer('agency-y').reporting.subscribe(analyticsDaily);
      await k.clock.advance('P1D');
      return (await k.buyer('agency-y').reporting.reconcile({ now: k.clock.now() })).summary.owed;
    });
    assert.equal(owed, 0);
  });

  test('the clock only moves forward', async () => {
    const k = kit();
    await assert.rejects(k.clock.advanceTo(day(-1)), RangeError);
  });

  test('the clock runs past the real clock, and those periods are produced', async () => {
    const start = reportingTestStart(1);
    const at = n => new Date(Date.parse(start) + n * 86_400_000).toISOString();
    const k = createReportingTestKit({
      start,
      offerings: [offerings.dailyAnalytics()],
      accounts: [{ account_id: 'acc_a', timezone: 'UTC', grants: ['agency-x'] }],
      buys: [{ media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at: at(0.5), start_time: at(1), end_time: at(25) }],
    });
    await k.buyer('agency-x').reporting.subscribe(analyticsDaily);
    await k.clock.advance('P5D');
    assert.ok(k.clock.now().getTime() > Date.now());
    const report = await k.buyer('agency-x').reporting.reconcile({ now: k.clock.now() });
    assert.ok(report.periods.length >= 3);
    assert.ok(
      report.periods.every(line => line.status === 'delivered'),
      JSON.stringify(report.summary)
    );
    await k.assertAgreement('agency-x');
  });
});

describe('comply_test_controller reporting_subscription_probe', () => {
  const probe = (buyer, params) =>
    buyer.call('comply_test_controller', { scenario: 'reporting_subscription_probe', params });

  test('is advertised, validates params, and drives grants, timezone and the clock', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    const listed = await buyer.call('comply_test_controller', { scenario: 'list_scenarios' });
    assert.ok(listed.data.scenarios.includes('reporting_subscription_probe'), JSON.stringify(listed.data));

    const invalid = await probe(buyer, { operation: 'reduce_grant', account_id: 'acc_a' });
    assert.equal(invalid.data?.error ?? JSON.parse(invalid.error ?? '{}').error, 'INVALID_PARAMS');

    const advanced = await probe(buyer, { operation: 'advance_time', target_time: day(2) });
    assert.equal(advanced.data.simulated.simulated_now, day(2));
    assert.equal(k.clock.now().toISOString(), day(2));

    const revoked = await probe(buyer, { operation: 'revoke_grant', account_id: 'acc_a' });
    assert.equal(revoked.data.simulated.unauthorized_at, day(2));
    const principal = await buyer.call('get_principal', {});
    const state = principal.data.result.configuration.reporting_subscriptions[0];
    assert.equal(state.accounts_unauthorized[0].account_id, 'acc_a');

    await probe(buyer, { operation: 'advance_time', target_time: day(3) });
    const regranted = await probe(buyer, { operation: 'regrant', account_id: 'acc_a' });
    assert.equal(regranted.data.simulated.chain, 'continued');
    assert.equal(regranted.data.simulated.regranted_at, day(3));

    const moved = await probe(buyer, {
      operation: 'set_account_timezone',
      account_id: 'acc_a',
      timezone: 'Europe/Paris',
    });
    assert.equal(moved.data.simulated.previous_timezone, 'America/New_York');
    assert.equal(moved.data.simulated.timezone, 'Europe/Paris');
    // The kit's daily offering is UTC-aligned, so an account timezone change cuts nothing over.
    assert.deepEqual(moved.data.simulated.timezone_cutovers, []);
    const accounts = await buyer.call('list_accounts', {});
    assert.equal(accounts.data.accounts.find(item => item.account_id === 'acc_a').timezone, 'Europe/Paris');
  });
});

describe('runReportingDoctor', () => {
  test('passes the kit seller, and names a fix for an account without a timezone', async () => {
    const { runReportingDoctor } = require('../../dist/lib/testing/reporting/index.js');
    const k = kit();
    const buyer = k.buyer('agency-x');
    // The SDK stamps authorization.authorized_at once a subscription reconciles the account.
    await buyer.reporting.subscribe(analyticsDaily);
    const client = { ...buyer, complyTestController: params => buyer.call('comply_test_controller', params) };
    for (const name of ['getAdcpCapabilities', 'getPrincipal', 'listAccounts', 'getMediaBuys'])
      client[name] = buyer[name];
    const report = await runReportingDoctor(client);
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    assert.ok(report.checks.some(check => check.id === 'controller.probe' && check.status === 'pass'));

    const broken = {
      ...client,
      listAccounts: async () => ({
        success: true,
        data: { accounts: [{ account_id: 'acc_z', authorization: { authorized_at: day(0) } }] },
      }),
    };
    const failing = await runReportingDoctor(broken);
    assert.equal(failing.ok, false);
    const zone = failing.checks.find(check => check.id === 'accounts.timezone');
    assert.equal(zone.status, 'fail');
    assert.match(zone.fix, /Account\.timezone/);
  });
});
