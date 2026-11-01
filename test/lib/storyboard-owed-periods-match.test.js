/**
 * `check: owed_periods_match` (experimental, media_buy.reporting_subscriptions): the runner computes
 * the owed set from wire state with the SDK coverage function and compares it with the seller's
 * obligations in a get_reporting_status periods view, starting at ledger_retained_from.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  prefetchOwedPeriods,
  validateOwedPeriodsMatch,
} = require('../../dist/lib/testing/storyboard/owed-periods-match.js');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const { createReportingTestKit, offerings, reportingTestStart } = require('../../dist/lib/testing/reporting/index.js');

const START = reportingTestStart(30);
const day = n => new Date(Date.parse(START) + n * 86_400_000).toISOString();
const CHECK = { check: 'owed_periods_match', subscription_id: 'analytics-daily', description: 'owed set' };

async function world() {
  const kit = createReportingTestKit({
    start: START,
    offerings: [offerings.dailyAnalytics()],
    accounts: [{ account_id: 'acc_a', timezone: 'UTC', grants: ['agency-x'] }],
    buys: [
      { media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at: day(0.5), start_time: day(1), end_time: day(25) },
    ],
  });
  const buyer = kit.buyer('agency-x');
  await buyer.reporting.subscribe({
    subscription_id: 'analytics-daily',
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
    reconciliation_mode: 'delivery_only',
  });
  await kit.clock.advance('P4D');
  // The whole window: a seller's ledger_retained_from follows the request's period.
  const request = { account: { account_id: 'acc_a' }, view: 'periods', period: { start: day(0), end: day(4) } };
  const response = (await buyer.call('get_reporting_status', request)).data;
  const call = (task, params) => buyer.call(task, params);
  return { kit, buyer, request, response, call };
}

const grade = async (call, request, response, validations = [CHECK]) => {
  const computed = await prefetchOwedPeriods('get_reporting_status', validations, call, request, response);
  return validateOwedPeriodsMatch(validations[0], computed);
};

describe('owed_periods_match', () => {
  test('passes when the seller obligations are exactly the owed set', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    assert.ok(ours.length >= 3, `the seller planned ${ours.length} obligations`);
    const result = await grade(call, request, response);
    assert.equal(result.passed, true, result.error);
  });

  test('fails on a missing, an extra, or a changed obligation, and names them', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    const missing = structuredClone(response);
    missing.periods = missing.periods.filter(
      item => item !== missing.periods.find(p => p.delivery_config_id === 'analytics-daily')
    );
    const dropped = await grade(call, request, missing);
    assert.equal(dropped.passed, false);
    assert.match(dropped.error, /missing 1/);

    const extra = structuredClone(response);
    extra.periods.push({ ...structuredClone(ours.at(-1)), offering_id: 'fixture-not-selected' });
    const added = await grade(call, request, extra);
    assert.equal(added.passed, false);
    assert.match(added.error, /extra 1/);

    const changed = structuredClone(response);
    changed.periods.find(item => item.delivery_config_id === 'analytics-daily').media_buy_ids = ['mb_other'];
    const different = await grade(call, request, changed);
    assert.equal(different.passed, false);
    assert.match(different.error, /different/);
  });

  test('periods before ledger_retained_from are left out', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    const trimmed = structuredClone(response);
    const first = ours[0].period.start;
    trimmed.periods = trimmed.periods.filter(
      item => !(item.delivery_config_id === 'analytics-daily' && item.period.start === first)
    );
    trimmed.scope = { ...trimmed.scope, ledger_retained_from: ours[1].period.start };
    const result = await grade(call, request, trimmed);
    assert.equal(result.passed, true, result.error);
  });

  test('is unverifiable on more pages, the wrong view, or no subscription', async () => {
    const { call, request, response } = await world();
    const paged = { ...response, pagination: { has_more: true, cursor: 'x' } };
    assert.match((await grade(call, request, paged)).error, /has_more/);
    const summary = await grade(call, { ...request, view: 'summary' }, response);
    assert.match(summary.error, /view: periods/);
    const unknown = { ...CHECK, subscription_id: 'nope' };
    const missing = await grade(call, request, response, [unknown]);
    assert.equal(missing.passed, false);
    assert.match(missing.error, /no subscription/);
  });

  test('a storyboard can declare it, and runValidations grades it from the prefetched set', async () => {
    const storyboard = parseStoryboard(`
id: owed_periods_probe
version: "1.0.0"
title: Owed periods
category: reporting
summary: owed
narrative: owed
agent: { interaction_model: media_buy_seller }
caller: { role: buyer_agent }
phases:
  - id: periods
    title: Periods
    steps:
      - id: periods_view
        title: Periods view
        task: get_reporting_status
        sample_request: { account: { account_id: acc_a }, view: periods }
        validations:
          - check: owed_periods_match
            subscription_id: analytics-daily
            severity: advisory
            expires_after_version: "17.0.0"
            description: The owed set computed from wire state equals the seller's obligations
`);
    const [validation] = storyboard.phases[0].steps[0].validations;
    assert.equal(validation.subscription_id, 'analytics-daily');
    const { call, request, response } = await world();
    const owedPeriods = await prefetchOwedPeriods('get_reporting_status', [validation], call, request, response);
    const [result] = runValidations([validation], {
      taskName: 'get_reporting_status',
      agentUrl: 'http://seller.example',
      contributions: new Set(),
      owedPeriods,
    });
    assert.equal(result.passed, true, result.error);
    assert.equal(result.check, 'owed_periods_match');
  });
});
