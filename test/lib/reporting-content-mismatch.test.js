const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectReportingContentMismatch } = require('../../dist/lib/reporting/index.js');

const PERIOD = { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' };
const SCHEMA_URI = 'https://seller.example/profiles/delivery-v1.json';
const SCHEMA_SHA = 'b'.repeat(64);

// Every fact below is frozen by the accepted configuration generation, so each
// code is decidable without either party's measurement. That boundary is the
// point of content_mismatch: it is a contract disagreement, never a dispute
// about how many impressions the seller counted.
const facts = (overrides = {}) => ({
  mediaBuyIds: ['mb-1', 'mb-2'],
  coveredPackageIds: ['pkg-1', 'pkg-2'],
  period: PERIOD,
  committedMetrics: ['impressions', 'spend'],
  metricUnits: { spend: 'USD' },
  ...overrides,
});

// What the buyer's own reader saw. Four of the six codes are row-level
// predicates that revision metadata cannot decide, so they only fire when this
// is supplied.
const rows = (overrides = {}) => ({
  representedMediaBuyIds: ['mb-1', 'mb-2'],
  observedMetricNames: ['impressions', 'spend'],
  rowsConformToPinnedSchema: true,
  observedPeriodBounds: { earliest: '2026-09-01T00:00:00Z', latest: '2026-09-01T23:59:59Z' },
  ...overrides,
});

const revision = (overrides = {}) => ({
  reporting_revision_id: 'rev-1',
  coverage: { status: 'full', covered_package_ids: ['pkg-1', 'pkg-2'] },
  control_totals: [
    { name: 'impressions', value: '1000', value_type: 'integer' },
    { name: 'spend', value: '12.50', value_type: 'decimal', unit: 'USD' },
  ],
  ...overrides,
});

describe('detectReportingContentMismatch', () => {
  test('a conforming revision is not a mismatch', () => {
    assert.equal(detectReportingContentMismatch(facts(), revision(), rows()), undefined);
  });

  test('row-level codes stay silent when the buyer supplied no row evidence', () => {
    // A false content_mismatch forces the caller's view to action_required and
    // the seller may not clear it while the statement is the current leaf. So a
    // buyer that did not read rows must not accuse; silence is the safe default.
    assert.equal(detectReportingContentMismatch(facts(), revision()), undefined);
    assert.equal(detectReportingContentMismatch(facts({ committedMetrics: ['nope'] }), revision()), undefined);
  });

  test('scope_media_buy_missing needs rows, because the metadata check is a tautology', () => {
    // reporting-revision.json defines media_buy_ids as the denominator
    // "inherited from the obligation, including buys with zero rows", so
    // comparing the two sets can never fire against a conformant seller.
    const result = detectReportingContentMismatch(facts(), revision(), rows({ representedMediaBuyIds: ['mb-1'] }));
    assert.equal(result.mismatchCode, 'scope_media_buy_missing');
    assert.match(result.detail, /mb-2/);
  });

  test('an explicit zero row represents the buy, so it is not missing', () => {
    // The zero row is exactly what lets the revision distinguish zero delivery
    // from an omitted buy, which is the spec's exculpating condition.
    assert.equal(detectReportingContentMismatch(facts(), revision(), rows()), undefined);
  });

  test('coverage_short fires from metadata alone', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({ coverage: { status: 'partial', covered_package_ids: ['pkg-1'] } }),
      rows()
    );
    assert.equal(result.mismatchCode, 'coverage_short');
    assert.match(result.detail, /pkg-2/);
  });

  test('coverage_short is unconditional — allow_partial already froze the reduced set', () => {
    // The obligation's frozen covered_package_ids IS the effective denominator
    // under allow_partial, so a revision narrower than it is still short.
    const result = detectReportingContentMismatch(
      facts(),
      revision({ coverage: { status: 'partial', covered_package_ids: [] } }),
      rows()
    );
    assert.equal(result.mismatchCode, 'coverage_short');
  });

  test('period_mismatch is decided from row time-dimension values, not the envelope', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision(),
      rows({ observedPeriodBounds: { earliest: '2026-08-31T23:00:00Z', latest: '2026-09-01T12:00:00Z' } })
    );
    assert.equal(result.mismatchCode, 'period_mismatch');
  });

  test('the period is half-open, so a row exactly at the end instant is outside', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision(),
      rows({ observedPeriodBounds: { earliest: '2026-09-01T00:00:00Z', latest: PERIOD.end } })
    );
    assert.equal(result.mismatchCode, 'period_mismatch');
  });

  test('metric_missing compares against observed row metrics, not control totals', () => {
    // control_totals are profile-defined aggregates scoped to covered packages,
    // a different and usually smaller set than the definition's metrics.
    const result = detectReportingContentMismatch(facts(), revision(), rows({ observedMetricNames: ['impressions'] }));
    assert.equal(result.mismatchCode, 'metric_missing');
    assert.match(result.detail, /spend/);
  });

  test('metric_missing wins over schema_nonconformant, per the spec precedence note', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision(),
      rows({ observedMetricNames: ['impressions'], rowsConformToPinnedSchema: false })
    );
    assert.equal(result.mismatchCode, 'metric_missing');
  });

  test('currency_mismatch fires from control-total units', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({
        control_totals: [
          { name: 'impressions', value: '1000', value_type: 'integer' },
          { name: 'spend', value: '12.50', value_type: 'decimal', unit: 'EUR' },
        ],
      }),
      rows()
    );
    assert.equal(result.mismatchCode, 'currency_mismatch');
    assert.match(result.detail, /EUR/);
    assert.match(result.detail, /USD/);
  });

  test('a control total with no declared unit does not disagree', () => {
    assert.equal(
      detectReportingContentMismatch(
        facts(),
        revision({
          control_totals: [
            { name: 'impressions', value: '1000', value_type: 'integer' },
            { name: 'spend', value: '12.50', value_type: 'decimal' },
          ],
        }),
        rows()
      ),
      undefined
    );
  });

  test('schema_nonconformant reports a row validation failure, not a pin difference', () => {
    const result = detectReportingContentMismatch(facts(), revision(), rows({ rowsConformToPinnedSchema: false }));
    assert.equal(result.mismatchCode, 'schema_nonconformant');
  });

  test('never fires on a delivered value the buyer merely disagrees with', () => {
    // Same shape, wildly different numbers. That is a measurement dispute for
    // measurement_terms / makegood_policy, not this operational channel.
    assert.equal(
      detectReportingContentMismatch(
        facts(),
        revision({
          control_totals: [
            { name: 'impressions', value: '1', value_type: 'integer' },
            { name: 'spend', value: '0.01', value_type: 'decimal', unit: 'USD' },
          ],
        }),
        rows()
      ),
      undefined
    );
  });

  test('diagnostics are bounded and cannot forge a log record', () => {
    const result = detectReportingContentMismatch(
      facts({ mediaBuyIds: [`mb\n injected ${'x'.repeat(200)}`] }),
      revision(),
      rows({ representedMediaBuyIds: [] })
    );
    assert.ok(result.detail.length < 200);
    assert.doesNotMatch(result.detail, /[\r\n\t]/);
  });
});

describe('rc.3 buyer posting deadline and chain identity', () => {
  const { evaluateReportingLedger } = require('../../dist/lib/reporting/index.js');

  const PERIOD_START = '2026-09-01T00:00:00Z';
  const PERIOD_END = '2026-09-02T00:00:00Z';

  const expectedPeriod = (overrides = {}) => ({
    deliveryConfigId: 'cfg-1',
    deliveryConfigVersion: 1,
    reportDefinitionId: 'rd-1',
    feedPurpose: 'analytics',
    reportingProfile: 'profile-1',
    mediaBuyIds: ['mb-1'],
    destinationRef: undefined,
    deliveryMethod: undefined,
    requiredFinality: 'snapshot',
    reconciliationMode: 'delivery_only',
    coverageRequirement: 'full',
    coverage: {
      status: 'full',
      media_buy_ids: ['mb-1'],
      fully_covered_media_buy_ids: ['mb-1'],
      partially_covered_media_buy_ids: [],
      unsupported_media_buy_ids: [],
      unknown_media_buy_ids: [],
      package_ids: [],
      covered_package_ids: [],
      unsupported_package_ids: [],
      unknown_package_ids: [],
    },
    reportDefinitionUri: 'https://seller.example/rd.json',
    reportDefinitionSha256: 'd'.repeat(64),
    schemaVersion: '1.0',
    schemaUri: SCHEMA_URI,
    schemaSha256: SCHEMA_SHA,
    schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    schemaRefPolicy: 'local_fragment_only',
    verificationProfile: 'manifest_checksums',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  });

  // A ledger with no obligation at all: the seller omitted the period, so the
  // buyer owes obligation_missing off its own independently derived clock.
  const emptyLedger = () => ({
    ledgerSnapshotId: 'snap-1',
    ledgerAsOf: '2026-09-05T00:00:00Z',
    accountId: 'acct-1',
    scope: { scope_closed: true, coverage_complete: true },
    obligations: [],
    revisions: [],
    materializations: [],
    receipts: [],
  });

  const planFor = (expected, now) => evaluateReportingLedger(emptyLedger(), [expected], now).consumerStatuses[0];

  test('an unpinned recovery window marks nothing overdue rather than everything', () => {
    // `automated_recovery_window_seconds` is advertised on the delivery
    // capabilities, not on the obligation, so the ledger cannot supply it. If a
    // missing pin defaulted to overdue, every reconcile would post a status for
    // every period immediately — the opposite of posting by the deadline.
    const plan = planFor(expectedPeriod(), new Date('2030-01-01T00:00:00Z'));
    assert.equal(plan.consumerStatus, 'obligation_missing');
    assert.equal(plan.deadline, undefined);
    assert.equal(plan.overdue, false, 'no pin means no auto-post, not an immediate one');
  });

  test('a pinned recovery window produces the deadline and flips overdue across it', () => {
    const expected = expectedPeriod({ automatedRecoveryWindowSeconds: 3600 });
    const before = planFor(expected, new Date('2026-09-02T00:30:00Z'));
    const after = planFor(expected, new Date('2026-09-02T01:30:00Z'));

    assert.equal(before.deadline, '2026-09-02T01:00:00.000Z', 'period end + the recovery window');
    assert.equal(before.overdue, false);
    assert.equal(after.overdue, true);
  });
});
