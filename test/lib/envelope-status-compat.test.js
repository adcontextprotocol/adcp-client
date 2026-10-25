// AdCP 3.1.0-beta.2 made envelope `status` REQUIRED. 3.0.x sellers may
// omit it (it wasn't required pre-3.1). `injectLegacyEnvelopeStatus`
// synthesizes a status field on responses that declare themselves as
// 3.0.x (or carry no version field at all) so an 8.0-beta SDK validating
// against the 3.1 envelope schema can still parse 3.0 wire responses.
//
// 3.1+ payloads must not receive synthetic status fields, so the strict
// validator still rejects a 3.1 peer that omits `status` — the leniency is
// back-compat, not a permanent loosening.

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
      assert.strictEqual(result.adcp_version, version, `version ${version} preserved exactly`);
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
    for (const version of ['3.1-beta', '3.1-beta.5', '3.1.0-beta.2']) {
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

  test('3.0 create_media_buy success with legacy MediaBuyStatus → media_buy_status plus completed envelope', () => {
    const input = {
      adcp_major_version: 3,
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      confirmed_at: '2026-01-15T10:00:00Z',
      revision: 1,
      packages: [],
      context: { correlation_id: 'corr_1' },
    };
    const result = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy' });
    assert.notStrictEqual(result, input);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.media_buy_status, 'pending_creatives');
    assert.deepStrictEqual(result.packages, []);
  });

  test('3.0 update_media_buy with divergent status fields is returned unchanged', () => {
    const input = {
      media_buy_id: 'mb_1',
      status: 'pending_start',
      media_buy_status: 'active',
      packages: [],
    };
    const result = injectLegacyEnvelopeStatus(input, { toolName: 'update_media_buy' });
    assert.strictEqual(result, input);
    assert.strictEqual(result.status, 'pending_start');
    assert.strictEqual(result.media_buy_status, 'active');
  });

  test('3.1 create_media_buy deprecated lifecycle status → media_buy_status plus completed envelope for validation', () => {
    const input = {
      adcp_version: '3.1',
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      packages: [],
    };
    const result = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy' });
    assert.notStrictEqual(result, input);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.media_buy_status, 'pending_creatives');
  });

  test('does not infer media_buy_status from 3.1 envelope status completed', () => {
    const input = {
      adcp_version: '3.1',
      media_buy_id: 'mb_1',
      status: 'completed',
      packages: [],
    };

    const result = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy' });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.media_buy_status, undefined);
  });

  test('does not infer media_buy_status from 3.1 overlapping envelope terminal statuses', () => {
    for (const status of ['rejected', 'canceled']) {
      const input = {
        adcp_version: '3.1',
        media_buy_id: 'mb_1',
        status,
        packages: [],
      };

      const result = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy' });

      assert.strictEqual(result, input);
      assert.strictEqual(result.status, status);
      assert.strictEqual(result.media_buy_status, undefined);
    }
  });

  test('strict response validation accepts legacy create_media_buy lifecycle status after normalization', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('create_media_buy', {
      adcp_major_version: 3,
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      confirmed_at: '2026-01-15T10:00:00Z',
      revision: 1,
      packages: [],
      context: { correlation_id: 'corr_1' },
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.variant, 'sync');
  });

  test('strict response validation accepts legacy update_media_buy lifecycle status after normalization', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('update_media_buy', {
      adcp_major_version: 3,
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      revision: 2,
      affected_packages: [],
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.variant, 'sync');
  });

  test('strict response validation accepts 3.1 deprecated create_media_buy lifecycle status', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('create_media_buy', {
      adcp_version: '3.1',
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      confirmed_at: '2026-01-15T10:00:00Z',
      revision: 1,
      packages: [],
      context: { correlation_id: 'corr_1' },
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.variant, 'sync');
  });

  test('strict response validation rejects divergent media-buy lifecycle statuses', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('update_media_buy', {
      adcp_version: '3.1',
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      media_buy_status: 'active',
      revision: 2,
      affected_packages: [],
    });
    assert.strictEqual(result.valid, false);
  });

  test('strict response validation rejects full-semver response adcp_version', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('create_media_buy', {
      adcp_version: '3.1.0-beta.5',
      status: 'completed',
      media_buy_id: 'mb_1',
      media_buy_status: 'pending_creatives',
      packages: [],
    });
    assert.strictEqual(result.valid, false);
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

// adcp-client#3432: the response `adcp_version` echo is optional. A 3.1+
// seller may answer a create with only `{ status: 'completed', media_buy_id }`.
// `completed` / `rejected` / `canceled` are valid both as TaskStatus and as
// MediaBuyStatus, so without an echo the release the caller requested decides
// which one top-level `status` is.
describe('envelope-status compat — requested release for un-echoed media-buy responses', () => {
  const { normalizeLegacyMediaBuyStatusForReturn } = require('../../dist/lib/utils/envelope-status-compat.js');

  function unechoed(status, extra = {}) {
    return {
      status,
      media_buy_id: 'seller-buy',
      confirmed_at: '2026-10-23T00:00:00Z',
      revision: 1,
      packages: [{ package_id: 'seller-package', product_id: 'seller-product' }],
      ...extra,
    };
  }

  for (const toolName of ['create_media_buy', 'update_media_buy']) {
    for (const adcpVersion of ['3.1', '3.2', '3.2.7', '3.3.0-beta.0']) {
      for (const status of ['completed', 'rejected', 'canceled']) {
        test(`${toolName} at ${adcpVersion}: un-echoed status ${status} is task status, not a lifecycle`, () => {
          const input = unechoed(status);
          const options = { toolName, adcpVersion };

          const injected = injectLegacyEnvelopeStatus(input, options);
          assert.strictEqual(injected, input, 'must return the seller payload unchanged');
          assert.ok(!('media_buy_status' in injected));

          const returned = normalizeLegacyMediaBuyStatusForReturn(input, options);
          assert.strictEqual(returned, input);
          assert.ok(!('media_buy_status' in returned));
        });
      }
    }
  }

  test('3.0 request: un-echoed lifecycle in status still moves to media_buy_status', () => {
    for (const status of ['active', 'pending_creatives', 'completed']) {
      const input = unechoed(status);
      const options = { toolName: 'create_media_buy', adcpVersion: '3.0' };

      const injected = injectLegacyEnvelopeStatus(input, options);
      assert.strictEqual(injected.status, 'completed', status);
      assert.strictEqual(injected.media_buy_status, status, status);

      const returned = normalizeLegacyMediaBuyStatusForReturn(input, options);
      assert.strictEqual(returned.status, status, 'seller status is preserved on return');
      assert.strictEqual(returned.media_buy_status, status);
    }
  });

  test('3.1+ request: an unambiguous un-echoed lifecycle value keeps the legacy move', () => {
    // `active` is never a TaskStatus, so moving it does not invent anything.
    const input = unechoed('active');
    const injected = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy', adcpVersion: '3.2' });
    assert.strictEqual(injected.status, 'completed');
    assert.strictEqual(injected.media_buy_status, 'active');
  });

  test('an explicit seller echo wins over the requested release', () => {
    const legacy = unechoed('completed', { adcp_version: '3.0' });
    const fromLegacy = injectLegacyEnvelopeStatus(legacy, { toolName: 'create_media_buy', adcpVersion: '3.2' });
    assert.strictEqual(fromLegacy.media_buy_status, 'completed', '3.0 echo: completed is the lifecycle');

    const legacyMajor = unechoed('completed', { adcp_major_version: 3 });
    const fromLegacyMajor = injectLegacyEnvelopeStatus(legacyMajor, {
      toolName: 'create_media_buy',
      adcpVersion: '3.2',
    });
    assert.strictEqual(fromLegacyMajor.media_buy_status, 'completed', 'major-only echo is a 3.0 emitter');

    const current = unechoed('completed', { adcp_version: '3.2' });
    const fromCurrent = injectLegacyEnvelopeStatus(current, { toolName: 'create_media_buy', adcpVersion: '3.0' });
    assert.strictEqual(fromCurrent, current, '3.2 echo: completed is the task status');
    assert.ok(!('media_buy_status' in fromCurrent));
  });

  test('without a payload echo or requested release the legacy reading is unchanged', () => {
    const input = unechoed('completed');
    const injected = injectLegacyEnvelopeStatus(input, { toolName: 'create_media_buy' });
    assert.strictEqual(injected.media_buy_status, 'completed');
  });

  test('strict response validation of an un-echoed 3.2 create neither needs nor adds media_buy_status', () => {
    const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
    const result = validateResponse('create_media_buy', unechoed('completed'), '3.2');
    assert.strictEqual(result.valid, true, JSON.stringify(result.issues));
  });
});
