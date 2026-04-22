/**
 * Tests for the `TestControllerBridge` helper factories.
 *
 * Covers both the default-store bridge (process-wide Map, closed over at
 * construction time) and the session-scoped variant (callback-driven, one
 * session per request). The session variant was added for sellers whose
 * seed store is per-tenant / per-brand and loaded from Postgres / Redis
 * on each request (adcp-client#824).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  bridgeFromTestControllerStore,
  bridgeFromSessionStore,
} = require('../../dist/lib/server/index.js');

describe('bridgeFromTestControllerStore', () => {
  it('returns seeded products merged onto defaults', async () => {
    const store = new Map();
    store.set('p1', { name: 'Seeded product' });

    const bridge = bridgeFromTestControllerStore(store, {
      delivery_type: 'guaranteed',
      channels: ['display'],
    });
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 1);
    assert.equal(products[0].product_id, 'p1');
    assert.equal(products[0].name, 'Seeded product');
    assert.equal(products[0].delivery_type, 'guaranteed');
  });

  it('returns [] when the store is empty', async () => {
    const bridge = bridgeFromTestControllerStore(new Map());
    const products = await bridge.getSeededProducts({ input: {} });
    assert.deepEqual(products, []);
  });
});

describe('bridgeFromSessionStore', () => {
  it('loads the session per request and emits seeded products from the selector', async () => {
    const sessionA = { seeds: new Map([['pA', { name: 'Tenant A product' }]]) };
    const sessionB = { seeds: new Map([['pB', { name: 'Tenant B product' }]]) };

    const loadCalls = [];
    const bridge = bridgeFromSessionStore(
      input => {
        loadCalls.push(input);
        // Route by a synthetic tenant key on the request — mirrors the
        // real-world `session_id` / `brand.domain` / `account_id` pattern.
        return input.tenant === 'A' ? sessionA : sessionB;
      },
      session => session.seeds,
      { delivery_type: 'guaranteed' }
    );

    const aProducts = await bridge.getSeededProducts({ input: { tenant: 'A' } });
    const bProducts = await bridge.getSeededProducts({ input: { tenant: 'B' } });

    assert.equal(aProducts.length, 1);
    assert.equal(aProducts[0].product_id, 'pA');
    assert.equal(aProducts[0].delivery_type, 'guaranteed');

    assert.equal(bProducts.length, 1);
    assert.equal(bProducts[0].product_id, 'pB');

    // The loader runs once per request — the bridge doesn't memoise.
    assert.equal(loadCalls.length, 2);
    assert.deepEqual(loadCalls[0], { tenant: 'A' });
    assert.deepEqual(loadCalls[1], { tenant: 'B' });
  });

  it('accepts an async loadSession', async () => {
    const bridge = bridgeFromSessionStore(
      async () => ({ seeds: new Map([['p1', { name: 'Async product' }]]) }),
      session => session.seeds
    );
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products[0].name, 'Async product');
  });

  it('returns [] when the selector returns null / undefined', async () => {
    const bridge = bridgeFromSessionStore(() => ({}), () => undefined);
    const products = await bridge.getSeededProducts({ input: {} });
    assert.deepEqual(products, []);
  });

  it('accepts any iterable of [productId, fixture] pairs, not just Map', async () => {
    // Sellers whose seed state is an array of [id, fixture] tuples (or a
    // custom iterable) should be able to pass that directly without
    // rebuilding a Map.
    const bridge = bridgeFromSessionStore(
      () => ({}),
      () => [
        ['p1', { name: 'From array' }],
        ['p2', { name: 'Also from array' }],
      ]
    );
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 2);
    assert.deepEqual(
      products.map(p => p.product_id).sort(),
      ['p1', 'p2']
    );
  });

  it('tolerates non-object fixture values (treats them as empty)', async () => {
    // A storyboard that seeded `null` or a primitive should still produce
    // a valid product (with just `product_id` + defaults) rather than
    // throwing mid-request.
    const bridge = bridgeFromSessionStore(
      () => ({ seeds: new Map([['p1', null], ['p2', 'not-an-object']]) }),
      session => session.seeds,
      { delivery_type: 'non_guaranteed' }
    );
    const products = await bridge.getSeededProducts({ input: {} });
    assert.equal(products.length, 2);
    assert.equal(products[0].product_id, 'p1');
    assert.equal(products[0].delivery_type, 'non_guaranteed');
  });
});
