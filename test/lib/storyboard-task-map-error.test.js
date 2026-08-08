const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { executeStoryboardTask } = require('../../dist/lib/testing');

describe('executeStoryboardTask error normalization', () => {
  test('treats terminal failed AdCP payloads as failed task results', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          data: {
            status: 'failed',
            errors: [{ code: 'INVALID_REQUEST', message: 'bad package' }],
          },
        }),
      },
      'custom_tool',
      {}
    );

    assert.equal(result.success, false);
    assert.equal(result.adcp_error.code, 'INVALID_REQUEST');
    assert.equal(result.error, 'bad package');
    assert.deepEqual(result.data.errors, [{ code: 'INVALID_REQUEST', message: 'bad package' }]);
  });

  test('preserves top-level adcp_error envelopes for storyboard validators', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'missing buy', recovery: 'correctable' },
        }),
      },
      'custom_tool',
      {}
    );

    assert.equal(result.success, false);
    assert.equal(result.adcp_error.code, 'MEDIA_BUY_NOT_FOUND');
    assert.deepEqual(result.data, {
      adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'missing buy', recovery: 'correctable' },
    });
  });

  test('does not promote submitted advisory errors to terminal adcp_error', async () => {
    const result = await executeStoryboardTask(
      {
        executeTask: async () => ({
          success: true,
          data: {
            status: 'submitted',
            task_id: 'task_1',
            errors: [{ code: 'GOVERNANCE_OBSERVATION', message: 'queued with advisory' }],
          },
        }),
      },
      'create_media_buy',
      {}
    );

    assert.equal(result.success, true);
    assert.equal(result.adcp_error, undefined);
    assert.deepEqual(result.data.errors, [{ code: 'GOVERNANCE_OBSERVATION', message: 'queued with advisory' }]);
  });
});

describe('executeStoryboardTask creative wire selection', () => {
  test('uses the canonical method for an explicit canonical 3.1 request', async () => {
    const calls = [];
    const params = { ext: { adcp: { creative_wire: 'canonical' } } };
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'legacy', request });
          return { data: { products: [], wire: 'legacy' } };
        },
      },
      'get_products',
      params
    );

    assert.deepEqual(calls, [{ method: 'canonical', request: params }]);
    assert.equal(result.data.wire, 'canonical');
  });

  test('retains the legacy default for an unhinted 3.1 request', async () => {
    const calls = [];
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'legacy', request });
          return { data: { products: [], wire: 'legacy' } };
        },
      },
      'get_products',
      {}
    );

    assert.deepEqual(calls, [
      { method: 'legacy', request: { ext: { adcp: { creative_wire: 'legacy' } } } },
    ]);
    assert.equal(result.data.wire, 'legacy');
  });
});
