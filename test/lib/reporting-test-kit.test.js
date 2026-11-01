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
    await assert.rejects(k.clock.advance('P60D'), /cannot pass the real clock/);
  });
});
