const assert = require('node:assert/strict');
const test = require('node:test');

const { canonicalReportingInstant } = require('../../dist/lib/reporting/ledger/instant.js');

test('canonicalReportingInstant trims adversarial fractional zeros in linear time', () => {
  const significantFraction = `${'0'.repeat(100_000)}1`;
  assert.equal(
    canonicalReportingInstant(`2026-09-14T00:00:00.${significantFraction}Z`),
    `2026-09-14T00:00:00.${significantFraction}Z`
  );
  assert.equal(canonicalReportingInstant(`2026-09-14T00:00:00.1${'0'.repeat(100_000)}Z`), '2026-09-14T00:00:00.1Z');
});
