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
  coverageRequirement: 'full',
  period: PERIOD,
  committedMetrics: ['impressions', 'spend'],
  metricUnits: { spend: 'USD' },
  schemaUri: SCHEMA_URI,
  schemaSha256: SCHEMA_SHA,
  ...overrides,
});

const revision = (overrides = {}) => ({
  reporting_revision_id: 'rev-1',
  media_buy_ids: ['mb-1', 'mb-2'],
  coverage: { status: 'full', covered_package_ids: ['pkg-1', 'pkg-2'] },
  period: PERIOD,
  control_totals: [
    { name: 'impressions', value: '1000', value_type: 'integer' },
    { name: 'spend', value: '12.50', value_type: 'decimal', unit: 'USD' },
  ],
  schema_uri: SCHEMA_URI,
  schema_sha256: SCHEMA_SHA,
  ...overrides,
});

describe('detectReportingContentMismatch', () => {
  test('a conforming revision is not a mismatch', () => {
    assert.equal(detectReportingContentMismatch(facts(), revision()), undefined);
  });

  test('scope_media_buy_missing when a frozen media buy is absent', () => {
    const result = detectReportingContentMismatch(facts(), revision({ media_buy_ids: ['mb-1'] }));
    assert.equal(result.mismatchCode, 'scope_media_buy_missing');
    assert.match(result.detail, /mb-2/);
  });

  test('a zero-delivery media buy that is present is not missing', () => {
    // The revision can distinguish zero delivery from an omitted buy, so
    // presence in the denominator is what matters, not a nonzero total.
    const result = detectReportingContentMismatch(
      facts(),
      revision({
        control_totals: [
          { name: 'impressions', value: '0', value_type: 'integer' },
          { name: 'spend', value: '0.00', value_type: 'decimal', unit: 'USD' },
        ],
      })
    );
    assert.equal(result, undefined);
  });

  test('coverage_short when the revision covers fewer packages than frozen', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({ coverage: { status: 'partial', covered_package_ids: ['pkg-1'] } })
    );
    assert.equal(result.mismatchCode, 'coverage_short');
    assert.match(result.detail, /pkg-2/);
  });

  test('allow_partial cannot be coverage_short', () => {
    // That generation froze a smaller denominator deliberately and publishes
    // the partial label with it, so a narrower revision is the contract.
    assert.equal(
      detectReportingContentMismatch(
        facts({ coverageRequirement: 'allow_partial' }),
        revision({ coverage: { status: 'partial', covered_package_ids: ['pkg-1'] } })
      ),
      undefined
    );
  });

  test('period_mismatch when the revision period leaves the obligation period', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({ period: { start: '2026-09-01T00:00:00Z', end: '2026-09-03T00:00:00Z' } })
    );
    assert.equal(result.mismatchCode, 'period_mismatch');
  });

  test('equivalent RFC 3339 spellings of the same instant are not a period mismatch', () => {
    assert.equal(
      detectReportingContentMismatch(
        facts(),
        revision({ period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00+00:00' } })
      ),
      undefined
    );
  });

  test('metric_missing when a promised metric is absent', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({ control_totals: [{ name: 'impressions', value: '1000', value_type: 'integer' }] })
    );
    assert.equal(result.mismatchCode, 'metric_missing');
    assert.match(result.detail, /spend/);
  });

  test('metric_missing wins over schema_nonconformant, per the spec precedence note', () => {
    // "a metric that is simply absent uses metric_missing even when the pinned
    // schema declares it required."
    const result = detectReportingContentMismatch(
      facts(),
      revision({
        control_totals: [{ name: 'impressions', value: '1000', value_type: 'integer' }],
        schema_sha256: 'c'.repeat(64),
      })
    );
    assert.equal(result.mismatchCode, 'metric_missing');
  });

  test('currency_mismatch when a unit disagrees with the pinned definition', () => {
    const result = detectReportingContentMismatch(
      facts(),
      revision({
        control_totals: [
          { name: 'impressions', value: '1000', value_type: 'integer' },
          { name: 'spend', value: '12.50', value_type: 'decimal', unit: 'EUR' },
        ],
      })
    );
    assert.equal(result.mismatchCode, 'currency_mismatch');
    assert.match(result.detail, /EUR/);
    assert.match(result.detail, /USD/);
  });

  test('schema_nonconformant when rows are pinned to a different profile schema', () => {
    assert.equal(
      detectReportingContentMismatch(facts(), revision({ schema_sha256: 'c'.repeat(64) })).mismatchCode,
      'schema_nonconformant'
    );
    assert.equal(
      detectReportingContentMismatch(facts(), revision({ schema_uri: 'https://seller.example/other.json' }))
        .mismatchCode,
      'schema_nonconformant'
    );
  });

  test('digest comparison is case-insensitive', () => {
    assert.equal(
      detectReportingContentMismatch(facts(), revision({ schema_sha256: SCHEMA_SHA.toUpperCase() })),
      undefined
    );
  });

  test('omitted buyer-side pins disable their check rather than firing falsely', () => {
    // A buyer that did not record the metric list must never claim a promised
    // metric is absent — silence on the pin means silence on the code.
    assert.equal(
      detectReportingContentMismatch(
        facts({ committedMetrics: undefined, metricUnits: undefined }),
        revision({ control_totals: [] })
      ),
      undefined
    );
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
        })
      ),
      undefined
    );
  });

  test('diagnostics are bounded and cannot forge a log record', () => {
    const result = detectReportingContentMismatch(
      facts({ mediaBuyIds: [`mb\n injected ${'x'.repeat(200)}`] }),
      revision({ media_buy_ids: [] })
    );
    assert.ok(result.detail.length < 160);
    assert.doesNotMatch(result.detail, /[\r\n\t]/);
  });
});
