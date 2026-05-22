// AdCP 3.1.0-beta.2 made envelope `status` REQUIRED. 3.0.x sellers may
// omit it (it wasn't required pre-3.1). `injectLegacyEnvelopeStatus`
// synthesizes a status field on responses that declare themselves as
// 3.0.x (or carry no version field at all) so an 8.0-beta SDK validating
// against the 3.1 envelope schema can still parse 3.0 wire responses.
//
// 3.1+ payloads must be returned UNCHANGED so the strict validator still
// rejects a 3.1 peer that omits `status` — the leniency is back-compat,
// not a permanent loosening.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { injectLegacyEnvelopeStatus } = require('../../dist/lib/index.js');

describe('injectLegacyEnvelopeStatus — 3.0.x back-compat shim', () => {
  test('3.0 envelope without status → status injected as completed', () => {
    const input = { adcp_version: '3.0', products: [{ id: 'p1' }] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.adcp_version, '3.0');
    assert.deepStrictEqual(result.products, [{ id: 'p1' }]);
  });

  test('3.0.x full-semver envelope without status → status injected as completed', () => {
    for (const version of ['3.0.0', '3.0.5', '3.0.12']) {
      const result = injectLegacyEnvelopeStatus({ adcp_version: version, products: [] });
      assert.strictEqual(result.status, 'completed', `version ${version}`);
    }
  });

  test('3.0 envelope with non-empty errors[] → status injected as failed', () => {
    const input = {
      adcp_version: '3.0',
      errors: [{ code: 'INVALID_REQUEST', message: 'bad targeting' }],
    };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'failed');
    assert.deepStrictEqual(result.errors, [{ code: 'INVALID_REQUEST', message: 'bad targeting' }]);
  });

  test('3.0 envelope with empty errors[] → status injected as completed', () => {
    // Empty errors[] is treated as success (no actual errors present).
    const result = injectLegacyEnvelopeStatus({ adcp_version: '3.0', errors: [] });
    assert.strictEqual(result.status, 'completed');
  });

  test('3.1 envelope without status → returned UNCHANGED (validator must reject)', () => {
    const input = { adcp_version: '3.1', products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, undefined);
    assert.strictEqual(result, input, 'must return same reference when no injection applies');
  });

  test('3.1-beta envelope without status → returned UNCHANGED', () => {
    for (const version of ['3.1-beta', '3.1-beta.3', '3.1.0-beta.2']) {
      const result = injectLegacyEnvelopeStatus({ adcp_version: version });
      assert.strictEqual(result.status, undefined, `version ${version}`);
    }
  });

  test('3.1 envelope WITH status → returned unchanged', () => {
    const input = { adcp_version: '3.1', status: 'completed', products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result, input);
    assert.strictEqual(result.status, 'completed');
  });

  test('3.0 envelope with explicit status: submitted → returned unchanged (no overwrite)', () => {
    const input = { adcp_version: '3.0', status: 'submitted', task_id: 't1' };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result, input);
    assert.strictEqual(result.status, 'submitted');
  });

  test('3.0 envelope with explicit status: failed → returned unchanged (no overwrite even on errors)', () => {
    const input = {
      adcp_version: '3.0',
      status: 'failed',
      errors: [{ code: 'X', message: 'y' }],
    };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'failed');
  });

  test('no version fields at all → treated as legacy, status injected', () => {
    const input = { products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'completed');
  });

  test('no adcp_version but adcp_major_version: 3 → treated as legacy, status injected', () => {
    const input = { adcp_major_version: 3, products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'completed');
  });

  test('no adcp_version but adcp_major_version: 4 → NOT legacy, returned unchanged', () => {
    const input = { adcp_major_version: 4, products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, undefined);
    assert.strictEqual(result, input);
  });

  test('adcp_version: "4.0" → NOT legacy, returned unchanged', () => {
    const input = { adcp_version: '4.0' };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, undefined);
  });

  test('adcp_version: "2.5" → NOT legacy 3.0, returned unchanged', () => {
    // The shim is specifically for 3.0.x. v2.x sellers are handled separately
    // by stripEnvelopeNulls in the schema-validator and shouldn't be conflated.
    const input = { adcp_version: '2.5' };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, undefined);
  });

  test('adcp_version: "3" (major-only) → treated as 3.0.x, status injected', () => {
    const input = { adcp_version: '3', products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.strictEqual(result.status, 'completed');
  });

  test('null / non-object input → returned unchanged', () => {
    assert.strictEqual(injectLegacyEnvelopeStatus(null), null);
    assert.strictEqual(injectLegacyEnvelopeStatus(undefined), undefined);
  });

  test('does not mutate input object (returns new reference when injecting)', () => {
    const input = { adcp_version: '3.0', products: [] };
    const result = injectLegacyEnvelopeStatus(input);
    assert.notStrictEqual(result, input);
    assert.strictEqual(input.status, undefined, 'input must not be mutated');
  });
});
