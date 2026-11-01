/**
 * Coverage explanations (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the reason-code
 * vocabulary matches the spec's reason-codes.json, every owed row of the canonical vectors explains as
 * owed with every step passing, and the classifier's owed rows are exactly the owed set.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const path = require('node:path');

const {
  COVERAGE_REASONS,
  COVERAGE_REASON_VOCABULARY_VERSION,
  COVERAGE_RULE_ORDER,
  EXPLAIN_TEMPLATES,
  classifySubscriptionPeriodsV1,
  explainSubscriptionCoverageV1,
  owedSubscriptionPeriodsV1,
} = require('@adcp/sdk/reporting/advanced');

const CANONICAL = path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'canonical');
const vocabulary = require(path.join(CANONICAL, 'reason-codes.json'));
const table = require(path.join(CANONICAL, 'vectors.json'));
const staleTzdata = typeof process.versions.tz === 'string' && process.versions.tz < '2026b';
const cases = table.cases.filter(
  testCase => !testCase.expected_error && !(staleTzdata && (testCase.timezones ?? []).some(zone => zone !== 'UTC'))
);

describe('coverage reason codes', () => {
  test('the vocabulary is the spec reason-codes.json, verbatim', () => {
    assert.equal(COVERAGE_REASON_VOCABULARY_VERSION, vocabulary.vocabulary_version);
    assert.deepEqual([...COVERAGE_RULE_ORDER], vocabulary.rule_order);
    assert.deepEqual(
      COVERAGE_REASONS.map(reason => ({ ...reason })),
      vocabulary.reasons.map(({ code, verdict, rule, side }) => ({ code, verdict, rule, side }))
    );
  });

  test('every reason has an explanation template', () => {
    assert.deepEqual(Object.keys(EXPLAIN_TEMPLATES).sort(), COVERAGE_REASONS.map(r => r.code).sort());
  });
});

describe('explainSubscriptionCoverageV1 over the canonical vectors', () => {
  for (const testCase of cases) {
    test(testCase.id, () => {
      const input = structuredClone(testCase.input);
      const owed = owedSubscriptionPeriodsV1(input);
      for (const row of owed) {
        const [traceOf] = explainSubscriptionCoverageV1({
          ...input,
          media_buy_id: row.media_buy_id,
          offering_id: row.offering_id,
          period: { start: row.period_start, end: row.period_end },
        }).filter(item => Date.parse(item.subject.period.end) === Date.parse(row.period_end));
        assert.ok(traceOf, `${row.media_buy_id} ${row.period_start}`);
        assert.equal(traceOf.verdict, 'owed', `${row.period_start}: ${traceOf.reason} ${traceOf.explanation}`);
        assert.ok(traceOf.reason.startsWith('owed'));
        assert.equal(traceOf.subject.subscription_version, row.subscription_version);
        assert.ok(
          traceOf.steps.every(step => step.result !== 'fail'),
          JSON.stringify(traceOf.steps)
        );
        assert.equal(traceOf.steps.length, COVERAGE_RULE_ORDER.length);
        assert.deepEqual(
          traceOf.steps.map(step => step.rule),
          COVERAGE_RULE_ORDER.slice(0, traceOf.steps.length)
        );
        assert.match(traceOf.inputs_digest, /^sha256:[0-9a-f]{64}$/);
      }
      const from = new Date(Math.min(...input.buys.map(buy => Date.parse(buy.start_time))) - 86_400_000 * 3);
      const classified = classifySubscriptionPeriodsV1({ ...input, from: from.toISOString() });
      const owedKeys = rows =>
        rows
          .map(row =>
            [
              row.subscription_version,
              row.media_buy_id,
              row.offering_id,
              Date.parse(row.period_start),
              Date.parse(row.period_end),
            ].join('|')
          )
          .sort();
      assert.deepEqual(
        owedKeys(classified.filter(row => row.verdict === 'owed')),
        owedKeys(owed.filter(row => Date.parse(row.period_end) > from.getTime()))
      );
      for (const row of classified) {
        const reason = COVERAGE_REASONS.find(item => item.code === row.reason);
        assert.ok(reason, row.reason);
        assert.equal(reason.verdict === 'owed', row.verdict === 'owed', `${row.reason} vs ${row.verdict}`);
        assert.notEqual(row.reason, 'buy_not_visible');
      }
    });
  }
});

describe('explainSubscriptionCoverageV1', () => {
  const baseline = () => structuredClone(table.cases.find(testCase => testCase.id === 'baseline').input);

  test('the confirmation day is owed in full and the day before is before_confirmation', () => {
    const input = baseline();
    const traces = explainSubscriptionCoverageV1({ ...input, period: '2026-11-02' });
    assert.equal(traces.length, 1);
    assert.equal(traces[0].reason, 'outside_flight');
    const confirmedLate = {
      ...input,
      buys: [{ ...input.buys[0], start_time: '2026-11-01T00:00:00Z', confirmed_at: '2026-11-04T10:00:00Z' }],
    };
    const before = explainSubscriptionCoverageV1({ ...confirmedLate, period: '2026-11-03' });
    assert.equal(before[0].verdict, 'not_owed');
    assert.equal(before[0].reason, 'before_confirmation');
    assert.match(before[0].explanation, /before mb_1 was confirmed at 2026-11-04T10:00Z\./);
    assert.equal(before[0].steps.at(-1).rule, 'confirmation');
    const confirmationDay = explainSubscriptionCoverageV1({ ...confirmedLate, period: '2026-11-04' });
    assert.equal(confirmationDay[0].reason, 'owed', 'the period in which the buy is confirmed is owed in full');
    const early = explainSubscriptionCoverageV1({ ...confirmedLate, period: '2026-11-01' });
    assert.equal(early[0].reason, 'before_coverage_start', 'the version rule precedes confirmation');
    const owed = explainSubscriptionCoverageV1({ ...input, period: '2026-11-03' });
    assert.equal(owed[0].verdict, 'owed');
    assert.equal(owed[0].reason, 'owed');
    assert.deepEqual(owed[0].subject.period, {
      start: '2026-11-03T00:00:00Z',
      end: '2026-11-04T00:00:00Z',
      timezone: 'UTC',
    });
  });

  test('a period that has not ended is period_not_ended, and the digest moves only with the inputs', () => {
    const input = baseline();
    const [late] = explainSubscriptionCoverageV1({ ...input, now: '2026-11-03T12:00:00Z', period: '2026-11-03' });
    assert.equal(late.reason, 'period_not_ended');
    assert.equal(late.verdict, 'not_owed');
    const [again] = explainSubscriptionCoverageV1({ ...input, now: '2026-11-03T13:00:00Z', period: '2026-11-03' });
    assert.equal(again.inputs_digest, late.inputs_digest, 'now is not an input while the period stays open');
    const [ended] = explainSubscriptionCoverageV1({ ...input, period: '2026-11-03' });
    assert.equal(ended.inputs_digest, late.inputs_digest, 'now is never an input');
    const moved = structuredClone(input);
    moved.buys[0].end_time = '2026-11-07T00:00:00Z';
    const [changed] = explainSubscriptionCoverageV1({ ...moved, period: '2026-11-03' });
    assert.notEqual(changed.inputs_digest, ended.inputs_digest, 'a changed buy changes the digest');
    const [seller] = explainSubscriptionCoverageV1({ ...input, period: '2026-11-03', side: 'seller' });
    assert.equal(seller.inputs_digest, ended.inputs_digest, 'both sides digest the same wire inputs');
    assert.equal(seller.side, 'seller');
  });

  test('a revoked account owes what ended before the revocation as owed:withheld', () => {
    const input = baseline();
    input.account.grants = [{ authorized_at: '2026-10-01T00:00:00Z', unauthorized_at: '2026-11-04T12:00:00Z' }];
    input.status_retention_days = 30;
    const [withheld] = explainSubscriptionCoverageV1({ ...input, period: '2026-11-03' });
    assert.equal(withheld.reason, 'owed:withheld');
    assert.equal(withheld.verdict, 'owed');
    const [after] = explainSubscriptionCoverageV1({ ...input, period: '2026-11-05' });
    assert.equal(after.reason, 'not_authorized');
  });

  test('explicit bounds must be one period of the schedule', () => {
    const input = baseline();
    assert.throws(
      () =>
        explainSubscriptionCoverageV1({
          ...input,
          period: { start: '2026-11-03T06:00:00Z', end: '2026-11-04T06:00:00Z' },
        }),
      error => error.code === 'COVERAGE_INPUT_INVALID' && /is not a period of offering/.test(error.message)
    );
  });
});
