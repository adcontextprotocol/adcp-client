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

describe('executeStoryboardTask media-buy compatibility retries', () => {
  test('reuses one generated idempotency key across rate-limit retries', async () => {
    const calls = [];
    let attempt = 0;
    const coordinator = {
      requestProposals: async request => {
        calls.push(request);
        if (attempt++ === 0) throw new Error('rate limit exceeded');
        return { success: true, status: 'completed', data: { proposals: [] } };
      },
    };
    const result = await executeStoryboardTask(
      { negotiateMediaBuyLifecycle: async () => coordinator },
      'request_proposals',
      { brief: 'stable retry' },
      { mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer' } }
    );

    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.equal(calls[1].idempotency_key, calls[0].idempotency_key);
  });

  test('compatibility mode preserves an explicit idempotency-key omission probe', async () => {
    const calls = [];
    const coordinator = {
      requestProposals: async (request, _inputHandler, options) => {
        calls.push({ request, options });
        return { success: false, status: 'failed', error: 'idempotency_key is required' };
      },
    };

    await executeStoryboardTask(
      { negotiateMediaBuyLifecycle: async () => coordinator },
      'request_proposals',
      { brief: 'unkeyed compliance probe' },
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer' },
        skipIdempotencyAutoInject: true,
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.idempotency_key, undefined);
    assert.equal(calls[0].options.skipIdempotencyAutoInject, true);
  });

  test('bounds compatibility coordinators cached per client', async () => {
    let negotiations = 0;
    let disposals = 0;
    const client = {
      negotiateMediaBuyLifecycle: async () => {
        negotiations += 1;
        const negotiation = negotiations;
        return {
          listProducts: async () => ({ success: true, data: { products: [] } }),
          dispose: () => {
            disposals += 1;
            if (negotiation === 1) throw new Error('simulated dispose failure');
          },
        };
      },
    };
    for (let index = 0; index < 40; index += 1) {
      await executeStoryboardTask(
        client,
        'list_products',
        {},
        {
          mediaBuyLifecycleCompatibility: { principalScope: `storyboard-buyer-${index}` },
        }
      );
    }
    await executeStoryboardTask(
      client,
      'list_products',
      {},
      {
        mediaBuyLifecycleCompatibility: { principalScope: 'storyboard-buyer-0' },
      }
    );

    assert.equal(negotiations, 41, 'the oldest coordinator should be evicted after the bounded cache fills');
    assert.equal(disposals, 9, 'every evicted coordinator should release its task listeners and timers');
  });
});

describe('executeStoryboardTask creative wire selection', () => {
  test('uses the canonical method for an explicit canonical 3.1 request without runner projection policy', async () => {
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
          return { data: { products: [], wire: 'canonical' } };
        },
      },
      'get_products',
      params
    );

    assert.deepEqual(calls, [{ method: 'canonical', request: params }]);
    assert.equal(result.data.wire, 'canonical');
  });

  test('keeps an unhinted 3.1 product request ambiguous for dual-format responses', async () => {
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

    assert.deepEqual(calls, [{ method: 'legacy', request: {} }]);
    assert.equal(result.data.wire, 'legacy');
  });

  test('uses a raw product projection without changing the authored wire', async () => {
    const calls = [];
    const params = { context: { correlation_id: 'dual-format-grading' } };
    const result = await executeStoryboardTask(
      {
        getAdcpVersion: () => '3.1.10',
        getProducts: async request => {
          calls.push({ method: 'canonical', request });
          return { data: { products: [], wire: 'canonical' } };
        },
        getProductsLegacy: async request => {
          calls.push({ method: 'raw', request });
          return { data: { products: [], wire: 'dual' } };
        },
      },
      'get_products',
      params,
      { responseProjection: 'raw' }
    );

    assert.deepEqual(calls, [{ method: 'raw', request: params }]);
    assert.equal(result.data.wire, 'dual');
  });
});

describe('executeStoryboardTask creative asset directives', () => {
  test('rejects unexpanded directives before client validation or dispatch', async () => {
    let callCount = 0;
    const result = await executeStoryboardTask(
      {
        syncCreatives: async () => {
          callCount += 1;
          return { data: { creatives: [] } };
        },
      },
      'sync_creatives',
      {
        creatives: [
          {
            assets: {
              $build_assets_from_format: { agent_url: 'https://creative.example', id: 'display_300x250' },
            },
          },
        ],
      }
    );

    assert.equal(callCount, 0);
    assert.deepEqual(result, {
      success: false,
      error:
        "Request contains unexpanded storyboard directive '$build_assets_from_format' at " +
        '$.creatives[0].assets.$build_assets_from_format. ' +
        'Call expandCreativeAssetDirectives(params, context, testKit) before passing params to executeStoryboardTask.',
    });
  });
});
