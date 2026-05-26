const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ensureGetProductsCacheScope, validateGetProductsCacheScope } = require('../../dist/lib');

describe('get_products cache_scope helpers', () => {
  it('injects account scope by default when products are present', () => {
    const input = { products: [{ product_id: 'p1' }] };
    const output = ensureGetProductsCacheScope(input);

    assert.strictEqual(output.cache_scope, 'account');
    assert.strictEqual(input.cache_scope, undefined);
  });

  it('preserves an existing public scope', () => {
    const input = { products: [], cache_scope: 'public' };
    const output = ensureGetProductsCacheScope(input);

    assert.strictEqual(output, input);
    assert.strictEqual(output.cache_scope, 'public');
  });

  it('injects a caller-selected scope for unchanged responses and reports injection', () => {
    const events = [];
    const output = ensureGetProductsCacheScope(
      { unchanged: true, wholesale_feed_version: 'wf_1' },
      {
        defaultCacheScope: 'public',
        onInject: event => events.push(event),
      }
    );

    assert.strictEqual(output.cache_scope, 'public');
    assert.deepStrictEqual(events, [{ cache_scope: 'public', reason: 'unchanged', product_count: undefined }]);
  });

  it('validates missing and invalid scopes', () => {
    assert.deepStrictEqual(validateGetProductsCacheScope({ products: [] }), {
      ok: false,
      reason: 'missing_cache_scope',
    });
    assert.deepStrictEqual(validateGetProductsCacheScope({ products: [], cache_scope: 'tenant' }), {
      ok: false,
      reason: 'invalid_cache_scope',
    });
    assert.deepStrictEqual(validateGetProductsCacheScope({ products: [], cache_scope: 'account' }), { ok: true });
  });

  it('throws on invalid cache_scope values', () => {
    assert.throws(() => ensureGetProductsCacheScope({ products: [], cache_scope: 'tenant' }), /cache_scope/);
  });
});
