/**
 * `check: owed_periods_match` (experimental, media_buy.reporting_subscriptions): the runner computes
 * the owed set from wire state with the SDK coverage function and compares it with the seller's
 * obligations in a get_reporting_status periods view over the comparison window (adcp#8717).
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  owedPeriodsWindowStart,
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

  test('a seller that purged inside status_retention_days fails on the periods it dropped', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    const trimmed = structuredClone(response);
    const first = ours[0].period.start;
    trimmed.periods = trimmed.periods.filter(
      item => !(item.delivery_config_id === 'analytics-daily' && item.period.start === first)
    );
    // ledger_retained_from is capped at ledger_as_of minus status_retention_days, which is earlier
    // than the request's period.start here, so the window starts at the expected start (adcp#8717).
    trimmed.scope = { ...trimmed.scope, ledger_retained_from: ours[1].period.start };
    const result = await grade(call, request, trimmed);
    assert.equal(result.passed, false);
    assert.match(result.error, /missing 1/);
    assert.match(result.error, /expected_start/);
  });

  test('an obligation the seller returns for a period before the window start is ignored (adcp#8717)', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    const early = structuredClone(response);
    // An obligation the coverage rule does not owe, but before the window: not counted as extra.
    early.periods.push({
      ...structuredClone(ours[0]),
      period: { start: day(-3), end: day(-2) },
    });
    const result = await grade(call, request, early);
    assert.equal(result.passed, true, result.error);
  });

  test('ledger_retained_from is capped at ledger_as_of minus status_retention_days (adcp#8717)', async () => {
    const { call, request, response } = await world();
    const ours = response.periods.filter(item => item.delivery_config_id === 'analytics-daily');
    const purged = structuredClone(response);
    // A seller claiming it retains nothing before ledger_as_of: the cap keeps status_retention_days of
    // obligations required, so the periods it dropped inside that window are missing.
    purged.scope = { ...purged.scope, ledger_retained_from: purged.ledger_as_of };
    purged.periods = purged.periods.filter(item => item.delivery_config_id !== 'analytics-daily');
    const result = await grade(call, { ...request, period: { end: request.period.end } }, purged);
    assert.equal(result.passed, false);
    assert.match(result.error, new RegExp(`missing ${ours.length}`));
    assert.match(result.error, /retention_cap/);
  });

  test('the window starts at the later of the expected start and the capped retention bound', () => {
    const asOf = '2030-06-30T00:00:00.000Z';
    assert.deepEqual(
      owedPeriodsWindowStart({ expectedStart: null, ledgerRetainedFrom: null, ledgerAsOf: asOf, statusRetentionDays: 7 }),
      { start: null, bound: null }
    );
    assert.deepEqual(
      owedPeriodsWindowStart({
        expectedStart: '2030-06-01T00:00:00Z',
        ledgerRetainedFrom: '2030-06-10T00:00:00Z',
        ledgerAsOf: asOf,
        statusRetentionDays: 90,
      }),
      // Capped at 2030-04-01, before the expected start.
      { start: '2030-06-01T00:00:00.000Z', bound: 'expected_start' }
    );
    assert.deepEqual(
      owedPeriodsWindowStart({
        expectedStart: '2030-06-01T00:00:00Z',
        ledgerRetainedFrom: '2030-06-20T00:00:00Z',
        ledgerAsOf: asOf,
        statusRetentionDays: 7,
      }),
      { start: '2030-06-20T00:00:00.000Z', bound: 'ledger_retained_from' }
    );
    assert.deepEqual(
      owedPeriodsWindowStart({
        expectedStart: '2030-06-01T00:00:00Z',
        ledgerRetainedFrom: '2030-06-29T00:00:00Z',
        ledgerAsOf: asOf,
        statusRetentionDays: 7,
      }),
      { start: '2030-06-23T00:00:00.000Z', bound: 'retention_cap' }
    );
    assert.deepEqual(
      owedPeriodsWindowStart({
        expectedStart: '2030-06-25T00:00:00Z',
        ledgerRetainedFrom: '2030-06-29T00:00:00Z',
        ledgerAsOf: asOf,
        statusRetentionDays: 7,
      }),
      { start: '2030-06-25T00:00:00.000Z', bound: 'expected_start' }
    );
    assert.deepEqual(
      owedPeriodsWindowStart({ expectedStart: '2030-06-25T00:00:00Z', ledgerRetainedFrom: null, ledgerAsOf: asOf }),
      { start: '2030-06-25T00:00:00.000Z', bound: 'expected_start' }
    );
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
