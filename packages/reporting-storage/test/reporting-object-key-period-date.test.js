/**
 * How row-storage object keys render `{period_date}`: the AdCP `YYYY-MM-DD` calendar date of a period start in
 * the period's `source_timezone`. The date rule itself is pinned in the SDK (`reportingPeriodDate`).
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { isReportingRowStoreError } = require('@adcp/sdk/reporting/ledger');
const { renderReportingRowObjectKeyV1, REPORTING_ROW_DEFAULT_KEY_TEMPLATE } = require('@adcp/reporting-storage');

describe('object keys render {period_date}', () => {
  const key = overrides =>
    renderReportingRowObjectKeyV1({
      template: REPORTING_ROW_DEFAULT_KEY_TEMPLATE,
      prefix: 'adcp-rows',
      namespaceKey: 'n'.repeat(64),
      accountId: 'acct_1',
      rowSetId: 'rrev_1',
      finality: 'snapshot',
      contentSha256: 'c'.repeat(64),
      chunkIndex: 0,
      compression: 'gzip',
      ...overrides,
    });
  const isInvalid = error => isReportingRowStoreError(error) && error.code === 'INVALID_INPUT';

  test('is the AdCP YYYY-MM-DD local date as one path segment', () => {
    const segments = key({ periodStart: '2026-10-01T15:00:00Z', sourceTimezone: 'Asia/Tokyo' }).split('/');
    assert.equal(segments[3], '2026-10-02');
    assert.equal(segments.length, 8, 'prefix, namespace, account, date, finality, revision, content, chunk');
    assert.ok(
      key({ periodStart: '2026-10-02T06:59:59Z', sourceTimezone: 'America/Los_Angeles' }).includes('/2026-10-01/')
    );
    assert.ok(key({ periodStart: '2026-10-02T06:59:59Z', sourceTimezone: 'UTC' }).includes('/2026-10-02/'));
  });

  test('renders undated only when there is no period start at all', () => {
    assert.ok(key({}).includes('/undated/'));
    assert.ok(key({ sourceTimezone: 'America/Los_Angeles' }).includes('/undated/'));
  });

  test('refuses a period start without a usable source timezone', () => {
    assert.throws(() => key({ periodStart: '2026-10-02T07:00:00Z' }), isInvalid);
    assert.throws(() => key({ periodStart: '2026-10-02T07:00:00Z', sourceTimezone: '' }), isInvalid);
    assert.throws(() => key({ periodStart: '2026-10-02T07:00:00Z', sourceTimezone: 'Mars/Base' }), isInvalid);
    assert.throws(() => key({ periodStart: '2026-10-02T07:00:00Z', sourceTimezone: '+05:30' }), isInvalid);
    assert.throws(() => key({ periodStart: 'not-a-date', sourceTimezone: 'UTC' }), isInvalid);
  });

  test('bounds the rendered key at AdCP object_ref length', () => {
    const wide =
      '{prefix}/{namespace_key}/{account_key}/' + Array(8).fill('{content_sha256}').join('/') + '/{chunk_index}';
    assert.throws(
      () =>
        key({ template: wide, prefix: 'p'.repeat(450), periodStart: '2026-10-02T07:00:00Z', sourceTimezone: 'UTC' }),
      isInvalid
    );
    const narrow = key({ prefix: 'p'.repeat(300), periodStart: '2026-10-02T07:00:00Z', sourceTimezone: 'UTC' });
    assert.ok(narrow.length <= 1024);
  });
});
