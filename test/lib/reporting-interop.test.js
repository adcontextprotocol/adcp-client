const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { run } = require('../../scripts/reporting-interop/typescript.cjs');

test('shared reporting vectors independently inspect the manifest and construct revision and adjustment receipts', async () => {
  const result = await run({
    packageRoot: path.resolve(__dirname, '../..'),
    fixtureRoot: path.resolve(__dirname, '../fixtures'),
  });
  assert.equal(result.revision_receipts[0].status, 'accepted');
  assert.deepEqual(result.revision_receipts[1].rejection_codes, ['ROW_COUNT_MISMATCH']);
  assert.equal(result.adjustments.length, 7);
  assert.equal(result.adjustments.find(item => item.id === 'tampered_digest').receipt.status, 'rejected');
  assert.notEqual(
    result.adjustments.find(item => item.id === 'unicode_composed').receipt.observed_adjustment_sha256,
    result.adjustments.find(item => item.id === 'unicode_decomposed').receipt.observed_adjustment_sha256
  );
  const fixture = require('../fixtures/reporting-interop/evidence-v1.json');
  const peer = structuredClone(result);
  peer.adjustments = fixture.adjustments.map(vector => ({
    id: vector.id,
    canonical_utf8_hex: vector.canonical_utf8_hex,
    receipt: vector.expected_python_receipt ?? vector.expected_receipt,
  }));
  peer.adjustments[0].receipt.observed_adjustment_sha256 = '0'.repeat(64);
  await assert.rejects(
    run({
      packageRoot: path.resolve(__dirname, '../..'),
      fixtureRoot: path.resolve(__dirname, '../fixtures'),
      peer,
    }),
    { name: 'AssertionError', code: 'ERR_ASSERTION' }
  );
});
