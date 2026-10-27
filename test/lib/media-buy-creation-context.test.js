const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createMediaBuyStore,
  InMemoryStateStore,
  PostgresStateStore,
  getAdcpStateMigration,
  scopedStore,
  DEFAULT_MEDIA_BUY_STORE_COLLECTION,
} = require('../../dist/lib/server/index.js');

for (const backend of ['memory', 'postgres']) {
  test(
    `creation context persists across media buy readback and targeting updates (${backend})`,
    { skip: backend === 'postgres' && !process.env.DATABASE_URL ? 'DATABASE_URL not set' : false },
    async t => {
      let state = new InMemoryStateStore();
      if (backend === 'postgres') {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const tableName = `context_${randomUUID().replaceAll('-', '')}`;
        t.after(async () => {
          try {
            await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
          } finally {
            await pool.end();
          }
        });
        await pool.query(getAdcpStateMigration(tableName));
        state = new PostgresStateStore(pool, { tableName });
      }
      const store = createMediaBuyStore({ store: state });
      const request = {
        context: { campaign: 'original', optional: null, nested: { values: [null, false, 0, ''] } },
        packages: [
          { product_id: 'product-a', context: { line: 'a', optional: null }, targeting_overlay: { language: ['en'] } },
          { product_id: 'product-b', context: {} },
        ],
      };
      const original = structuredClone(request);
      const result = {
        media_buy_id: 'buy-1',
        packages: [
          { package_id: 'package-a', product_id: 'product-a' },
          { package_id: 'package-b', product_id: 'product-b' },
        ],
      };
      await store.persistFromCreate('account-a', request, result);
      // Mutating the caller's objects must not rewrite the creation snapshot.
      request.context.nested.values.push('changed');
      request.packages[0].context.optional = 'changed';
      const read = (account = 'account-a') =>
        createMediaBuyStore({ store: state }).backfill(account, {
          context: { operation: 'read', optional: null },
          media_buys: [{ media_buy_id: 'buy-1', packages: [{ package_id: 'package-a' }, { package_id: 'package-b' }] }],
        });
      let response = await read();
      assert.deepEqual(response.context, { operation: 'read', optional: null });
      assert.deepEqual(response.media_buys[0].context, original.context);
      assert.deepEqual(response.media_buys[0].packages[0].context, original.packages[0].context);
      assert.deepEqual(response.media_buys[0].packages[1].context, {});
      response.media_buys[0].context.nested.values.push('read mutation');
      response.media_buys[0].packages[0].context.optional = 'read mutation';

      await store.mergeFromUpdate('account-a', 'buy-1', {
        context: { operation: 'update' },
        packages: [
          { package_id: 'package-a', context: { operation: 'update' }, targeting_overlay: null },
          { package_id: 'package-b', targeting_overlay: { geo_countries: ['US'] } },
        ],
        new_packages: [{ package_id: 'package-c', targeting_overlay: { language: ['fr'] } }],
      });
      response = await read();
      assert.deepEqual(response.media_buys[0].context, original.context);
      assert.deepEqual(response.media_buys[0].packages[0].context, original.packages[0].context);
      assert.equal(Object.hasOwn(response.media_buys[0].packages[0], 'targeting_overlay'), false);
      assert.deepEqual(response.media_buys[0].packages[1].context, {});
      assert.deepEqual(response.media_buys[0].packages[1].targeting_overlay, { geo_countries: ['US'] });
      await store.persistFromCreate(
        'account-a',
        {
          context: { campaign: 'repeated create' },
          packages: [{ product_id: 'product-a', context: { line: 'repeated create' } }],
        },
        result
      );
      const repeated = (await read()).media_buys[0];
      assert.deepEqual(repeated.context, original.context);
      assert.deepEqual(repeated.packages[0].context, original.packages[0].context);
      assert.deepEqual(repeated.packages[1].context, {});
      const otherAccount = (await read('account-b')).media_buys[0];
      assert.equal(Object.hasOwn(otherAccount, 'context'), false);
      assert.equal(Object.hasOwn(otherAccount.packages[0], 'context'), false);

      const sellerEcho = {
        media_buys: [
          { media_buy_id: 'buy-1', context: {}, packages: [{ package_id: 'package-a', context: { seller: null } }] },
        ],
      };
      await store.backfill('account-a', sellerEcho);
      assert.deepEqual(sellerEcho.media_buys[0].context, {});
      assert.deepEqual(sellerEcho.media_buys[0].packages[0].context, { seller: null });

      await store.persistFromCreate('account-a', { context: {} }, { media_buy_id: 'buy-only' });
      const buyOnly = { media_buys: [{ media_buy_id: 'buy-only' }] };
      await store.backfill('account-a', buyOnly);
      assert.deepEqual(buyOnly.media_buys[0].context, {});

      // Targeting-only records written by older SDKs remain readable.
      await scopedStore(state, 'account-a').put(DEFAULT_MEDIA_BUY_STORE_COLLECTION, 'legacy', {
        media_buy_id: 'legacy',
        packages: [{ package_id: 'legacy-package', targeting_overlay: { language: ['de'] } }],
      });
      const legacy = { media_buys: [{ media_buy_id: 'legacy', packages: [{ package_id: 'legacy-package' }] }] };
      await store.backfill('account-a', legacy);
      assert.deepEqual(legacy.media_buys[0].packages[0].targeting_overlay, { language: ['de'] });
      assert.equal(Object.hasOwn(legacy.media_buys[0], 'context'), false);
      assert.equal(Object.hasOwn(legacy.media_buys[0].packages[0], 'context'), false);
    }
  );
}

const mappingCases = [
  {
    name: 'reordered product identities',
    request: [
      { product_id: 'a', context: { line: 'a' } },
      { product_id: 'b', context: { line: 'b' } },
    ],
    response: [
      { package_id: 'b', product_id: 'b' },
      { package_id: 'a', product_id: 'a' },
    ],
    expected: [{ line: 'b' }, { line: 'a' }],
  },
  {
    name: 'legacy buyer references',
    request: [
      { buyer_ref: 'a', context: { line: 'a' } },
      { buyer_ref: 'b', context: { line: 'b' } },
    ],
    response: [
      { package_id: 'b', buyer_ref: 'b' },
      { package_id: 'a', buyer_ref: 'a' },
    ],
    expected: [{ line: 'b' }, { line: 'a' }],
  },
  {
    name: 'positional results without echoed identities',
    request: [
      { product_id: 'a', context: {} },
      { product_id: 'b', context: { line: null } },
    ],
    response: [{ package_id: 'a' }, { package_id: 'b' }],
    expected: [{}, { line: null }],
  },
  {
    name: 'partial results use a unique product identity',
    request: [
      { product_id: 'a', context: { line: 'a' } },
      { product_id: 'b', context: { line: 'b' } },
    ],
    response: [{ package_id: 'b', product_id: 'b' }],
    expected: [{ line: 'b' }],
  },
  {
    name: 'partial results without identities use only the seller echo',
    request: [{ context: { wrong: 'a' } }, { context: { wrong: 'b' } }],
    response: [{ package_id: 'unknown', context: { seller: null } }],
    expected: [{ seller: null }],
  },
  {
    name: 'contradictory identities do not borrow positional context',
    request: [{ product_id: 'a', context: { wrong: 'a' } }],
    response: [{ package_id: 'unknown', product_id: 'b' }],
    expected: [undefined],
  },
  {
    name: 'ambiguous partial product results do not borrow context',
    request: [
      { product_id: 'a', context: { wrong: 1 } },
      { product_id: 'a', context: { wrong: 2 } },
    ],
    response: [{ package_id: 'unknown', product_id: 'a' }],
    expected: [undefined],
  },
];
for (const scenario of mappingCases) {
  test(`creation context package mapping: ${scenario.name}`, async () => {
    const store = createMediaBuyStore({ store: new InMemoryStateStore() });
    await store.persistFromCreate(
      'account-a',
      { packages: scenario.request },
      { media_buy_id: 'buy', packages: scenario.response }
    );
    const response = {
      media_buys: [{ media_buy_id: 'buy', packages: scenario.response.map(p => ({ package_id: p.package_id })) }],
    };
    await store.backfill('account-a', response);
    assert.deepEqual(
      response.media_buys[0].packages.map(p => p.context),
      scenario.expected
    );
  });
}
